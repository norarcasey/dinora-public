-- Crypto at the day's price (ACCT-21): how much of a coin Nora holds, Gemini's daily close for
-- it, and a value worked out from the two by the nightly job, as gold's is (20260925230000).
--
-- Nora, 27 Sep 2026, on the rewards her Gemini card pays in crypto: "I would rather set how much
-- crypto I have and then display how much that amount is worth instead of setting the value all
-- the time". Linking the exchange itself needs a Gemini API key, which Gemini fails to create.
--
-- The source, measured 27 Sep 2026: Gemini's public market data, no key. `/v2/candles/<coin>usd
-- /1day` is 364 completed UTC days, newest first, answered in 0.5–0.7 s, about 23 KB.
--
--   * `assets.kind` gains `crypto`, with the coin (`BTC`, as Gemini names its base currency)
--     and how much of it she holds. A crypto asset has both and nothing else has either. In
--     dollars only: Gemini's `<coin>usd` close is the one price read.
--   * The quantity is `numeric`, not an integer of a smallest unit. Gemini's tick is 1e-8 for
--     BTC and 1e-6 for ETH, SHIB, PEPE and BONK (measured 27 Sep), and a memecoin balance runs
--     to tens of millions of coins: at 1e-8 that passes 2^53, which a JSON number cannot carry,
--     before a plausible SHIB balance does. So it is kept exactly as she typed it, read as
--     text (`coin_quantity::text`), and multiplied as integers in packages/core/src/crypto.ts.
--     Eighteen places is ETH's own smallest unit, and more than any balance Gemini shows.
--   * `crypto_prices`, kept as `metal_prices` is: one close per coin per day, `numeric` so the
--     digits Gemini sent are the digits kept, written once and never changed.
--   * `asset_values.provider` gains `gemini`, and a Gemini value carries `coin_quantity`, the
--     quantity it was worked out with. She will re-enter the quantity as rewards accrue; a
--     past value names what it counted, so it reproduces from its own row and the day's close
--     (invariant 3's reason), and a new quantity changes no value already stored.
--
-- The job runs as service_role. It gains the coin and quantity of an asset, the new column on
-- a value, and the prices table, and nothing she says anything is worth.

alter table public.assets
  add column coin text,
  add column coin_quantity numeric,
  drop constraint assets_kind_known,
  add constraint assets_kind_known check (kind in ('home', 'vehicle', 'valuables', 'crypto')),
  add constraint assets_crypto_whole check (
    (coin is null) = (coin_quantity is null) and (coin is null) = (kind <> 'crypto')
  ),
  add constraint assets_crypto_usd check (coin is null or currency = 'USD'),
  -- Gemini's base currencies are upper-case letters and digits: BTC, SHIB, 2Z.
  add constraint assets_coin_shape check (coin is null or coin ~ '^[A-Z0-9]{1,15}$'),
  -- A typmod would round what she typed without saying so; these refuse it instead.
  add constraint assets_coin_quantity_exact check (
    coin_quantity is null
    or (coin_quantity > 0 and coin_quantity < 1e20 and scale(coin_quantity) <= 18)
  );

grant update (coin, coin_quantity) on table public.assets to authenticated;
grant select (coin, coin_quantity) on table public.assets to service_role;

alter table public.asset_values
  add column coin_quantity numeric,
  drop constraint asset_values_estimate_provider,
  add constraint asset_values_estimate_provider check (
    (source = 'estimate') = (provider is not null)
    and (provider is null or provider in ('rentcast', 'marketcheck', 'lbma', 'gemini'))
  ),
  add constraint asset_values_gemini_quantity check (
    (coin_quantity is not null) = (provider is not distinct from 'gemini')
    and (coin_quantity is null or coin_quantity > 0)
  );

grant insert (coin_quantity) on table public.asset_values to service_role;

create table public.crypto_prices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  source text not null,
  coin text not null,
  currency text not null,
  -- The UTC day the candle covers: its close is the price at the end of that day.
  price_date date not null,
  -- One whole coin, in `currency`, as sent. Numeric for the reason `metal_prices.price` is;
  -- a memecoin's close is a few millionths of a dollar (SHIB 0.000005959 on 25 Sep 2026).
  price numeric not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint crypto_prices_user_id_id_key unique (user_id, id),
  constraint crypto_prices_one_per_day unique (user_id, source, coin, currency, price_date),
  constraint crypto_prices_source_known check (source in ('gemini')),
  constraint crypto_prices_coin_shape check (coin ~ '^[A-Z0-9]{1,15}$'),
  constraint crypto_prices_currency_code check (currency ~ '^[A-Z]{3}$'),
  constraint crypto_prices_price_positive check (price > 0)
);

create index crypto_prices_user_live_idx
  on public.crypto_prices (user_id, created_at)
  where deleted_at is null;

-- The device's changed-since read (apps/web/src/queries/synced.ts): a row a day per coin.
create index crypto_prices_user_updated_idx
  on public.crypto_prices (user_id, updated_at);

create trigger crypto_prices_set_updated_at
  before update on public.crypto_prices
  for each row execute function public.set_updated_at();

create trigger crypto_prices_freeze_user_id
  before update on public.crypto_prices
  for each row execute function public.freeze_user_id();

alter table public.crypto_prices enable row level security;
alter table public.crypto_prices force row level security;

create policy crypto_prices_select_own on public.crypto_prices
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Read-only to her, as metal_prices is. The job inserts and never updates: a stored close is
-- what some value was worked out with. It reads nothing back, but `on conflict ... do nothing`
-- with a conflict target is refused without SELECT (measured on the local stack, 27 Sep 2026),
-- so it holds SELECT too, as metal_prices' job does.
revoke all on table public.crypto_prices from authenticated;
revoke all on table public.crypto_prices from service_role;
grant select on table public.crypto_prices to authenticated;
grant select, insert on table public.crypto_prices to service_role;
