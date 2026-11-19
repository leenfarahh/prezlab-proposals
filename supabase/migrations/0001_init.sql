-- =============================================================================
-- Prezlab Proposals Hub: initial schema
-- Run once in Supabase: Dashboard > SQL Editor > paste > Run
-- (or `supabase db push` if you use the Supabase CLI)
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- Team membership: anyone who signs in with an email on an allowed domain.
-- Add/remove domains here without touching code.
-- -----------------------------------------------------------------------------
create table if not exists public.allowed_email_domains (
  domain text primary key
);

insert into public.allowed_email_domains (domain)
values ('prezlab.com')
on conflict do nothing;

alter table public.allowed_email_domains enable row level security;
-- No policies: only the service role can read/write this table.

create or replace function public.is_team_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.allowed_email_domains d
    where lower(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 2)) = lower(d.domain)
  );
$$;

grant execute on function public.is_team_member() to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Proposals
--   visibility:
--     private -> team only (share link requires team login)
--     link    -> anyone holding the share link
--     public  -> listed publicly + viewable by anyone (for the future public site)
-- -----------------------------------------------------------------------------
create table if not exists public.proposals (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  title           text not null,
  client          text,
  description     text,
  tags            text[] not null default '{}',
  status          text not null default 'draft'
                    check (status in ('draft', 'sent', 'won', 'lost', 'archived')),
  visibility      text not null default 'private'
                    check (visibility in ('private', 'link', 'public')),
  share_token     text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  storage_prefix  text not null,                 -- folder inside the "proposals" bucket
  entry_file      text not null default 'index.html',
  content_hash    text,                          -- lets the importer skip unchanged proposals
  file_count      integer not null default 0,
  source_path     text,                          -- path in the repo it was imported from
  proposal_date   date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  imported_at     timestamptz
);

create index if not exists proposals_visibility_idx on public.proposals (visibility);
create index if not exists proposals_tags_idx on public.proposals using gin (tags);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists proposals_touch_updated_at on public.proposals;
create trigger proposals_touch_updated_at
  before update on public.proposals
  for each row execute function public.touch_updated_at();

alter table public.proposals enable row level security;

drop policy if exists "team reads all proposals" on public.proposals;
create policy "team reads all proposals"
  on public.proposals for select
  using (public.is_team_member());

drop policy if exists "anyone reads public proposals" on public.proposals;
create policy "anyone reads public proposals"
  on public.proposals for select
  using (visibility = 'public');

drop policy if exists "team updates proposals" on public.proposals;
create policy "team updates proposals"
  on public.proposals for update
  using (public.is_team_member())
  with check (public.is_team_member());

drop policy if exists "team deletes proposals" on public.proposals;
create policy "team deletes proposals"
  on public.proposals for delete
  using (public.is_team_member());

-- Inserts come from the import script (service role), which bypasses RLS.

-- Rotate a share link (invalidates the old URL immediately).
create or replace function public.rotate_share_token(p_id uuid)
returns text
language plpgsql
security invoker
as $$
declare
  new_token text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  update public.proposals set share_token = new_token where id = p_id;
  if not found then
    raise exception 'Proposal not found or not permitted';
  end if;
  return new_token;
end;
$$;

-- -----------------------------------------------------------------------------
-- Analytics events (foundation for click-through, scroll and heatmap tracking)
-- Written only by the server (/api/track, service role). Team can read.
-- -----------------------------------------------------------------------------
create table if not exists public.proposal_events (
  id           bigint generated always as identity primary key,
  proposal_id  uuid not null references public.proposals (id) on delete cascade,
  session_id   text not null,
  visitor_id   text not null,
  type         text not null check (type in ('view', 'click', 'scroll', 'heartbeat', 'leave')),
  is_internal  boolean not null default false,   -- true when a logged-in team member viewed it
  data         jsonb not null default '{}'::jsonb,
  page_path    text,
  referrer     text,
  user_agent   text,
  country      text,
  created_at   timestamptz not null default now()
);

create index if not exists proposal_events_proposal_time_idx
  on public.proposal_events (proposal_id, created_at desc);
create index if not exists proposal_events_proposal_type_idx
  on public.proposal_events (proposal_id, type);

alter table public.proposal_events enable row level security;

drop policy if exists "team reads events" on public.proposal_events;
create policy "team reads events"
  on public.proposal_events for select
  using (public.is_team_member());

-- Per-proposal headline numbers for the gallery (external views only).
create or replace view public.proposal_view_counts
with (security_invoker = true) as
select
  proposal_id,
  count(*) filter (where type = 'view')                     as views,
  count(distinct visitor_id) filter (where type = 'view')   as unique_visitors,
  max(created_at) filter (where type = 'view')              as last_viewed_at
from public.proposal_events
where not is_internal
group by proposal_id;

-- Detailed stats for one proposal (external views only).
create or replace function public.proposal_stats(p_id uuid)
returns table (
  views               bigint,
  unique_visitors     bigint,
  clicks              bigint,
  avg_seconds         numeric,
  avg_scroll_depth    numeric,
  last_viewed_at      timestamptz
)
language sql
stable
security invoker
as $$
  with ev as (
    select * from public.proposal_events
    where proposal_id = p_id and not is_internal
  ),
  per_session as (
    select
      session_id,
      max(coalesce((data ->> 'activeSeconds')::numeric, 0)) as secs,
      max(coalesce((data ->> 'maxDepth')::numeric, 0))      as depth
    from ev
    where type in ('heartbeat', 'leave', 'scroll')
    group by session_id
  )
  select
    (select count(*) from ev where type = 'view'),
    (select count(distinct visitor_id) from ev where type = 'view'),
    (select count(*) from ev where type = 'click'),
    (select round(avg(secs), 0) from per_session),
    (select round(avg(depth), 0) from per_session),
    (select max(created_at) from ev where type = 'view');
$$;

-- -----------------------------------------------------------------------------
-- Storage: private bucket that holds every proposal's HTML + assets.
-- Files are served through the Next.js app (never directly), so the app can
-- enforce access rules and inject the tracking script.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('proposals', 'proposals', false)
on conflict (id) do nothing;

drop policy if exists "team reads proposal files" on storage.objects;
create policy "team reads proposal files"
  on storage.objects for select
  using (bucket_id = 'proposals' and public.is_team_member());
