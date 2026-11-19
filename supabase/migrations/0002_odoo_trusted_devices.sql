-- ===========================================================================
-- Prezlab Proposals Hub - Odoo trusted-device keys for 2FA
-- Run after 0001_init.sql. Same table and rules as Image Studio (separate project).
--
-- Odoo blocks password-based RPC authentication for any user with 2FA enabled,
-- and its RPC surface has no second-factor parameter. The supported workaround
-- is a per-user API key; the approach used elsewhere in Prezlab is to drive
-- Odoo's browser TOTP page once, keep the trusted-device cookie it returns, and
-- reuse that so team members are not prompted on every sign-in.
--
-- WHAT IS STORED HERE IS A 2FA BYPASS KEY. Treat it with the same care as a
-- password:
--
--   * The value is sealed with AES-256-GCM by the application before it is
--     written, using ODOO_TD_ENCRYPTION_KEY. Postgres never sees the plaintext,
--     so a database dump on its own is useless.
--   * RLS is enabled with no policies, so the anon key can read nothing. Only
--     the service role touches this table.
--   * It is keyed on the Odoo login rather than a user id, because a
--     person's first sign-in completes 2FA before their Supabase user exists.
--   * Rows carry an expiry so a stale key is retried rather than trusted
--     forever, and last_used_at makes an unused key visible.
-- ===========================================================================

create table if not exists public.odoo_trusted_devices (
  id            uuid primary key default gen_random_uuid(),
  -- Lower-cased Odoo login. Not a foreign key: this row can predate the Supabase user.
  odoo_login    text not null unique,
  -- AES-256-GCM sealed td_id cookie. Never a plaintext value.
  sealed_td_id  text not null,
  -- Lets an encryption-key rotation invalidate old rows rather than fail to
  -- open them at an awkward moment.
  key_version   integer not null default 1,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  -- Set when Odoo refused the key, so a repeatedly failing device is visible
  -- instead of silently re-prompting forever.
  failed_at     timestamptz,
  failure_count integer not null default 0
);

create index if not exists odoo_trusted_devices_login_idx
  on public.odoo_trusted_devices (odoo_login);
create index if not exists odoo_trusted_devices_expiry_idx
  on public.odoo_trusted_devices (expires_at);

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled, with NO policies.
--
-- With RLS on and nothing granted, every
-- request carrying the anon key is denied; the service role bypasses RLS so the
-- server routes still work. A 2FA bypass key must never be browser-reachable.
-- ---------------------------------------------------------------------------

alter table public.odoo_trusted_devices enable row level security;

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------

create or replace function public.purge_expired_odoo_trusted_devices()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  removed integer;
begin
  delete from public.odoo_trusted_devices
   where expires_at < now()
      or failure_count >= 3;
  get diagnostics removed = row_count;
  return removed;
end;
$fn$;

comment on table public.odoo_trusted_devices is
  'Sealed Odoo trusted-device cookies, so team members with 2FA are not prompted for a code on every sign-in. Contents are a 2FA bypass key: encrypted by the application, never browser-reachable, and expiring.';
