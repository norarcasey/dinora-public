-- New transactions from Plaid (BANK-14): `/transactions/sync` answers with what changed since
-- a cursor, so the cursor is kept here, and `bank_store` learns the two things a sync sends
-- that a SimpleFIN window does not: the transactions Plaid removed, and where each item got to.

-- Where each item's sync got to. Not a credential — it reads nothing without the item's
-- access token, which lives only in Vercel's environment — but it is tied to one, so she is
-- granted nothing on it: the policy says whose row it is, and the job is the only reader.
create table public.bank_cursors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  source text not null,
  -- The aggregator's id for the linked item: Plaid's `item_id`, which outlives a re-link.
  item text not null,
  cursor text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint bank_cursors_user_id_id_key unique (user_id, id),
  constraint bank_cursors_user_source_item_key unique (user_id, source, item),
  constraint bank_cursors_source_known check (source in ('plaid')),
  constraint bank_cursors_item_length check (char_length(item) between 1 and 200),
  constraint bank_cursors_cursor_length check (char_length(cursor) between 1 and 2000)
);

create index bank_cursors_user_live_idx
  on public.bank_cursors (user_id, created_at)
  where deleted_at is null;

create trigger bank_cursors_set_updated_at
  before update on public.bank_cursors
  for each row execute function public.set_updated_at();

create trigger bank_cursors_freeze_user_id
  before update on public.bank_cursors
  for each row execute function public.freeze_user_id();

alter table public.bank_cursors enable row level security;
alter table public.bank_cursors force row level security;

create policy bank_cursors_select_own on public.bank_cursors
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.bank_cursors from authenticated;
grant select, insert, update on table public.bank_cursors to service_role;

-- `bank_store` as before (20260924230000), with three changes:
--
--   * a transaction dated on a day Monarch holds for its account is not stored. Monarch's
--     history was moved onto the Plaid card on 26 Sep, up to 24 Sep, and Plaid's first sync
--     answers with 90 days, so the two overlap for months; Monarch fills only the days before
--     the bank's (`monarch_store`), and this is the same rule from the bank's side. The day
--     between them, 25 Sep, Monarch did not hold, so Plaid's rows fill it. A Bridge account
--     never meets this: its Monarch days end where its own rebuilt days begin.
--   * `removed` in the payload names transactions the aggregator says are gone — Plaid's,
--     most often a pending one that posted under a new id — and they are marked dropped,
--     never deleted (invariant 2), counted with the drops a window finds by absence.
--   * `cursors` in the payload are written with the rows, in one transaction, so a cursor is
--     never ahead of what was stored.
--
-- A payload without the two keys, as the SimpleFIN night sends, changes nothing new.
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
  v_removed integer;
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
  -- `monarchs` marks one on a day Monarch holds: not stored, but still seen by the drops
  -- below, so leaving it out cannot make the bank's own row look missing.
  if to_regclass('pg_temp.bank_incoming') is not null then
    drop table pg_temp.bank_incoming;
  end if;
  create temporary table bank_incoming on commit drop as
  select acc.id as account_id, t.source_id, t.posted_at, t.transacted_at, t.amount_minor,
         t.description, t.payee, t.memo, t.pending,
         exists (
           select 1 from public.balance_snapshots s
           where s.account_id = acc.id
             and s.kind = 'monarch'
             and s.deleted_at is null
             and s.on_date = (coalesce(t.posted_at, t.transacted_at) at time zone 'UTC')::date
         ) as monarchs
  from jsonb_to_recordset(p_payload -> 'transactions') as t (
    account_source_id text, source_id text, posted_at timestamptz, transacted_at timestamptz,
    amount_minor bigint, description text, payee text, memo text, pending boolean)
  join public.accounts acc
    on acc.user_id = p_user and acc.source = p_source and acc.source_id = t.account_source_id;

  select count(*) into v_restored
  from public.transactions x
  join pg_temp.bank_incoming i on i.account_id = x.account_id and i.source_id = x.source_id
  where x.user_id = p_user and x.dropped_at is not null and not i.monarchs;

  with written as (
    insert into public.transactions
      (user_id, account_id, source_id, posted_at, transacted_at, amount_minor,
       description, payee, memo, pending)
    select p_user, i.account_id, i.source_id, i.posted_at, i.transacted_at, i.amount_minor,
           i.description, i.payee, i.memo, i.pending
    from pg_temp.bank_incoming i
    where not i.monarchs
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
      and x.origin = 'bank'
      -- Neither date means pending and undated, which is to say current.
      and coalesce(x.posted_at, x.transacted_at, now()) >= p_drops_from
      and not exists (
        select 1 from pg_temp.bank_incoming i where i.account_id = x.account_id and i.source_id = x.source_id);
    get diagnostics v_dropped = row_count;
  end if;

  -- What the aggregator said is gone, among this source's accounts. Its ids are its own
  -- and unique across accounts, so the account is not needed to find one.
  update public.transactions x set dropped_at = now()
  from public.accounts acc
  where acc.id = x.account_id
    and acc.user_id = p_user
    and acc.source = p_source
    and x.user_id = p_user
    and x.dropped_at is null
    and x.deleted_at is null
    and x.origin = 'bank'
    and x.source_id in (
      select r #>> '{}' from jsonb_array_elements(p_payload -> 'removed') as r);
  get diagnostics v_removed = row_count;
  v_dropped := v_dropped + v_removed;

  insert into public.bank_cursors (user_id, source, item, cursor)
  select p_user, p_source, c.item, c.cursor
  from jsonb_to_recordset(p_payload -> 'cursors') as c (item text, cursor text)
  on conflict (user_id, source, item) do update set cursor = excluded.cursor
  where public.bank_cursors.cursor is distinct from excluded.cursor;

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
  -- answer, a bundle older than this migration, or Plaid, whose sync covers no window —
  -- only from the earliest transaction: before it, what is missing cannot be told from what
  -- never happened. A day Monarch holds is never rebuilt over; see the conflict clause.
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
      and x.origin = 'bank'
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
