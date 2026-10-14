-- Gold and silver at the day's price (ACCT-12): what a piece of metal weighs and how pure it is,
-- the LBMA's daily price for it, and a value worked out from the two by the nightly job.
--
-- The source, chosen 25 Sep 2026: the LBMA's own price files (prices.lbma.org.uk/json), the
-- benchmark the market settles on, free and with no key. Each file is every business day's
-- price since 1968 in dollars, pounds and euros, about 900 KB (fetched 25 Sep 2026).
--
--   * `assets` gains what a value is worked out from: which metal, its weight in milligrams
--     and its fineness in thousandths (18-karat is 750, sterling 925). Integers, as amounts
--     are (invariant 1). All three or none, and only on valuables.
--   * `metal_prices`, kept as `fx_rates` is (20260924180000): one row per published price, the
--     LBMA's date for it, `numeric` so the digits it published are the digits kept, written
--     once and never changed. So a value worked out on a past day can be worked out again
--     (invariant 3), and what gold has done since the day she bought it can be read.
--   * `asset_values.provider` gains `lbma`: the job's value for a piece of metal is an
--     estimate like RentCast's (20260925210000), a row of its own that overwrites nothing of
--     hers. A value she entered still counts over it (packages/core/src/assets.ts).
--
-- The job runs as service_role. It gains the three new columns and the purchase day, which
-- says how far back prices are needed, and nothing she says anything is worth.

alter table public.assets
  add column metal text,
  add column metal_mg bigint,
  add column fineness integer,
  add constraint assets_metal_known check (metal is null or metal in ('gold', 'silver')),
  add constraint assets_metal_whole check (
    (metal is null) = (metal_mg is null) and (metal is null) = (fineness is null)
  ),
  add constraint assets_metal_valuables check (metal is null or kind = 'valuables'),
  add constraint assets_metal_mg_positive check (metal_mg is null or metal_mg > 0),
  add constraint assets_fineness_range check (fineness is null or fineness between 1 and 1000);

grant update (metal, metal_mg, fineness) on table public.assets to authenticated;
grant select (metal, metal_mg, fineness, acquired_on) on table public.assets to service_role;

alter table public.asset_values
  drop constraint asset_values_estimate_provider,
  add constraint asset_values_estimate_provider check (
    (source = 'estimate') = (provider is not null)
    and (provider is null or provider in ('rentcast', 'marketcheck', 'lbma'))
  );

create table public.metal_prices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  source text not null,
  metal text not null,
  currency text not null,
  price_date date not null,
  -- One troy ounce of the pure metal, in `currency`, as published. Numeric for the reason
  -- `fx_rates.rate` is; the app reads it as text (`price::text`).
  price numeric not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint metal_prices_user_id_id_key unique (user_id, id),
  constraint metal_prices_one_per_day unique (user_id, source, metal, currency, price_date),
  constraint metal_prices_source_known check (source in ('lbma')),
  constraint metal_prices_metal_known check (metal in ('gold', 'silver')),
  constraint metal_prices_currency_code check (currency ~ '^[A-Z]{3}$'),
  constraint metal_prices_price_positive check (price > 0)
);

create index metal_prices_user_live_idx
  on public.metal_prices (user_id, created_at)
  where deleted_at is null;

-- The device's changed-since read (apps/web/src/queries/synced.ts): about 250 rows a year
-- per metal and currency, and a backfill of every day since the oldest purchase.
create index metal_prices_user_updated_idx
  on public.metal_prices (user_id, updated_at);

create trigger metal_prices_set_updated_at
  before update on public.metal_prices
  for each row execute function public.set_updated_at();

create trigger metal_prices_freeze_user_id
  before update on public.metal_prices
  for each row execute function public.freeze_user_id();

alter table public.metal_prices enable row level security;
alter table public.metal_prices force row level security;

create policy metal_prices_select_own on public.metal_prices
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Read-only to her, as fx_rates is. The job inserts and never updates: a stored price is
-- what some value was worked out with.
revoke all on table public.metal_prices from authenticated;
revoke all on table public.metal_prices from service_role;
grant select on table public.metal_prices to authenticated;
grant select, insert on table public.metal_prices to service_role;
