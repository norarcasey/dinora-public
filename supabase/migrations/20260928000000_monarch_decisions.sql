-- Which Monarch account is which (ACCT-18): the mapping `pnpm monarch:import` imports with,
-- kept here instead of only in `monarch-accounts.json` beside the export.
--
-- By 26 Sep 2026 that file, kept beside the export, was too important to leave there:
-- it was the only record of every link and every `skip` decided with her (ACCT-05,
-- BANK-07, Northwind, Gemini, Meridian), fixed by hand beside a pile of `.before-*.json` copies —
-- and within two days it had moved folders and lost three of its six
-- copies, which is the file's fragility measured. Not the repo: it holds account names, last
-- four digits and aggregator ids, and a commit would put them on GitHub.
--
--   * One row per decision, never one per account. A changed link is a new row and the old
--     one stays, so what the copies were for is the table's own history. What a Monarch
--     account goes to now is its latest live row by `decided_at`.
--   * `decided_at` is when it was decided, which is not always when the row was written: the
--     first import loads the old copies, each dated by the file's own time.
--   * A decision is never rewritten. `authenticated` may update `deleted_at` and nothing else,
--     which withdraws one and lets the one before it stand again.
--   * Written as her, `authenticated` with her id in the claims, as the import writes her
--     assets (20260925180000). The nightly job reads none of it, so service_role gets no grant.
--
-- Rows hold names and ids, never an amount (invariant 4 holds for the import's output too).

create table public.monarch_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- Monarch's account name, as its CSVs spell it.
  monarch_name text not null,
  goes text not null,
  -- The aggregator's id of the bank account, and how it read when linked.
  link text,
  link_is text,
  asset_kind text,
  why text not null default '',
  decided_at timestamptz not null default now(),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint monarch_decisions_user_id_id_key unique (user_id, id),
  constraint monarch_decisions_goes_known check (goes in ('link', 'history', 'skip', 'asset')),
  constraint monarch_decisions_link_whole check (
    (link is not null) = (goes = 'link') and (link_is is null or link is not null)
  ),
  -- Not crypto (ACCT-21): a holding is a coin and a quantity, which Monarch's balances are not.
  constraint monarch_decisions_asset_whole check (
    (asset_kind is not null) = (goes = 'asset')
    and (asset_kind is null or asset_kind in ('home', 'vehicle', 'valuables'))
  ),
  constraint monarch_decisions_name_length check (char_length(monarch_name) between 1 and 500),
  constraint monarch_decisions_link_length check (char_length(coalesce(link, '')) <= 500),
  constraint monarch_decisions_link_is_length check (char_length(coalesce(link_is, '')) <= 500),
  constraint monarch_decisions_why_length check (char_length(why) <= 2000)
);

-- Two live decisions for one account at one instant would leave "the latest" to chance.
create unique index monarch_decisions_one_at_a_time
  on public.monarch_decisions (user_id, monarch_name, decided_at)
  where deleted_at is null;

create trigger monarch_decisions_set_updated_at
  before update on public.monarch_decisions
  for each row execute function public.set_updated_at();

create trigger monarch_decisions_freeze_user_id
  before update on public.monarch_decisions
  for each row execute function public.freeze_user_id();

alter table public.monarch_decisions enable row level security;
alter table public.monarch_decisions force row level security;

create policy monarch_decisions_select_own on public.monarch_decisions
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy monarch_decisions_insert_own on public.monarch_decisions
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy monarch_decisions_update_own on public.monarch_decisions
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy monarch_decisions_delete_own on public.monarch_decisions
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- The platform's default privileges give authenticated ALL on a new table, which would let a
-- decision be rewritten in place: taken back before granting the columns it may change.
revoke all on table public.monarch_decisions from authenticated;
revoke all on table public.monarch_decisions from service_role;
grant select, insert, delete on table public.monarch_decisions to authenticated;
grant update (deleted_at) on table public.monarch_decisions to authenticated;
