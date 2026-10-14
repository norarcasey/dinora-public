-- Property and valuables (ACCT-06): the apartment, the car, jewelry and silver, counted in
-- net worth at values Nora sets.
--
-- Two tables of her own, not rows in `accounts`: those are the bank's, read-only to her and
-- rewritten by every pull (20260924134228), and nothing reads an apartment nightly.
--
--   * `assets`, one row per thing she owns. What it cost and when, so the screen can say what
--     it has gained, which is the point for gold bought in 2022. And the loan it was bought
--     with, if any, so the home is shown beside the mortgage and the car beside the auto loan
--     and what she owns of each can be read. Decided with her 25 Sep: Monarch showed neither.
--   * `asset_values`, one row per value per day it was set, kept when a newer one arrives, as
--     `account_terms` keeps a card's limits (20260925120000). A value is minor units in the
--     asset's currency (invariant 1), and says where it came from: `entered` by her, or
--     `monarch`, imported from Monarch's balance file. An estimate from somewhere else — a
--     home's or a car's market value, a metal's spot price — is a later item's, and will be a
--     third source, shown as one.
--
-- Written from supabase/patterns/owned_table.sql, with these differences:
--
--   * No DELETE, for her or anyone. An asset or a value entered by mistake is removed with
--     `deleted_at`.
--   * A value cannot be rewritten in place: UPDATE on `asset_values` is `deleted_at` alone,
--     so a new value is a new row and the old one stays as history.
--   * An asset's currency cannot change, since its values are in it; nor can `monarch_name`,
--     which is how a second import finds the asset the first one made.
--   * service_role gets no grant. The Monarch import writes as her, through her own policy
--     (scripts/monarch/sql.ts), so the nightly job's role gains nothing it never uses.
--
-- The loan and the asset are referenced through (user_id, id), so the policy's check on
-- user_id also means the account and the asset are hers, as in account_groups
-- (20260924220000).

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  name text not null,
  kind text not null,
  currency text not null default 'USD',
  acquired_on date,
  cost_minor bigint,
  financed_by uuid,
  foreign key (user_id, financed_by) references public.accounts (user_id, id),
  monarch_name text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint assets_user_id_id_key unique (user_id, id),
  constraint assets_monarch_name_key unique (user_id, monarch_name),
  constraint assets_name_length check (char_length(name) between 1 and 200),
  constraint assets_kind_known check (kind in ('home', 'vehicle', 'valuables')),
  constraint assets_currency_code check (currency ~ '^[A-Z]{3}$'),
  -- A cost says what was gained only against the day it was paid.
  constraint assets_cost_dated check (
    cost_minor is null or (cost_minor >= 0 and acquired_on is not null)
  )
);

create index assets_user_live_idx
  on public.assets (user_id, created_at)
  where deleted_at is null;

-- The device's changed-since read (apps/web/src/queries/synced.ts).
create index assets_user_updated_idx
  on public.assets (user_id, updated_at);

create trigger assets_set_updated_at
  before update on public.assets
  for each row execute function public.set_updated_at();

create trigger assets_freeze_user_id
  before update on public.assets
  for each row execute function public.freeze_user_id();

alter table public.assets enable row level security;
alter table public.assets force row level security;

create policy assets_select_own on public.assets
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy assets_insert_own on public.assets
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy assets_update_own on public.assets
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Revoked first, as for account_groups: the local image leaves `authenticated` all seven
-- default privileges, TRUNCATE included.
revoke all on table public.assets from authenticated;
revoke all on table public.assets from service_role;
grant select, insert on table public.assets to authenticated;
grant update (name, kind, acquired_on, cost_minor, financed_by, deleted_at)
  on table public.assets to authenticated;

create table public.asset_values (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  asset_id uuid not null,
  foreign key (user_id, asset_id) references public.assets (user_id, id),

  valued_on date not null,
  amount_minor bigint not null,
  source text not null default 'entered',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint asset_values_user_id_id_key unique (user_id, id),
  constraint asset_values_amount_nonnegative check (amount_minor >= 0),
  constraint asset_values_source_known check (source in ('entered', 'monarch'))
);

create index asset_values_user_live_idx
  on public.asset_values (user_id, asset_id, valued_on)
  where deleted_at is null;

-- The device's changed-since read (apps/web/src/queries/synced.ts).
create index asset_values_user_updated_idx
  on public.asset_values (user_id, updated_at);

-- What makes a second Monarch import write nothing: one of Monarch's values per asset per day.
create unique index asset_values_monarch_day_key
  on public.asset_values (user_id, asset_id, valued_on)
  where source = 'monarch' and deleted_at is null;

create trigger asset_values_set_updated_at
  before update on public.asset_values
  for each row execute function public.set_updated_at();

create trigger asset_values_freeze_user_id
  before update on public.asset_values
  for each row execute function public.freeze_user_id();

alter table public.asset_values enable row level security;
alter table public.asset_values force row level security;

create policy asset_values_select_own on public.asset_values
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy asset_values_insert_own on public.asset_values
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy asset_values_update_own on public.asset_values
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.asset_values from authenticated;
revoke all on table public.asset_values from service_role;
grant select, insert on table public.asset_values to authenticated;
grant update (deleted_at) on table public.asset_values to authenticated;
