-- Budgets (BUD-01): transactions put into categories, and each category given a monthly
-- budget, so this month can be read against it.
--
-- Nora, 24 Sep: *"Budget and goal should be the next milestones."* The shape was decided on
-- the runway before any of this was written: the categories are Dinora's own, not the
-- aggregator's, with the aggregator's kept as the first guess; and a rule that re-categorises a
-- payee applies forward and is shown, never silently rewriting past months.
--
-- Four tables, all hers, none the job's. Which category a transaction is in is computed on the
-- device (packages/core/src/budgets.ts), in this order: her own choice for that transaction;
-- else the newest rule for its payee that had started by its day; else the aggregator's
-- category, if a category of hers takes guesses from that name; else none. So nothing here
-- rewrites a transaction, which stays the bank's and read-only (20260924134228).
--
--   * `categories`: hers, named, of one kind. A spending category can carry a budget; income
--     is totalled; a transfer (a card payment, a move between her accounts) is neither, so it
--     is not counted as spent twice. `guesses_from` holds the aggregator's names it takes as
--     its first guess — several, so Monarch's "Coffee Shops" and "Restaurants & Bars" can both
--     land in one of hers. An array and not a table: they are names, and no key points at one.
--   * `category_budgets`: a budget from a month on. The budget for a month is the newest row
--     starting on or before it, so setting one from September leaves August's as it was. A
--     null amount is "no budget from then", which is not a budget of zero.
--   * `transaction_categories`: her choice for one transaction. Changed by removing the choice
--     and adding another, never repointed, as goal_accounts, so what it was stays as history.
--   * `category_rules`: every transaction from a payee, from a month on. The page makes it
--     from the first of the month it is made in: this month's sort changes, no earlier month's
--     does. A rule stopped is a newer rule with no category, so the months it covered keep it.
--
-- Written from supabase/patterns/owned_table.sql, with these differences, each as goals:
--
--   * No DELETE, for her or anyone. Removed is `deleted_at`.
--   * Unlike a goal's, a category's kind can change: one made as spending that turns out to
--     hold transfers was wrong about every month, not from one month on, so it is corrected
--     everywhere, and the page says so before it saves.
--   * Links are never repointed: `transaction_categories` and `category_rules` update
--     `deleted_at` alone, and a budget row updates only its amount (the page's "from this
--     month" edits the row for the month when one exists, rather than stacking a second).
--   * service_role gets no grant. The nightly job reads none of this.
--
-- And one change to the bank's table: the index the device's changed-since read of
-- `transactions` needs, now that the app reads them (apps/web/src/queries/synced.ts). The
-- balances query's note said 528 rows would want it; production holds about 8,500.

create index transactions_user_updated_idx
  on public.transactions (user_id, updated_at);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  name text not null,
  kind text not null,
  guesses_from text[] not null default '{}',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint categories_user_id_id_key unique (user_id, id),
  constraint categories_name_length check (char_length(name) between 1 and 100),
  constraint categories_kind_known check (kind in ('spend', 'income', 'transfer')),
  -- As transactions_source_category_length, whose values these are.
  constraint categories_guesses_bounded check (
    cardinality(guesses_from) <= 50
    and char_length(array_to_string(guesses_from, '')) <= 5000
  )
);

-- Two live categories with one name would be two rows on the page nobody could tell apart.
create unique index categories_live_name_key
  on public.categories (user_id, lower(name))
  where deleted_at is null;

create index categories_user_live_idx
  on public.categories (user_id, created_at)
  where deleted_at is null;

-- The device's changed-since read (apps/web/src/queries/synced.ts).
create index categories_user_updated_idx
  on public.categories (user_id, updated_at);

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

create trigger categories_freeze_user_id
  before update on public.categories
  for each row execute function public.freeze_user_id();

alter table public.categories enable row level security;
alter table public.categories force row level security;

create policy categories_select_own on public.categories
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy categories_insert_own on public.categories
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy categories_update_own on public.categories
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Revoked first, as for goals: the local image leaves `authenticated` all seven default
-- privileges, TRUNCATE included.
revoke all on table public.categories from authenticated;
revoke all on table public.categories from service_role;
grant select, insert on table public.categories to authenticated;
grant update (name, kind, guesses_from, deleted_at) on table public.categories to authenticated;

create table public.category_budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category_id uuid not null,
  foreign key (user_id, category_id) references public.categories (user_id, id),

  -- The first day of the month it starts in.
  starts_on date not null,
  -- Null: no budget from this month on.
  amount_minor bigint,
  currency text not null default 'USD',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint category_budgets_user_id_id_key unique (user_id, id),
  constraint category_budgets_month_start check (extract(day from starts_on) = 1),
  -- Tested `is null or`, since a CHECK whose expression is null passes anyway, and saying so
  -- is clearer than relying on it (ACCT-10).
  constraint category_budgets_amount_positive check (amount_minor is null or amount_minor >= 0),
  constraint category_budgets_currency_code check (currency ~ '^[A-Z]{3}$')
);

-- One live row per category per month: two would leave the month's budget to row order.
create unique index category_budgets_live_key
  on public.category_budgets (user_id, category_id, starts_on)
  where deleted_at is null;

create index category_budgets_user_updated_idx
  on public.category_budgets (user_id, updated_at);

create trigger category_budgets_set_updated_at
  before update on public.category_budgets
  for each row execute function public.set_updated_at();

create trigger category_budgets_freeze_user_id
  before update on public.category_budgets
  for each row execute function public.freeze_user_id();

alter table public.category_budgets enable row level security;
alter table public.category_budgets force row level security;

create policy category_budgets_select_own on public.category_budgets
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy category_budgets_insert_own on public.category_budgets
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy category_budgets_update_own on public.category_budgets
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.category_budgets from authenticated;
revoke all on table public.category_budgets from service_role;
grant select, insert on table public.category_budgets to authenticated;
grant update (amount_minor, deleted_at) on table public.category_budgets to authenticated;

create table public.transaction_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  transaction_id uuid not null,
  foreign key (user_id, transaction_id) references public.transactions (user_id, id),
  category_id uuid not null,
  foreign key (user_id, category_id) references public.categories (user_id, id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint transaction_categories_user_id_id_key unique (user_id, id)
);

-- One live choice per transaction: two would put it in two categories and count it twice.
create unique index transaction_categories_live_key
  on public.transaction_categories (user_id, transaction_id)
  where deleted_at is null;

create index transaction_categories_user_updated_idx
  on public.transaction_categories (user_id, updated_at);

create trigger transaction_categories_set_updated_at
  before update on public.transaction_categories
  for each row execute function public.set_updated_at();

create trigger transaction_categories_freeze_user_id
  before update on public.transaction_categories
  for each row execute function public.freeze_user_id();

alter table public.transaction_categories enable row level security;
alter table public.transaction_categories force row level security;

create policy transaction_categories_select_own on public.transaction_categories
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy transaction_categories_insert_own on public.transaction_categories
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy transaction_categories_update_own on public.transaction_categories
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.transaction_categories from authenticated;
revoke all on table public.transaction_categories from service_role;
grant select, insert on table public.transaction_categories to authenticated;
grant update (deleted_at) on table public.transaction_categories to authenticated;

create table public.category_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- As the device compares it: trimmed, lower case, one space between words.
  payee text not null,
  -- Null: a rule stopped from this month on.
  category_id uuid,
  foreign key (user_id, category_id) references public.categories (user_id, id),
  -- The first day of the month it applies from.
  starts_on date not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint category_rules_user_id_id_key unique (user_id, id),
  constraint category_rules_payee_length check (char_length(payee) between 1 and 500),
  constraint category_rules_month_start check (extract(day from starts_on) = 1)
);

create index category_rules_user_updated_idx
  on public.category_rules (user_id, updated_at);

create trigger category_rules_set_updated_at
  before update on public.category_rules
  for each row execute function public.set_updated_at();

create trigger category_rules_freeze_user_id
  before update on public.category_rules
  for each row execute function public.freeze_user_id();

alter table public.category_rules enable row level security;
alter table public.category_rules force row level security;

create policy category_rules_select_own on public.category_rules
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy category_rules_insert_own on public.category_rules
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy category_rules_update_own on public.category_rules
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.category_rules from authenticated;
revoke all on table public.category_rules from service_role;
grant select, insert on table public.category_rules to authenticated;
grant update (deleted_at) on table public.category_rules to authenticated;
