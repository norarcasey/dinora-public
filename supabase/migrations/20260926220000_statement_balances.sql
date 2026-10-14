-- A lender's statement (ACCT-20): an account's balances copied from the lender's own record,
-- for the days before anything else Dinora holds for it. Loaded by `pnpm statement:import` from
-- a file on the laptop; nothing here reaches the lender.
--
-- Found 26 Sep 2026: the Harbor mortgage reached Dinora through Plaid on 25 Sep 2026 and through
-- Monarch from 15 May 2026, while the apartment it bought has values from Jan 2025. Harbor's own
-- transaction history gives the unpaid principal after every payment back to Apr 2023, which
-- is the only record of the loan before Monarch read it.
--
-- The same rules as Monarch's history (ACCT-05), so a statement can never change what the bank
-- or Monarch said:
--
--   * Its days are marked: `balance_snapshots.kind = 'statement'`.
--   * It fills only the days before the account's first day of any other kind. That day only
--     moves earlier, so a second import with the same file draws the same line.
--   * Upserts on the day, writing only where a figure changed, so a second import writes
--     nothing and says so.

alter table public.balance_snapshots drop constraint balance_snapshots_kind_known;
alter table public.balance_snapshots
  add constraint balance_snapshots_kind_known
  check (kind in ('read', 'rebuilt', 'monarch', 'statement'));

-- One account's statement, in one transaction. `p_days` is [{ on_date, balance_minor }], each
-- the balance at the end of that day in the account's own sign (a loan owed is negative), in
-- its own currency. Returns counts, never an amount (invariant 4).
create function public.statement_store(p_user uuid, p_account uuid, p_days jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_currency text;
  v_before date;
  v_added integer;
  v_changed integer;
  v_left integer;
begin
  select a.currency into v_currency
  from public.accounts a
  where a.id = p_account and a.user_id = p_user and a.deleted_at is null;
  if v_currency is null then
    raise exception 'statement_store: no live account %', p_account;
  end if;

  select min(s.on_date) into v_before
  from public.balance_snapshots s
  where s.account_id = p_account and s.kind <> 'statement' and s.deleted_at is null;
  -- As `monarch_store` refuses: "the days before" an account with none would be all of them.
  if v_before is null then
    raise exception 'statement_store: account % has no history to fill before', p_account;
  end if;

  with incoming as (
    select d.on_date, d.balance_minor
    from jsonb_to_recordset(p_days) as d (on_date date, balance_minor bigint)
  ), written as (
    insert into public.balance_snapshots
      (user_id, account_id, on_date, kind, currency, balance_minor, as_of)
    select p_user, p_account, i.on_date, 'statement', v_currency, i.balance_minor,
           least((i.on_date + 1)::timestamp at time zone 'UTC', now())
    from incoming i
    where i.on_date < v_before
    on conflict (user_id, account_id, on_date) do update set
      balance_minor = excluded.balance_minor
    where public.balance_snapshots.kind = 'statement'
      and public.balance_snapshots.balance_minor is distinct from excluded.balance_minor
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
  into v_added, v_changed from written;

  select count(*) into v_left
  from jsonb_to_recordset(p_days) as d (on_date date)
  where d.on_date >= v_before;

  return jsonb_build_object(
    'days_added', v_added,
    'days_changed', v_changed,
    'days_left_to_others', v_left,
    'fills_before', v_before);
end;
$$;

revoke all on function public.statement_store(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.statement_store(uuid, uuid, jsonb) to service_role;
