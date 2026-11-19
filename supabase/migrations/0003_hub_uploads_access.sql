-- =============================================================================
-- Prezlab Proposals Hub - whitelist, hub uploads, upload history, client links
-- Run once, after 0002_odoo_trusted_devices.sql. Safe to re-run.
--
--   1. Whitelist: who may sign in is set in the server environment
--      (HUB_WHITELIST). The server mirrors that list into team_whitelist so the
--      database's own access rules (RLS) match it. Nobody edits this table by
--      hand or from the browser.
--   2. Hub uploads: whitelisted people can create proposals and upload files.
--   3. Tracking: the database stamps who created and who last uploaded each
--      proposal, and writes an activity log on every change. Both come from
--      the signed-in user's token, so they can't be faked from the browser.
--   4. Client links: each shared proposal has a readable link name
--      (/prezlab/<link-name>) and a password, replacing the random share links.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Whitelist mirror
-- -----------------------------------------------------------------------------
create table if not exists public.team_whitelist (
  email            text primary key check (email = lower(btrim(email)) and position('@' in email) > 1),
  name             text,                 -- from Odoo, refreshed at each sign-in
  last_sign_in_at  timestamptz,
  synced_at        timestamptz not null default now()
);

alter table public.team_whitelist enable row level security;
-- No policies: only the server (service role) reads or writes it.

create or replace function public.current_email()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

-- Same name and signature as before, so every existing policy keeps working.
create or replace function public.is_team_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.team_whitelist w where w.email = public.current_email());
$$;

grant execute on function public.is_team_member() to anon, authenticated;

-- Domain-based access is replaced by the whitelist.
drop table if exists public.allowed_email_domains;

-- -----------------------------------------------------------------------------
-- 2. Proposals: client link, password, uploader
-- -----------------------------------------------------------------------------
alter table public.proposals
  add column if not exists link_name          text,
  add column if not exists sealed_password    text,     -- AES-256-GCM, sealed by the app (HUB_SECRET)
  add column if not exists password_version   integer not null default 0,
  add column if not exists created_by_email   text,
  add column if not exists created_by_name    text,
  add column if not exists uploaded_by_email  text,
  add column if not exists uploaded_by_name   text,
  add column if not exists uploaded_at        timestamptz;

create unique index if not exists proposals_link_name_key on public.proposals (link_name);

alter table public.proposals drop constraint if exists proposals_link_name_format;
alter table public.proposals add constraint proposals_link_name_format
  check (link_name is null or link_name ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$');

-- Old random-token links no longer exist, so anything shared without a link
-- name goes back to team only until someone names it.
update public.proposals
   set visibility = 'private'
 where visibility <> 'private' and link_name is null;

alter table public.proposals drop constraint if exists proposals_shared_needs_link_name;
alter table public.proposals add constraint proposals_shared_needs_link_name
  check (visibility = 'private' or link_name is not null);

alter table public.proposals drop constraint if exists proposals_link_needs_password;
alter table public.proposals add constraint proposals_link_needs_password
  check (visibility <> 'link' or sealed_password is not null);

-- Whitelisted people can create proposals (deleting and editing were already
-- open to them through is_team_member()).
drop policy if exists "team inserts proposals" on public.proposals;
create policy "team inserts proposals"
  on public.proposals for insert
  with check (public.is_team_member());

-- -----------------------------------------------------------------------------
-- 3a. Who uploaded: stamped by the database, not trusted from the client
-- -----------------------------------------------------------------------------
create or replace function public.stamp_proposal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor      text := nullif(public.current_email(), '');
  actor_name text := (select w.name from public.team_whitelist w where w.email = actor);
begin
  if tg_op = 'INSERT' then
    if actor is not null then
      new.created_by_email  := actor;
      new.created_by_name   := actor_name;
      new.uploaded_by_email := actor;
      new.uploaded_by_name  := actor_name;
    end if;
    new.uploaded_at := coalesce(new.uploaded_at, now());
    return new;
  end if;

  -- UPDATE: the creator never changes.
  new.created_by_email := old.created_by_email;
  new.created_by_name  := old.created_by_name;

  if new.storage_prefix is distinct from old.storage_prefix then
    new.uploaded_at := now();
    if actor is not null then
      new.uploaded_by_email := actor;
      new.uploaded_by_name  := actor_name;
    end if;
  else
    new.uploaded_by_email := old.uploaded_by_email;
    new.uploaded_by_name  := old.uploaded_by_name;
    new.uploaded_at       := old.uploaded_at;
  end if;

  -- A new password logs out every client who opened the old one.
  if new.sealed_password is distinct from old.sealed_password then
    new.password_version := old.password_version + 1;
  else
    new.password_version := old.password_version;
  end if;

  return new;
end;
$$;

drop trigger if exists proposals_stamp on public.proposals;
create trigger proposals_stamp
  before insert or update on public.proposals
  for each row execute function public.stamp_proposal();

-- -----------------------------------------------------------------------------
-- 3b. Activity log: written only by this trigger
-- -----------------------------------------------------------------------------
create table if not exists public.proposal_activity (
  id              bigint generated always as identity primary key,
  proposal_id     uuid references public.proposals (id) on delete set null,
  proposal_title  text not null,      -- kept so history survives a deletion
  actor_email     text,               -- null = done by the server itself
  actor_name      text,
  action          text not null check (action in (
                    'uploaded', 'replaced_files', 'updated_details',
                    'changed_access', 'changed_link', 'changed_password', 'deleted')),
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists proposal_activity_proposal_idx
  on public.proposal_activity (proposal_id, created_at desc);
create index if not exists proposal_activity_time_idx
  on public.proposal_activity (created_at desc);

alter table public.proposal_activity enable row level security;

drop policy if exists "team reads activity" on public.proposal_activity;
create policy "team reads activity"
  on public.proposal_activity for select
  using (public.is_team_member());
-- No insert/update/delete policies: the log is append-only and trigger-written.

create or replace function public.log_proposal_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor      text := nullif(public.current_email(), '');
  actor_name text := (select w.name from public.team_whitelist w where w.email = actor);
  changed    text[] := '{}';
begin
  if tg_op = 'INSERT' then
    insert into public.proposal_activity (proposal_id, proposal_title, actor_email, actor_name, action, details)
    values (new.id, new.title, actor, actor_name, 'uploaded', jsonb_build_object('files', new.file_count));
    return new;
  end if;

  if tg_op = 'DELETE' then
    insert into public.proposal_activity (proposal_id, proposal_title, actor_email, actor_name, action, details)
    values (null, old.title, actor, actor_name, 'deleted', jsonb_build_object('client', old.client));
    return old;
  end if;

  if new.storage_prefix is distinct from old.storage_prefix then
    insert into public.proposal_activity (proposal_id, proposal_title, actor_email, actor_name, action, details)
    values (new.id, new.title, actor, actor_name, 'replaced_files', jsonb_build_object('files', new.file_count));
  end if;

  if new.visibility is distinct from old.visibility then
    insert into public.proposal_activity (proposal_id, proposal_title, actor_email, actor_name, action, details)
    values (new.id, new.title, actor, actor_name, 'changed_access',
            jsonb_build_object('from', old.visibility, 'to', new.visibility));
  end if;

  if new.link_name is distinct from old.link_name then
    insert into public.proposal_activity (proposal_id, proposal_title, actor_email, actor_name, action, details)
    values (new.id, new.title, actor, actor_name, 'changed_link',
            jsonb_build_object('from', old.link_name, 'to', new.link_name));
  end if;

  if new.sealed_password is distinct from old.sealed_password then
    insert into public.proposal_activity (proposal_id, proposal_title, actor_email, actor_name, action, details)
    values (new.id, new.title, actor, actor_name, 'changed_password', '{}'::jsonb);
  end if;

  if new.title is distinct from old.title then changed := changed || 'title'; end if;
  if new.client is distinct from old.client then changed := changed || 'client'; end if;
  if new.description is distinct from old.description then changed := changed || 'description'; end if;
  if new.tags is distinct from old.tags then changed := changed || 'tags'; end if;
  if new.status is distinct from old.status then changed := changed || 'status'; end if;
  if new.proposal_date is distinct from old.proposal_date then changed := changed || 'date'; end if;

  if array_length(changed, 1) > 0 then
    insert into public.proposal_activity (proposal_id, proposal_title, actor_email, actor_name, action, details)
    values (new.id, new.title, actor, actor_name, 'updated_details',
            jsonb_build_object('fields', to_jsonb(changed), 'status', new.status));
  end if;

  return new;
end;
$$;

drop trigger if exists proposals_activity on public.proposals;
create trigger proposals_activity
  after insert or update or delete on public.proposals
  for each row execute function public.log_proposal_activity();

-- -----------------------------------------------------------------------------
-- 4. Storage: whitelisted people upload straight from the browser
--    (keeps large proposals off the web server and its request-size limit)
-- -----------------------------------------------------------------------------
drop policy if exists "team uploads proposal files" on storage.objects;
create policy "team uploads proposal files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'proposals' and public.is_team_member());
