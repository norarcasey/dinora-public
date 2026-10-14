-- Account groups (ACCT-04): which of cash, credit cards, loans or investments each account
-- is, as Nora says. The first thing in Dinora she edits.
--
-- Her own table, not a column on `accounts`: those rows are the bank's, read-only to her and
-- rewritten by every pull (20260924134228), and SimpleFIN sends no account type to fill
-- one with. Until she sets a group the app guesses one from the account's name and holdings
-- (packages/core/src/groups.ts) and shows it as a guess; nothing about a guess is stored.
--
-- Written from supabase/patterns/owned_table.sql, with two differences:
--
--   * No DELETE, for her or anyone. A group is changed by setting another, and a row she
--     wants gone is a `deleted_at`, which is an update. The app offers neither yet.
--   * One row per account (`account_groups_one_per_account`), so the app writes with an
--     upsert on (user_id, account_id) and a second choice replaces the first.
--
-- The account is referenced through (user_id, account_id), so the policy's check on
-- user_id also means the account is hers: a row cannot point at somebody else's.

create table public.account_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null,
  foreign key (user_id, account_id) references public.accounts (user_id, id),

  kind text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint account_groups_user_id_id_key unique (user_id, id),
  constraint account_groups_one_per_account unique (user_id, account_id),
  constraint account_groups_kind_known check (kind in ('cash', 'card', 'loan', 'investment'))
);

create index account_groups_user_live_idx
  on public.account_groups (user_id, created_at)
  where deleted_at is null;

-- The device's changed-since read. One row per account, about 18: the index costs nothing
-- and the synced-table rule asks for it (apps/web/src/queries/synced.ts).
create index account_groups_user_updated_idx
  on public.account_groups (user_id, updated_at);

create trigger account_groups_set_updated_at
  before update on public.account_groups
  for each row execute function public.set_updated_at();

create trigger account_groups_freeze_user_id
  before update on public.account_groups
  for each row execute function public.freeze_user_id();

alter table public.account_groups enable row level security;
alter table public.account_groups force row level security;

create policy account_groups_select_own on public.account_groups
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy account_groups_insert_own on public.account_groups
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy account_groups_update_own on public.account_groups
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Revoked first: the local image leaves `authenticated` all seven default privileges,
-- TRUNCATE included, which RLS does not govern (20260924134228). What she holds is granted
-- here and nothing else. The nightly job never touches her choices, so service_role gets
-- no grant at all.
revoke all on table public.account_groups from authenticated;
revoke all on table public.account_groups from service_role;
grant select, insert, update on table public.account_groups to authenticated;
