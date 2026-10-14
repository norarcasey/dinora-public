-- Home and car values, estimated (ACCT-11): a market estimate for the apartment and the car,
-- read weekly by the nightly job and kept beside the values Nora sets (20260925180000).
--
-- Two sources, chosen 25 Sep 2026 because they answer for free at this volume: RentCast's
-- value AVM for a home, given its address, and MarketCheck's dealer-retail price for a car,
-- given its VIN, mileage and ZIP code. About nine calls a month between them.
--
--   * `assets` gains what each source is asked with. An address for a home; a VIN, a ZIP
--     code and an odometer reading with its date for a vehicle. None of them is required: an
--     asset with none is never estimated, as jewelry never is.
--   * `asset_values.source` gains `estimate`, with the `provider` that gave it and, where the
--     provider gives one, the range around it. `valued_on` is the day it was read. It is a new
--     row like any other value, so it overwrites nothing of hers; which value counts is the
--     app's rule (packages/core/src/assets.ts), decided by Nora 25 Sep: one she entered wins,
--     and the estimate is shown beside it.
--
-- The job runs as service_role, which until now could read nothing here. It gains the least
-- it needs: what the sources are asked with, the days estimates were read, and INSERT.
-- Column grants keep her values' amounts from it, and a trigger keeps each side to its own
-- source: only service_role writes an estimate, and service_role writes nothing else. RLS
-- does not do this, since service_role bypasses it.

alter table public.assets
  add column address text,
  add column postal_code text,
  add column vin text,
  add column odometer_miles integer,
  add column odometer_on date,
  add constraint assets_address_home check (
    address is null or (kind = 'home' and char_length(address) between 1 and 300)
  ),
  add constraint assets_vehicle_lookup check (
    (vin is null and postal_code is null and odometer_miles is null) or kind = 'vehicle'
  ),
  -- A VIN is 17 characters and never I, O or Q, which read as 1 and 0.
  add constraint assets_vin_shape check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  add constraint assets_postal_code_shape check (postal_code is null or postal_code ~ '^[0-9]{5}$'),
  -- A mileage is worth something only with the day it was read.
  add constraint assets_odometer_dated check (
    (odometer_miles is null) = (odometer_on is null)
    and (odometer_miles is null or odometer_miles >= 0)
  );

grant update (address, postal_code, vin, odometer_miles, odometer_on)
  on table public.assets to authenticated;

alter table public.asset_values
  add column provider text,
  add column low_minor bigint,
  add column high_minor bigint,
  drop constraint asset_values_source_known,
  add constraint asset_values_source_known check (source in ('entered', 'monarch', 'estimate')),
  add constraint asset_values_estimate_provider check (
    (source = 'estimate') = (provider is not null)
    and (provider is null or provider in ('rentcast', 'marketcheck'))
  ),
  add constraint asset_values_range check (
    (low_minor is null) = (high_minor is null)
    and (low_minor is null or (source = 'estimate' and low_minor <= amount_minor and amount_minor <= high_minor))
  ),
  -- One estimate per asset per provider per day, so a second run on a day writes nothing.
  -- A constraint rather than a partial index: PostgREST's `on_conflict` names columns and
  -- cannot name an index's WHERE. Rows with no provider are all distinct under it.
  add constraint asset_values_estimate_day unique (user_id, asset_id, provider, valued_on);

create function public.asset_values_source_by_role()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (current_user = 'service_role') <> (new.source = 'estimate') then
    raise exception 'an estimate is written by the nightly job, and the job writes only estimates'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger asset_values_source_by_role
  before insert on public.asset_values
  for each row execute function public.asset_values_source_by_role();

grant select (id, user_id, kind, currency, address, postal_code, vin, odometer_miles, odometer_on, deleted_at)
  on table public.assets to service_role;
grant select (asset_id, user_id, source, provider, valued_on, deleted_at)
  on table public.asset_values to service_role;
grant insert (user_id, asset_id, valued_on, amount_minor, source, provider, low_minor, high_minor)
  on table public.asset_values to service_role;
