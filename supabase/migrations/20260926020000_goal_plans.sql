-- Goals in the monthly budget (GOAL-04): what she plans to give a goal each month, from a month
-- on, as a category's budget is (20260926010000).
--
-- Nora, 26 Sep, on Monarch: *"Where I want to set how much money I put towards or subtract from
-- a goal isn't always a strictly one to one transaction."* So what a goal was given in a month is
-- not stored at all, and no transaction is tied to a goal. It is computed on the device
-- (packages/core/src/contributions.ts): the money moved into the goal's own accounts from her
-- other accounts, filed as a transfer. Only the plan is hers to type, and it lives here.
--
--   * The plan for a month is the newest row starting on or before it, so setting one from
--     October leaves September's as it was. A null amount is "no plan from then", which is not
--     a plan of zero.
--   * No currency column: a plan is in its goal's currency, which cannot change (goals), and a
--     second copy of it would be a second place to disagree.
--   * Zero or more. A month she means to take money out is a plan of nothing, and the page shows
--     what was taken; a planned withdrawal is not asked for yet.
--
-- Written from supabase/patterns/owned_table.sql, with these differences, each as
-- category_budgets:
--
--   * No DELETE, for her or anyone. Removed is `deleted_at`.
--   * A row is never moved: UPDATE is its amount and `deleted_at`, so changing her mind twice in
--     one month edits that month's row, and every other month keeps its own.
--   * service_role gets no grant. The nightly job reads none of this.

create table public.goal_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  goal_id uuid not null,
  foreign key (user_id, goal_id) references public.goals (user_id, id),

  -- The first day of the month it starts in.
  starts_on date not null,
  -- Null: no plan from this month on.
  amount_minor bigint,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint goal_plans_user_id_id_key unique (user_id, id),
  constraint goal_plans_month_start check (extract(day from starts_on) = 1),
  -- Tested `is null or`, as category_budgets_amount_positive (ACCT-10).
  constraint goal_plans_amount_positive check (amount_minor is null or amount_minor >= 0)
);

-- One live row per goal per month: two would leave the month's plan to row order.
create unique index goal_plans_live_key
  on public.goal_plans (user_id, goal_id, starts_on)
  where deleted_at is null;

-- The device's changed-since read (apps/web/src/queries/synced.ts).
create index goal_plans_user_updated_idx
  on public.goal_plans (user_id, updated_at);

create trigger goal_plans_set_updated_at
  before update on public.goal_plans
  for each row execute function public.set_updated_at();

create trigger goal_plans_freeze_user_id
  before update on public.goal_plans
  for each row execute function public.freeze_user_id();

alter table public.goal_plans enable row level security;
alter table public.goal_plans force row level security;

create policy goal_plans_select_own on public.goal_plans
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy goal_plans_insert_own on public.goal_plans
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy goal_plans_update_own on public.goal_plans
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Revoked first, as for goals: the local image leaves `authenticated` all seven default
-- privileges, TRUNCATE included.
revoke all on table public.goal_plans from authenticated;
revoke all on table public.goal_plans from service_role;
grant select, insert on table public.goal_plans to authenticated;
grant update (amount_minor, deleted_at) on table public.goal_plans to authenticated;
