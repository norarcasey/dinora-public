-- Put together from the app (BANK-17): the Monarch copy of an account and the bank account
-- that now reads it, joined by a tap on the home screen's *may be counted twice* flag instead
-- of a command on the Mac (BANK-15).
--
-- The import joins a pair by storing Monarch's rows again from its CSVs, which are on the
-- laptop. The server has no CSVs, so this moves the rows the copy already holds:
--
--   * Moved, not copied. A transaction keeps its id, so the category she chose for it goes
--     with it: a copy would leave her choice on the retired row, and service_role writes none
--     of her choices (BUD-01). Nothing is deleted (invariant 2); what moves is `account_id`.
--   * Only what `monarch_store` would have put there: Monarch's days before the bank's own
--     history begins (its first `read` or `rebuilt` day), and Monarch's transactions on those
--     days. A row whose place on the bank's account is taken — a statement day, a transaction
--     with the same Monarch id, both keys counting deleted rows — stays on the copy.
--   * Everything left on the copy is retired with it, as `monarch_store` retires one.
--   * The link is kept as a decision in the same transaction (ACCT-18), so the mapping and the
--     rows never disagree: the next CSV import links the same pair, finds every row already in
--     place, and writes nothing. service_role gains SELECT and INSERT on `monarch_decisions`
--     for this and nothing else there.
--
-- Refused, with a reason the page shows, wherever `linkPair` (packages/core/src/monarch.ts)
-- refuses the command: not a live Monarch copy, not a live bank account, two currencies, a
-- bank account with no day of history, a Monarch account the mapping does not have as
-- `history`, or a bank account another Monarch account already links to.

grant select, insert on table public.monarch_decisions to service_role;

create function public.monarch_join(p_user uuid, p_copy uuid, p_bank uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_copy public.accounts;
  v_bank public.accounts;
  v_before date;
  v_goes text;
  v_taken text;
  v_days_moved integer;
  v_days_left integer;
  v_tx_moved integer;
  v_tx_left integer;
begin
  select * into v_copy from public.accounts
  where id = p_copy and user_id = p_user
  for update;
  if not found or v_copy.source <> 'monarch' then
    raise exception 'monarch_join: not_monarch';
  end if;
  if v_copy.deleted_at is not null then
    raise exception 'monarch_join: already_joined';
  end if;

  select * into v_bank from public.accounts
  where id = p_bank and user_id = p_user
  for update;
  if not found or v_bank.source not in ('simplefin', 'plaid') then
    raise exception 'monarch_join: not_bank';
  end if;
  if v_bank.deleted_at is not null then
    raise exception 'monarch_join: bank_deleted';
  end if;
  if v_bank.currency <> v_copy.currency then
    raise exception 'monarch_join: currency';
  end if;

  select min(s.on_date) into v_before
  from public.balance_snapshots s
  where s.account_id = v_bank.id and s.kind in ('read', 'rebuilt') and s.deleted_at is null;
  if v_before is null then
    raise exception 'monarch_join: no_history';
  end if;

  -- Where the mapping sends each Monarch account now: its latest live decision (ACCT-18).
  select d.goes into v_goes
  from public.monarch_decisions d
  where d.user_id = p_user and d.monarch_name = v_copy.source_id and d.deleted_at is null
  order by d.decided_at desc
  limit 1;
  if v_goes is distinct from 'history' then
    raise exception 'monarch_join: not_history';
  end if;

  select latest.monarch_name into v_taken
  from (
    select distinct on (d.monarch_name) d.monarch_name, d.goes, d.link
    from public.monarch_decisions d
    where d.user_id = p_user and d.deleted_at is null
    order by d.monarch_name, d.decided_at desc
  ) latest
  where latest.goes = 'link' and latest.link = v_bank.source_id
    and latest.monarch_name <> v_copy.source_id
  limit 1;
  if v_taken is not null then
    raise exception 'monarch_join: taken';
  end if;

  update public.balance_snapshots s set account_id = v_bank.id
  where s.account_id = v_copy.id and s.user_id = p_user
    and s.kind = 'monarch' and s.deleted_at is null and s.on_date < v_before
    and not exists (
      select 1 from public.balance_snapshots b
      where b.user_id = p_user and b.account_id = v_bank.id and b.on_date = s.on_date);
  get diagnostics v_days_moved = row_count;

  update public.transactions x set account_id = v_bank.id
  where x.account_id = v_copy.id and x.user_id = p_user
    and x.origin = 'monarch' and x.deleted_at is null
    and (x.posted_at at time zone 'UTC')::date < v_before
    and not exists (
      select 1 from public.transactions b
      where b.user_id = p_user and b.account_id = v_bank.id and b.source_id = x.source_id);
  get diagnostics v_tx_moved = row_count;

  update public.balance_snapshots s set deleted_at = now()
  where s.account_id = v_copy.id and s.user_id = p_user and s.deleted_at is null;
  get diagnostics v_days_left = row_count;
  update public.transactions x set deleted_at = now()
  where x.account_id = v_copy.id and x.user_id = p_user and x.deleted_at is null;
  get diagnostics v_tx_left = row_count;
  update public.accounts set deleted_at = now() where id = v_copy.id;

  insert into public.monarch_decisions
    (user_id, monarch_name, goes, link, link_is, why)
  values
    (p_user, v_copy.source_id, 'link', v_bank.source_id,
     v_bank.institution || ' · ' || v_bank.name,
     'counted twice on the home screen, put together there (BANK-17)');

  return jsonb_build_object(
    'days_moved', v_days_moved,
    'days_left', v_days_left,
    'transactions_moved', v_tx_moved,
    'transactions_left', v_tx_left);
end;
$$;

revoke all on function public.monarch_join(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.monarch_join(uuid, uuid, uuid) to service_role;
