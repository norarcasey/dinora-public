-- Goals (GOAL-01): a savings target or a loan paid off, and how far along it is.
--
-- A goal points at accounts, never at a copy of their balances: how far along it is, and at
-- what pace, is computed on the device from `accounts` and `balance_snapshots`, the rows the
-- sync keeps (packages/core/src/goals.ts). So nothing here stores an amount but her target.
--
-- Decided with Nora, 25 Sep:
--
--   * **Save**: the chosen accounts' balance, summed, reaches `target_minor`. The whole
--     balance counts, not only what was added since the goal began, so it always agrees with
--     what the bank shows.
--   * **Pay off**: the chosen loans reach zero, measured from what they owed on `starts_on`.
--     Its target is zero by definition, so it stores none. `starts_on` can reach back into
--     Monarch's history (ACCT-05); the page defaults it to the oldest day Dinora has.
--   * `target_on` is optional. With one, the page says whether the pace the history shows
--     gets there by then.
--   * The principal and interest in a payment are not here: no bank sends the split, and a
--     loan's balance history already moves by the principal alone.
--
-- Two tables, not an array of account ids: an array cannot carry a foreign key, and the
-- composite key to `accounts (user_id, id)` is what stops a goal counting another user's
-- account (as account_groups, 20260924220000).
--
-- Written from supabase/patterns/owned_table.sql, with these differences:
--
--   * No DELETE, for her or anyone: a goal, or an account taken out of one, is removed with
--     `deleted_at`, and a goal given up stays as history.
--   * A goal cannot change kind or currency, since its target is in that currency and its
--     accounts were chosen for that kind. UPDATE is granted on the rest.
--   * A link cannot be rewritten to point elsewhere: UPDATE on `goal_accounts` is
--     `deleted_at` alone, so changing a goal's accounts removes one link and adds another.
--   * service_role gets no grant. Nothing the nightly job does reads a goal.

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  name text not null,
  kind text not null,
  currency text not null default 'USD',
  target_minor bigint,
  starts_on date not null,
  target_on date,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint goals_user_id_id_key unique (user_id, id),
  constraint goals_name_length check (char_length(name) between 1 and 200),
  constraint goals_kind_known check (kind in ('save', 'payoff')),
  constraint goals_currency_code check (currency ~ '^[A-Z]{3}$'),
  -- A saving has a figure to reach; a payoff's is zero, and storing one would be a second
  -- place for it to disagree. Tested `is not null`, since a CHECK whose expression is null
  -- passes (found in ACCT-10).
  constraint goals_target_shape check (
    (kind = 'save' and target_minor is not null and target_minor > 0)
    or (kind = 'payoff' and target_minor is null)
  ),
  constraint goals_target_after_start check (target_on is null or target_on > starts_on)
);

create index goals_user_live_idx
  on public.goals (user_id, created_at)
  where deleted_at is null;

-- The device's changed-since read (apps/web/src/queries/synced.ts).
create index goals_user_updated_idx
  on public.goals (user_id, updated_at);

create trigger goals_set_updated_at
  before update on public.goals
  for each row execute function public.set_updated_at();

create trigger goals_freeze_user_id
  before update on public.goals
  for each row execute function public.freeze_user_id();

alter table public.goals enable row level security;
alter table public.goals force row level security;

create policy goals_select_own on public.goals
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy goals_insert_own on public.goals
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy goals_update_own on public.goals
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Revoked first, as for assets: the local image leaves `authenticated` all seven default
-- privileges, TRUNCATE included.
revoke all on table public.goals from authenticated;
revoke all on table public.goals from service_role;
grant select, insert on table public.goals to authenticated;
grant update (name, target_minor, starts_on, target_on, deleted_at)
  on table public.goals to authenticated;

create table public.goal_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null,
  foreign key (user_id, goal_id) references public.goals (user_id, id),
  account_id uuid not null,
  foreign key (user_id, account_id) references public.accounts (user_id, id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint goal_accounts_user_id_id_key unique (user_id, id)
);

-- One live link per account per goal: counted twice, an account would double its balance.
-- Partial, so an account taken out and put back is a new row beside the removed one.
create unique index goal_accounts_live_key
  on public.goal_accounts (user_id, goal_id, account_id)
  where deleted_at is null;

-- The device's changed-since read (apps/web/src/queries/synced.ts).
create index goal_accounts_user_updated_idx
  on public.goal_accounts (user_id, updated_at);

create trigger goal_accounts_set_updated_at
  before update on public.goal_accounts
  for each row execute function public.set_updated_at();

create trigger goal_accounts_freeze_user_id
  before update on public.goal_accounts
  for each row execute function public.freeze_user_id();

alter table public.goal_accounts enable row level security;
alter table public.goal_accounts force row level security;

create policy goal_accounts_select_own on public.goal_accounts
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy goal_accounts_insert_own on public.goal_accounts
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy goal_accounts_update_own on public.goal_accounts
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.goal_accounts from authenticated;
revoke all on table public.goal_accounts from service_role;
grant select, insert on table public.goal_accounts to authenticated;
grant update (deleted_at) on table public.goal_accounts to authenticated;
