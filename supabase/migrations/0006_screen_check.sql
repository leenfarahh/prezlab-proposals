-- =============================================================================
-- Prezlab Proposals Hub - screen check
-- Run once, after 0005_members_and_editors.sql. Safe to re-run.
--
-- After each upload the hub checks the proposal at phone, tablet, laptop and
-- desktop width (in the uploader's browser) and saves the result here. The
-- result names the files it checked (fit_check.prefix = storage_prefix), so a
-- new upload makes it stale until the next check.
--
-- Written only by people on the whitelist, through the existing update policy.
-- Not logged in the history: it describes the files, it isn't a change by a person.
-- =============================================================================

alter table public.proposals
  add column if not exists fit_check      jsonb,
  add column if not exists fit_checked_at timestamptz;
