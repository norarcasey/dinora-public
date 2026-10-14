-- Plaid as a second bank source (BANK-07), for what SimpleFIN does not reach: the Harbor
-- mortgage and the Lakeside Bank accounts, linked in production on 25 Sep (BANK-06).
--
-- Only the two lists of known sources change. `bank_store` already takes its source as an
-- argument and scopes every step to it — the upsert, the drops, the readings and the
-- rebuilt days — so a Plaid night can neither mark a SimpleFIN transaction dropped nor
-- rebuild a SimpleFIN account, and needs no new function.

alter table public.accounts drop constraint accounts_source_known;
alter table public.accounts
  add constraint accounts_source_known check (source in ('simplefin', 'monarch', 'plaid'));

alter table public.bank_pulls drop constraint bank_pulls_source_known;
alter table public.bank_pulls
  add constraint bank_pulls_source_known check (source in ('simplefin', 'plaid'));

-- `monarch_store` as before (20260924230000), with two changes so Monarch's years of
-- Lakeside Bank history land on the accounts Plaid now reads, rather than beside them:
--
--   * a `link` may name a Plaid account as well as a SimpleFIN one. Plaid's account ids and
--     the Bridge's are both opaque and long; a collision would join one Monarch account to
--     two, and is not guarded against.
--   * linking an account that was imported as history only retires that copy.
create or replace function public.monarch_store(p_user uuid, p_payload jsonb)
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
     or (a.link is not null and acc.source in ('simplefin', 'plaid') and acc.source_id = a.link
         and acc.currency = a.currency));

  -- A link to nothing, or to an account the bank has not given a day of history yet, is
  -- refused whole: filling "the days before" an account with no days would fill all of them.
  select string_agg(coalesce(t.link, t.monarch_name), ', ') into v_missing
  from pg_temp.monarch_targets t
  where t.account_id is null or (t.link is not null and t.before is null);
  if v_missing is not null then
    raise exception 'monarch_store: no bank account with history for link(s) %', v_missing;
  end if;

  -- An account imported as history only and linked now, because a bank reaches it at last,
  -- retires its history-only copy: the days and transactions below go onto the bank's
  -- account instead, and two live copies would count it twice in net worth. Marked deleted,
  -- never removed (invariant 2). Undoing a link is by hand: a mapping put back to `history`
  -- is refused below, since the lookup passes over a deleted account.
  update public.balance_snapshots s set deleted_at = now()
  from public.accounts acc
  join pg_temp.monarch_targets t
    on t.link is not null and acc.source = 'monarch' and acc.source_id = t.monarch_name
  where acc.user_id = p_user and s.account_id = acc.id and s.deleted_at is null;
  update public.transactions x set deleted_at = now()
  from public.accounts acc
  join pg_temp.monarch_targets t
    on t.link is not null and acc.source = 'monarch' and acc.source_id = t.monarch_name
  where acc.user_id = p_user and x.account_id = acc.id and x.deleted_at is null;
  update public.accounts acc set deleted_at = now()
  from pg_temp.monarch_targets t
  where t.link is not null and acc.user_id = p_user and acc.source = 'monarch'
    and acc.source_id = t.monarch_name and acc.deleted_at is null;

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
