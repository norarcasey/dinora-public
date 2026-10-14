-- Exchange rates (ACCT-02): what a total across dollars and euros was converted at, kept so
-- that it can be converted at the same rate again (invariant 3).
--
-- One row per published rate: the ECB's euro reference rates, read through Frankfurter by
-- the nightly job. `rate_date` is the ECB's date for the rate, not the day it was read, so
-- a Sunday's total uses Friday's row and can say so. A row is written once and never
-- changed: the job inserts with ON CONFLICT DO NOTHING, and nobody holds UPDATE, so a rate
-- the ECB later corrects cannot move a total already shown with the first one.
--
-- Owned, like everything else, though the rates are nobody's secret: the rules are one set
-- for every table (invariant 6), and the one user is who the job writes them for.

create table public.fx_rates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  source text not null,
  base text not null,
  quote text not null,
  rate_date date not null,
  -- One `base` is worth `rate` of `quote`. Numeric, not float, so the digits the ECB
  -- published are the digits kept; the app reads it as text (`rate::text`).
  rate numeric not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint fx_rates_user_id_id_key unique (user_id, id),
  constraint fx_rates_one_per_day unique (user_id, source, base, quote, rate_date),
  constraint fx_rates_source_known check (source in ('ecb')),
  constraint fx_rates_base_code check (base ~ '^[A-Z]{3}$'),
  constraint fx_rates_quote_code check (quote ~ '^[A-Z]{3}$' and quote <> base),
  constraint fx_rates_rate_positive check (rate > 0)
);

create index fx_rates_user_live_idx
  on public.fx_rates (user_id, created_at)
  where deleted_at is null;

create trigger fx_rates_set_updated_at
  before update on public.fx_rates
  for each row execute function public.set_updated_at();

create trigger fx_rates_freeze_user_id
  before update on public.fx_rates
  for each row execute function public.freeze_user_id();

alter table public.fx_rates enable row level security;
alter table public.fx_rates force row level security;

create policy fx_rates_select_own on public.fx_rates
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Read-only to her, as the bank tables are (20260924134228_bank_accounts.sql). The job
-- inserts and never updates: a stored rate is what some total was computed with.
revoke all on table public.fx_rates from authenticated;
grant select on table public.fx_rates to authenticated;
grant select, insert on table public.fx_rates to service_role;
