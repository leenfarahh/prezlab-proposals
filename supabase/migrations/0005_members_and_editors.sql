-- =============================================================================
-- Prezlab Proposals Hub - members and editors
-- Run once, after 0004_takedown.sql. Safe to re-run.
--
--   Members (members.txt on the server): everyone at Prezlab. They can sign
--   in, browse the hub, open any proposal and see its stats and history.
--
--   Editors (HUB_WHITELIST on the server): members who can also upload, edit,
--   share, retire links and delete.
--
-- The server mirrors both lists into team_whitelist (one row per member,
-- is_editor for the whitelist). Reads stay open to every member through
-- is_team_member(); every write now requires is_team_editor().
-- =============================================================================

alter table public.team_whitelist
  add column if not exists is_editor boolean not null default false;

-- Everyone already in the table came from the old whitelist, so they're editors
-- until the first sync rewrites the flags from the server's lists.
update public.team_whitelist set is_editor = true
 where is_editor = false
   and not exists (select 1 from public.team_whitelist w where w.is_editor);

create or replace function public.is_team_editor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_whitelist w
     where w.email = public.current_email() and w.is_editor
  );
$$;

grant execute on function public.is_team_editor() to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Sync, called by the server (service role) only
-- -----------------------------------------------------------------------------
create or replace function public.sync_team_members(p_members text[], p_editors text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  editors  text[] := array(
    select distinct lower(btrim(e)) from unnest(coalesce(p_editors, '{}')) e
     where position('@' in btrim(e)) > 1
  );
  everyone text[] := array(
    select distinct lower(btrim(e)) from unnest(coalesce(p_members, '{}') || coalesce(p_editors, '{}')) e
     where position('@' in btrim(e)) > 1
  );
begin
  if coalesce(array_length(editors, 1), 0) = 0 then
    raise exception 'Refusing to sync: the whitelist (HUB_WHITELIST) is empty.';
  end if;

  insert into public.team_whitelist as w (email, is_editor, synced_at)
  select e, e = any (editors), now() from unnest(everyone) e
  on conflict (email) do update
    set is_editor = excluded.is_editor,
        synced_at = excluded.synced_at;

  delete from public.team_whitelist where email <> all (everyone);
end;
$$;

revoke execute on function public.sync_team_members(text[], text[]) from public, anon, authenticated;
grant execute on function public.sync_team_members(text[], text[]) to service_role;

-- -----------------------------------------------------------------------------
-- Writes: editors only. Reads (from 0001, 0003, 0004) stay with members.
-- -----------------------------------------------------------------------------
drop policy if exists "team inserts proposals" on public.proposals;
create policy "team inserts proposals"
  on public.proposals for insert
  with check (public.is_team_editor());

drop policy if exists "team updates proposals" on public.proposals;
create policy "team updates proposals"
  on public.proposals for update
  using (public.is_team_editor())
  with check (public.is_team_editor());

drop policy if exists "team deletes proposals" on public.proposals;
create policy "team deletes proposals"
  on public.proposals for delete
  using (public.is_team_editor());

drop policy if exists "team uploads proposal files" on storage.objects;
create policy "team uploads proposal files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'proposals' and public.is_team_editor());

-- -----------------------------------------------------------------------------
-- Retire link: editors only (same as 0004 otherwise)
-- -----------------------------------------------------------------------------
create or replace function public.take_down_proposal(p_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  actor      text := nullif(public.current_email(), '');
  actor_name text := (select w.name from public.team_whitelist w where w.email = actor);
  reason     text := nullif(left(btrim(coalesce(p_reason, '')), 300), '');
  p          record;
begin
  if not public.is_team_editor() then
    raise exception 'Only people on the hub''s whitelist can retire a link.' using errcode = '42501';
  end if;

  select id, title, link_name into p from public.proposals where id = p_id for update;
  if not found then
    raise exception 'Proposal not found.';
  end if;

  if p.link_name is not null then
    insert into public.retired_link_names
      (link_name, proposal_id, proposal_title, retired_by_email, retired_by_name, reason)
    values (p.link_name, p.id, p.title, actor, actor_name, reason)
    on conflict (link_name) do nothing;
  end if;

  -- Lets stamp_proposal() accept the takedown fields from this function only.
  perform set_config('app.takedown', 'on', true);

  update public.proposals
     set visibility          = 'private',
         link_name           = null,
         sealed_password     = null,
         taken_down_at       = now(),
         taken_down_by_email = actor,
         taken_down_by_name  = actor_name,
         takedown_reason     = reason,
         takedown_link_name  = p.link_name
   where id = p_id;
end;
$$;

revoke execute on function public.take_down_proposal(uuid, text) from public, anon;
grant execute on function public.take_down_proposal(uuid, text) to authenticated;
