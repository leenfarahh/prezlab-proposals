-- =============================================================================
-- Prezlab Proposals Hub - take down a leaked link
-- Run once, after 0003_hub_uploads_access.sql. Safe to re-run.
--
-- "Take down link" (on a proposal's page in the hub) does, in one step:
--   * makes the proposal team only, so its link stops working at once
--   * wipes the password, which signs out every client who opened it
--   * retires the link name for good, so the leaked address can never point
--     at anything again (sharing again needs a new link name and password)
--   * records who did it, when and why, in the proposal and its history
--
-- Deleting a proposal while it's shared retires its link name the same way.
--
-- To bring a retired link name back (rarely wise after a leak), run:
--   delete from public.retired_link_names where link_name = 'the-name';
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Retired link names
-- -----------------------------------------------------------------------------
create table if not exists public.retired_link_names (
  link_name         text primary key,
  proposal_id       uuid references public.proposals (id) on delete set null,
  proposal_title    text,
  retired_at        timestamptz not null default now(),
  retired_by_email  text,
  retired_by_name   text,
  reason            text
);

alter table public.retired_link_names enable row level security;

drop policy if exists "team reads retired link names" on public.retired_link_names;
create policy "team reads retired link names"
  on public.retired_link_names for select
  using (public.is_team_member());
-- No write policies: only take_down_proposal() and the delete trigger write here.

-- -----------------------------------------------------------------------------
-- Takedown record on the proposal
-- -----------------------------------------------------------------------------
alter table public.proposals
  add column if not exists taken_down_at        timestamptz,
  add column if not exists taken_down_by_email  text,
  add column if not exists taken_down_by_name   text,
  add column if not exists takedown_reason      text,
  add column if not exists takedown_link_name   text;

alter table public.proposal_activity drop constraint if exists proposal_activity_action_check;
alter table public.proposal_activity add constraint proposal_activity_action_check
  check (action in (
    'uploaded', 'replaced_files', 'updated_details', 'changed_access',
    'changed_link', 'changed_password', 'deleted', 'taken_down'));

-- -----------------------------------------------------------------------------
-- The takedown itself: one call, one transaction
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
  if not public.is_team_member() then
    raise exception 'Only whitelisted team members can take down a proposal.' using errcode = '42501';
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

-- -----------------------------------------------------------------------------
-- stamp_proposal(): same as 0003, plus retired-name and takedown rules
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
  -- A retired link name can't be given to any proposal.
  if new.link_name is not null
     and (tg_op = 'INSERT' or new.link_name is distinct from old.link_name)
     and exists (select 1 from public.retired_link_names r where r.link_name = new.link_name) then
    raise exception 'That link was taken down and can''t be used again. Pick a different link name.';
  end if;

  if tg_op = 'INSERT' then
    if actor is not null then
      new.created_by_email  := actor;
      new.created_by_name   := actor_name;
      new.uploaded_by_email := actor;
      new.uploaded_by_name  := actor_name;
    end if;
    new.uploaded_at := coalesce(new.uploaded_at, now());
    new.taken_down_at := null;
    new.taken_down_by_email := null;
    new.taken_down_by_name := null;
    new.takedown_reason := null;
    new.takedown_link_name := null;
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

  -- A new (or wiped) password logs out every client who opened the old one.
  if new.sealed_password is distinct from old.sealed_password then
    new.password_version := old.password_version + 1;
  else
    new.password_version := old.password_version;
  end if;

  -- Takedown fields are written only by take_down_proposal(). Sharing the
  -- proposal again afterwards clears them (the history keeps the record).
  if coalesce(current_setting('app.takedown', true), '') <> 'on' then
    if new.visibility <> 'private' and old.taken_down_at is not null then
      new.taken_down_at := null;
      new.taken_down_by_email := null;
      new.taken_down_by_name := null;
      new.takedown_reason := null;
      new.takedown_link_name := null;
    else
      new.taken_down_at := old.taken_down_at;
      new.taken_down_by_email := old.taken_down_by_email;
      new.taken_down_by_name := old.taken_down_by_name;
      new.takedown_reason := old.takedown_reason;
      new.takedown_link_name := old.takedown_link_name;
    end if;
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- log_proposal_activity(): same as 0003, plus one "taken_down" entry for a
-- takedown, and retiring the link name of a proposal deleted while shared
-- -----------------------------------------------------------------------------
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
    if old.link_name is not null and old.visibility <> 'private' then
      insert into public.retired_link_names
        (link_name, proposal_id, proposal_title, retired_by_email, retired_by_name, reason)
      values (old.link_name, null, old.title, actor, actor_name, 'Deleted while shared')
      on conflict (link_name) do nothing;
    end if;
    insert into public.proposal_activity (proposal_id, proposal_title, actor_email, actor_name, action, details)
    values (null, old.title, actor, actor_name, 'deleted',
            jsonb_build_object('client', old.client, 'link', old.link_name));
    return old;
  end if;

  -- A takedown is one event, not four separate changes.
  if old.taken_down_at is null and new.taken_down_at is not null then
    insert into public.proposal_activity (proposal_id, proposal_title, actor_email, actor_name, action, details)
    values (new.id, new.title, actor, actor_name, 'taken_down',
            jsonb_build_object('link', old.link_name, 'was', old.visibility, 'reason', new.takedown_reason));
    return new;
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
