-- Balance history (ACCT-03): every account's balance, one row a day, so a net worth can be
-- drawn over time (ACCT-04). `accounts` keeps only the latest balance.
--
-- Two kinds of row, and the kind is part of the figure:
--
--   * `read`: what the bank said, kept by the nightly pull from the balance it stores, and
--     dated by the bank's `balance_at`, not by the pull.
--   * `rebuilt`: a day before an account's first reading, walked back from that reading
--     through the transactions `BANK-02` keeps. A guess, as good as the bank's settled
--     transactions, and drawn as one. Never for an investment: its past is the market's.
--
-- `ACCT-05` adds a third, Monarch's history, by widening `balance_snapshots_kind_known`.
--
-- Days are UTC days. The bank's times, the job's and the ECB's dates share no zone, and UTC
-- is the one they are all stored in; for someone in Spain the difference is the hour or two
-- before midnight, which a line drawn by the day does not show.
--
-- No total is stored (invariant 3). A day's net is computed from that day's rows and the
-- newest `fx_rates` row dated on or before it, and no role can change a stored rate, so it
-- computes the same later. A day is provisional only until its own rate is read: the ECB
-- publishes in the afternoon and the job reads at 09:00 UTC the next day. Storing the rate's
-- id beside a total would freeze the provisional rate instead.
--
-- Nothing is seeded from `accounts` here. The first night's pull writes each account's first
-- reading and the days before it, and only the pull knows which accounts hold investments.
--
-- The rows are the bank's, as `accounts` are: read-only to her (20260924134228).

alter table public.accounts
  add column holdings integer not null default 0,
  add constraint accounts_holdings_count check (holdings >= 0);

alter table public.bank_pulls
  add column kept integer not null default 0,
  add column rebuilt integer not null default 0;

create table public.balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null,
  foreign key (user_id, account_id) references public.accounts (user_id, id),

  on_date date not null,
  kind text not null,
  -- The account's, copied: a row has to mean the same thing if the account's changes.
  currency text not null,
  balance_minor bigint not null,
  -- The bank's time for a reading; the end of the day for a rebuilt row.
  as_of timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint balance_snapshots_user_id_id_key unique (user_id, id),
  constraint balance_snapshots_one_per_day unique (user_id, account_id, on_date),
  constraint balance_snapshots_kind_known check (kind in ('read', 'rebuilt')),
  constraint balance_snapshots_currency_iso check (currency ~ '^[A-Z]{3}$')
);

create index balance_snapshots_user_live_idx
  on public.balance_snapshots (user_id, created_at)
  where deleted_at is null;

-- The device's changed-since read. About 2,900 rows a year at 8 accounts, every one kept on
-- the device, so unlike `accounts` this table is worth the index.
create index balance_snapshots_user_updated_idx
  on public.balance_snapshots (user_id, updated_at);

create trigger balance_snapshots_set_updated_at
  before update on public.balance_snapshots
  for each row execute function public.set_updated_at();

create trigger balance_snapshots_freeze_user_id
  before update on public.balance_snapshots
  for each row execute function public.freeze_user_id();

alter table public.balance_snapshots enable row level security;
alter table public.balance_snapshots force row level security;

create policy balance_snapshots_select_own on public.balance_snapshots
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.balance_snapshots from authenticated;
grant select on table public.balance_snapshots to authenticated;
grant select, insert, update on table public.balance_snapshots to service_role;

-- `bank_store` as before (20260924140054). Now it also stores each account's holdings count,
-- keeps the day's readings and rebuilds the days before them, in the same transaction as
-- the rows they are read from.
create or replace function public.bank_store(
  p_user uuid,
  p_source text,
  p_payload jsonb,
  p_started_at timestamptz,
  p_requests integer,
  p_drops_from timestamptz,
  p_detail text
)
returns public.bank_pulls
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_accounts integer;
  v_seen integer;
  v_added integer;
  v_dropped integer := 0;
  v_restored integer;
  v_kept integer;
  v_rebuilt integer;
  v_run public.bank_pulls;
begin
  insert into public.accounts
    (user_id, source, source_id, institution, name, currency,
     balance_minor, available_minor, balance_at, holdings)
  select p_user, p_source, a.source_id, a.institution, a.name, a.currency,
         a.balance_minor, a.available_minor, a.balance_at, coalesce(a.holdings, 0)
  from jsonb_to_recordset(p_payload -> 'accounts') as a (
    source_id text, institution text, name text, currency text,
    balance_minor bigint, available_minor bigint, balance_at timestamptz, holdings integer)
  on conflict (user_id, source, source_id) do update set
    institution = excluded.institution,
    name = excluded.name,
    currency = excluded.currency,
    balance_minor = excluded.balance_minor,
    available_minor = excluded.available_minor,
    balance_at = excluded.balance_at,
    holdings = excluded.holdings;
  get diagnostics v_accounts = row_count;

  -- The pull's transactions, resolved to account ids once and read three times below.
  if to_regclass('pg_temp.bank_incoming') is not null then
    drop table pg_temp.bank_incoming;
  end if;
  create temporary table bank_incoming on commit drop as
  select acc.id as account_id, t.source_id, t.posted_at, t.transacted_at, t.amount_minor,
         t.description, t.payee, t.memo, t.pending
  from jsonb_to_recordset(p_payload -> 'transactions') as t (
    account_source_id text, source_id text, posted_at timestamptz, transacted_at timestamptz,
    amount_minor bigint, description text, payee text, memo text, pending boolean)
  join public.accounts acc
    on acc.user_id = p_user and acc.source = p_source and acc.source_id = t.account_source_id;

  select count(*) into v_restored
  from public.transactions x
  join pg_temp.bank_incoming i on i.account_id = x.account_id and i.source_id = x.source_id
  where x.user_id = p_user and x.dropped_at is not null;

  with written as (
    insert into public.transactions
      (user_id, account_id, source_id, posted_at, transacted_at, amount_minor,
       description, payee, memo, pending)
    select p_user, i.account_id, i.source_id, i.posted_at, i.transacted_at, i.amount_minor,
           i.description, i.payee, i.memo, i.pending
    from pg_temp.bank_incoming i
    on conflict (user_id, account_id, source_id) do update set
      posted_at = excluded.posted_at,
      transacted_at = excluded.transacted_at,
      amount_minor = excluded.amount_minor,
      description = excluded.description,
      payee = excluded.payee,
      memo = excluded.memo,
      pending = excluded.pending,
      dropped_at = null
    returning (xmax = 0) as inserted
  )
  select count(*), count(*) filter (where inserted) into v_seen, v_added from written;

  if p_drops_from is not null then
    update public.transactions x set dropped_at = now()
    from public.accounts acc
    where acc.id = x.account_id
      and acc.user_id = p_user
      and acc.source = p_source
      and acc.source_id in (
        select a ->> 'source_id' from jsonb_array_elements(p_payload -> 'accounts') as a)
      and x.user_id = p_user
      and x.dropped_at is null
      and x.deleted_at is null
      -- Neither date means pending and undated, which is to say current.
      and coalesce(x.posted_at, x.transacted_at, now()) >= p_drops_from
      and not exists (
        select 1 from pg_temp.bank_incoming i where i.account_id = x.account_id and i.source_id = x.source_id);
    get diagnostics v_dropped = row_count;
  end if;

  -- The day's reading of every account in the pull, on the UTC day of the bank's own
  -- `balance_at`: a bank that did not refresh repeats a day already kept, so it adds none.
  -- A reading replaces anything that is not one, and a reading of the same day only when
  -- the bank's time is newer (the 11:00 run after the 09:00).
  insert into public.balance_snapshots
    (user_id, account_id, on_date, kind, currency, balance_minor, as_of)
  select p_user, acc.id, (acc.balance_at at time zone 'UTC')::date, 'read', acc.currency,
         acc.balance_minor, acc.balance_at
  from public.accounts acc
  where acc.user_id = p_user
    and acc.source = p_source
    and acc.deleted_at is null
    and acc.source_id in (
      select a ->> 'source_id' from jsonb_array_elements(p_payload -> 'accounts') as a)
  on conflict (user_id, account_id, on_date) do update set
    kind = 'read',
    currency = excluded.currency,
    balance_minor = excluded.balance_minor,
    as_of = excluded.as_of
  where public.balance_snapshots.kind <> 'read'
     or excluded.as_of > public.balance_snapshots.as_of;
  get diagnostics v_kept = row_count;

  -- The days before an account's first reading, walked back from it through the settled
  -- transactions: the balance at the end of day d is the first reading less everything
  -- posted after d and by the reading's time. Pending and dropped transactions are left
  -- out, because the bank's balance does not carry them. Not for an account with holdings,
  -- whose past is the market's.
  --
  -- From `history_from` in the payload, the day from which the caller says the pull holds
  -- every settled transaction (`historyFrom` in packages/core/src/simplefin.ts), or from
  -- the account's earliest transaction if that is older. An account with no transactions
  -- is then flat back to it, which is what it was. Without `history_from` — an incomplete
  -- answer, or a bundle older than this migration — only from the earliest transaction:
  -- before it, what is missing cannot be told from what never happened.
  --
  -- Every night, for all of them, so a transaction that settles late corrects its own day.
  -- Written only where the figure changed, so a night that changes nothing sends the device
  -- nothing; and only over a rebuilt row, never a reading.
  with anchor as (
    select distinct on (s.account_id) s.account_id, s.on_date, s.as_of, s.currency,
           s.balance_minor
    from public.balance_snapshots s
    join public.accounts acc on acc.id = s.account_id
    where s.user_id = p_user
      and s.kind = 'read'
      and s.deleted_at is null
      and acc.user_id = p_user
      and acc.source = p_source
      and acc.holdings = 0
      and acc.deleted_at is null
      and acc.source_id in (
        select a ->> 'source_id' from jsonb_array_elements(p_payload -> 'accounts') as a)
    order by s.account_id, s.on_date, s.as_of
  ), settled as (
    select x.account_id, x.posted_at, x.amount_minor
    from public.transactions x
    join anchor on anchor.account_id = x.account_id
    where x.user_id = p_user
      and x.deleted_at is null
      and x.dropped_at is null
      and not x.pending
      and x.posted_at is not null
      and x.posted_at <= anchor.as_of
  ), days as (
    select anchor.account_id, anchor.currency, anchor.balance_minor, d::date as on_date
    from anchor
    cross join lateral generate_series(
      -- `least` passes over a null, so either bound alone is enough.
      least(
        (select min((t.posted_at at time zone 'UTC')::date)
         from settled t where t.account_id = anchor.account_id),
        ((p_payload ->> 'history_from')::timestamptz at time zone 'UTC')::date
      )::timestamp,
      (anchor.on_date - 1)::timestamp,
      interval '1 day') as d
  )
  insert into public.balance_snapshots
    (user_id, account_id, on_date, kind, currency, balance_minor, as_of)
  select p_user, days.account_id, days.on_date, 'rebuilt', days.currency,
         days.balance_minor - coalesce((
           select sum(t.amount_minor) from settled t
           where t.account_id = days.account_id
             and t.posted_at >= (days.on_date + 1)::timestamp at time zone 'UTC'), 0)::bigint,
         (days.on_date + 1)::timestamp at time zone 'UTC'
  from days
  on conflict (user_id, account_id, on_date) do update set
    currency = excluded.currency,
    balance_minor = excluded.balance_minor
  where public.balance_snapshots.kind = 'rebuilt'
    and public.balance_snapshots.balance_minor is distinct from excluded.balance_minor;
  get diagnostics v_rebuilt = row_count;

  insert into public.bank_pulls
    (user_id, source, outcome, started_at, requests, accounts, transactions,
     added, dropped, restored, kept, rebuilt, drops_from, detail)
  values
    (p_user, p_source, 'ok', p_started_at, p_requests, v_accounts, v_seen,
     v_added, v_dropped, v_restored, v_kept, v_rebuilt, p_drops_from, coalesce(p_detail, ''))
  returning * into v_run;

  return v_run;
end;
$$;
