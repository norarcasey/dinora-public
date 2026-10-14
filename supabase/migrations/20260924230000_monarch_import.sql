-- Monarch's history (ACCT-05): the transactions and daily balances Monarch kept before
-- Dinora existed, loaded once from its CSV export by `pnpm monarch:import`, and safe to load
-- again. Nothing here reaches Monarch; the files are read on the laptop.
--
-- Three rules, each so an import can never change what the bank said:
--
--   * Imported rows are marked. A transaction carries `origin = 'monarch'`, a day's balance
--     `kind = 'monarch'`, and an account Dinora has no bank for `source = 'monarch'`.
--     `bank_store` rebuilds and marks drops from `origin = 'bank'` only: otherwise the next
--     night would walk a card's balance back to 2023 through Monarch's rows, and would mark
--     every one of them dropped, since the Bridge never reports them.
--   * For an account Dinora reads from a bank, Monarch fills only the days before Dinora's
--     own history of it begins — its first `read` or `rebuilt` day. The bank's row wins
--     wherever both exist. That day only moves earlier as history is kept, so a second
--     import with the same files draws the same line.
--   * Upserts on Monarch's own ids, writing only where a value changed, so a second import
--     with the same files writes nothing and says so.
--
-- Monarch's `Merchant` is the payee, `Original Statement` the description, `Notes` the memo,
-- and its category is kept as `source_category`: the first guess `BUD-01` starts from, not
-- Dinora's category.

alter table public.accounts drop constraint accounts_source_known;
alter table public.accounts
  add constraint accounts_source_known check (source in ('simplefin', 'monarch'));

alter table public.transactions
  add column origin text not null default 'bank',
  add column source_category text,
  add constraint transactions_origin_known check (origin in ('bank', 'monarch')),
  add constraint transactions_source_category_length
    check (char_length(coalesce(source_category, '')) <= 500);

alter table public.balance_snapshots drop constraint balance_snapshots_kind_known;
alter table public.balance_snapshots
  add constraint balance_snapshots_kind_known check (kind in ('read', 'rebuilt', 'monarch'));

-- One import, or one account of one, in one transaction. The payload is built by
-- `packages/core/src/monarch.ts` from the files and the mapping Nora confirmed:
--
--   accounts:     [{ monarch_name, link, currency, balance_minor, balance_on }]
--                 `link` is the Bridge's id of the account it is, or null for history only
--   transactions: [{ account, id, on_date, amount_minor, payee, description, memo, category }]
--   balances:     [{ account, on_date, balance_minor }]
--
-- Returns counts, never an amount or a payee (invariant 4). `matched` and `differed` compare
-- Monarch's balance with Dinora's own on the days both have, which is the second opinion
-- `ACCT-03` asked for on its rebuilt days.
create function public.monarch_store(p_user uuid, p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_missing text;
  v_accounts_added integer;
  v_accounts_changed integer;
  v_tx_added integer;
  v_tx_changed integer;
  v_tx_before integer;
  v_days_added integer;
  v_days_changed integer;
  v_days_before integer;
  v_matched integer;
  v_differed integer;
begin
  -- Accounts Dinora has no bank for, as Monarch's name. Balance and date are its last day's.
  with written as (
    insert into public.accounts
      (user_id, source, source_id, institution, name, currency, balance_minor, balance_at)
    select p_user, 'monarch', a.monarch_name, 'Monarch', a.monarch_name, a.currency,
           a.balance_minor, least((a.balance_on + 1)::timestamp at time zone 'UTC', now())
    from jsonb_to_recordset(p_payload -> 'accounts') as a (
      monarch_name text, link text, currency text, balance_minor bigint, balance_on date)
    where a.link is null
    on conflict (user_id, source, source_id) do update set
      currency = excluded.currency,
      balance_minor = excluded.balance_minor,
      balance_at = excluded.balance_at
    where public.accounts.currency is distinct from excluded.currency
       or public.accounts.balance_minor is distinct from excluded.balance_minor
       or (public.accounts.balance_at at time zone 'UTC')::date
          <> (excluded.balance_at at time zone 'UTC')::date
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
  into v_accounts_added, v_accounts_changed from written;

  -- Every account in the payload, resolved once. `before` is the first day Dinora's own
  -- history covers, and null for an account only Monarch knows.
  if to_regclass('pg_temp.monarch_targets') is not null then
    drop table pg_temp.monarch_targets;
  end if;
  create temporary table monarch_targets on commit drop as
  select a.monarch_name, a.link, acc.id as account_id, acc.currency,
         case when a.link is null then null else (
           select min(s.on_date) from public.balance_snapshots s
           where s.account_id = acc.id and s.kind in ('read', 'rebuilt')
             and s.deleted_at is null) end as before
  from jsonb_to_recordset(p_payload -> 'accounts') as a (
    monarch_name text, link text, currency text)
  left join public.accounts acc
    on acc.user_id = p_user
   and acc.deleted_at is null
   and ((a.link is null and acc.source = 'monarch' and acc.source_id = a.monarch_name)
     or (a.link is not null and acc.source = 'simplefin' and acc.source_id = a.link
         and acc.currency = a.currency));

  -- A link to nothing, or to an account the bank has not given a day of history yet, is
  -- refused whole: filling "the days before" an account with no days would fill all of them.
  select string_agg(coalesce(t.link, t.monarch_name), ', ') into v_missing
  from pg_temp.monarch_targets t
  where t.account_id is null or (t.link is not null and t.before is null);
  if v_missing is not null then
    raise exception 'monarch_store: no bank account with history for link(s) %', v_missing;
  end if;

  with incoming as (
    select t.account_id, t.before, x.*
    from jsonb_to_recordset(p_payload -> 'transactions') as x (
      account text, id text, on_date date, amount_minor bigint, payee text,
      description text, memo text, category text)
    join pg_temp.monarch_targets t on t.monarch_name = x.account
  ), written as (
    insert into public.transactions
      (user_id, account_id, source_id, origin, posted_at, amount_minor, description, payee,
       memo, source_category, pending)
    select p_user, i.account_id, 'monarch:' || i.id, 'monarch',
           i.on_date::timestamp at time zone 'UTC' + interval '12 hours', i.amount_minor,
           coalesce(i.description, ''), i.payee, i.memo, i.category, false
    from incoming i
    where i.before is null or i.on_date < i.before
    on conflict (user_id, account_id, source_id) do update set
      posted_at = excluded.posted_at,
      amount_minor = excluded.amount_minor,
      description = excluded.description,
      payee = excluded.payee,
      memo = excluded.memo,
      source_category = excluded.source_category
    where public.transactions.origin = 'monarch'
      and (public.transactions.posted_at, public.transactions.amount_minor,
           public.transactions.description, public.transactions.payee,
           public.transactions.memo, public.transactions.source_category)
          is distinct from
          (excluded.posted_at, excluded.amount_minor, excluded.description, excluded.payee,
           excluded.memo, excluded.source_category)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
  into v_tx_added, v_tx_changed from written;

  select count(*) into v_tx_before
  from jsonb_to_recordset(p_payload -> 'transactions') as x (account text, on_date date)
  join pg_temp.monarch_targets t on t.monarch_name = x.account
  where t.before is not null and x.on_date >= t.before;

  with incoming as (
    select t.account_id, t.currency, t.before, b.on_date, b.balance_minor
    from jsonb_to_recordset(p_payload -> 'balances') as b (
      account text, on_date date, balance_minor bigint)
    join pg_temp.monarch_targets t on t.monarch_name = b.account
  ), written as (
    insert into public.balance_snapshots
      (user_id, account_id, on_date, kind, currency, balance_minor, as_of)
    select p_user, i.account_id, i.on_date, 'monarch', i.currency, i.balance_minor,
           least((i.on_date + 1)::timestamp at time zone 'UTC', now())
    from incoming i
    where i.before is null or i.on_date < i.before
    on conflict (user_id, account_id, on_date) do update set
      currency = excluded.currency,
      balance_minor = excluded.balance_minor
    where public.balance_snapshots.kind = 'monarch'
      and (public.balance_snapshots.currency, public.balance_snapshots.balance_minor)
          is distinct from (excluded.currency, excluded.balance_minor)
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
  into v_days_added, v_days_changed from written;

  select count(*),
         count(*) filter (where s.balance_minor = b.balance_minor),
         count(*) filter (where s.balance_minor <> b.balance_minor)
  into v_days_before, v_matched, v_differed
  from jsonb_to_recordset(p_payload -> 'balances') as b (
    account text, on_date date, balance_minor bigint)
  join pg_temp.monarch_targets t on t.monarch_name = b.account
  join public.balance_snapshots s
    on s.account_id = t.account_id and s.on_date = b.on_date
   and s.kind in ('read', 'rebuilt') and s.deleted_at is null
  where t.before is not null and b.on_date >= t.before;

  return jsonb_build_object(
    'accounts_added', v_accounts_added,
    'accounts_changed', v_accounts_changed,
    'transactions_added', v_tx_added,
    'transactions_changed', v_tx_changed,
    'transactions_left_to_bank', v_tx_before,
    'days_added', v_days_added,
    'days_changed', v_days_changed,
    'days_left_to_bank', v_days_before,
    'days_matched', v_matched,
    'days_differed', v_differed);
end;
$$;

revoke all on function public.monarch_store(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.monarch_store(uuid, jsonb) to service_role;

-- `bank_store` as before (20260924200000), reading the bank's own rows only: the rebuilt days
-- walk back through `origin = 'bank'` transactions, and only those can be marked dropped.
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
      and x.origin = 'bank'
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
