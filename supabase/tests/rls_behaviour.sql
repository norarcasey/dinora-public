-- Behavioural invariants. LOCAL ONLY: these switch roles and write rows, and they rely on
-- the two users in supabase/seed.sql, which exist in no real project.
--
-- **No transaction control in this file.** scripts/db/verify-schema.ts feeds it to psql
-- wrapped in a transaction that is always rolled back, so nothing here can commit and the
-- check is safe to repeat. It refuses to run the file if it finds a `begin;`, `commit;`
-- or `rollback;` at the start of a line — Nora Bene's did its own and rolled back part way
-- through, and every section appended after that point committed. A second run then died
-- on a duplicate key: a check that was true only the first time (OPS-14 there).
--
-- The structural half — RLS forced, policies present, grants — is schema_invariants.sql,
-- which also runs against production.

\set ON_ERROR_STOP on

-- Every owned table refuses a row made out to somebody else.
--
-- Generic, so it covers tables written after it. It supplies only user_id and leaves every
-- other column to its default, which is sound because Postgres applies the RLS insert check
-- before NOT NULL and CHECK constraints: the refusal names the policy, not a missing column.
-- Measured on the local stack when this layer was built (SKL-03).
do $$
declare
  t record;
  checked integer := 0;
begin
  for t in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
      )
    order by c.relname
  loop
    begin
      perform set_config('request.jwt.claims',
        '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
      set local role authenticated;
      execute format('insert into public.%I (user_id) values (%L)',
        t.relname, '22222222-2222-2222-2222-222222222222');
      raise exception '%: a row owned by another user was inserted', t.relname;
    exception
      when insufficient_privilege then
        checked := checked + 1;
    end;
  end loop;

  if checked = 0 then
    raise notice 'NONE  no owned tables yet; nothing to insert into';
  else
    raise notice 'PASS  % owned table(s) refuse a row made out to another user', checked;
  end if;
end;
$$;

-- Per-table checks go below, one block per rule a policy or constraint is meant to enforce
-- that the generic check cannot see. The shape, for a table from the pattern:
--
--   insert into public.things (id, user_id, title)
--   values ('99999999-0000-0000-0000-000000000001',
--           '22222222-2222-2222-2222-222222222222', 'the other user''s');
--
--   do $$
--   declare
--     visible integer;
--   begin
--     perform set_config('request.jwt.claims',
--       '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
--     set local role authenticated;
--     select count(*) into visible from public.things
--     where user_id = '22222222-2222-2222-2222-222222222222';
--     if visible <> 0 then
--       raise exception 'RLS leaked % things across users', visible;
--     end if;
--     raise notice 'PASS  things: another user''s rows are invisible';
--     reset role;
--   end;
--   $$;
--
-- The row is inserted as postgres, which bypasses RLS, so there is something to hide; a
-- count of zero over a table with no rows in it would pass and prove nothing.

-- Bank rows: another user's are invisible, and the owner can read hers but not change them.
-- The sync writes as service_role; nothing the app does alters what the bank said (BANK-01).

insert into public.accounts (id, user_id, source, source_id, currency, balance_minor, balance_at)
values
  ('99999999-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'simplefin', 'other', 'USD', 0, now()),
  ('99999999-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'simplefin', 'own', 'USD', 0, now());

insert into public.transactions (user_id, account_id, source_id, amount_minor)
values
  ('22222222-2222-2222-2222-222222222222', '99999999-0000-0000-0000-000000000001', 't', 0),
  ('11111111-1111-1111-1111-111111111111', '99999999-0000-0000-0000-000000000002', 't', 0);

do $$
declare
  visible integer;
  changed integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;

  select count(*) into visible from public.accounts
  where user_id = '22222222-2222-2222-2222-222222222222';
  if visible <> 0 then
    raise exception 'RLS leaked % accounts across users', visible;
  end if;
  select count(*) into visible from public.transactions
  where user_id = '22222222-2222-2222-2222-222222222222';
  if visible <> 0 then
    raise exception 'RLS leaked % transactions across users', visible;
  end if;

  select count(*) into visible from public.accounts;
  if visible <> 1 then
    raise exception 'the owner sees % of her accounts, not 1', visible;
  end if;

  begin
    update public.accounts set balance_minor = 1;
    get diagnostics changed = row_count;
    raise exception 'the owner changed % account row(s) the bank reported', changed;
  exception
    when insufficient_privilege then null;
  end;

  raise notice 'PASS  accounts, transactions: another user''s are invisible, her own are read-only';
  reset role;
end;
$$;

-- The nightly pull's writer (BANK-02): running it twice reconciles rather than duplicates, a
-- transaction the bank stops reporting is marked and not deleted, one it reports again is
-- un-marked, and nothing older than the date it was given is touched.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  accounts jsonb := jsonb_build_array(jsonb_build_object(
    'source_id', 'nightly', 'institution', 'Bank', 'name', 'Card', 'currency', 'USD',
    'balance_minor', -100, 'available_minor', null, 'balance_at', now()));
  recent jsonb := jsonb_build_object(
    'account_source_id', 'nightly', 'source_id', 'recent', 'posted_at', now() - interval '2 days',
    'transacted_at', null, 'amount_minor', -100, 'description', 'd', 'payee', null,
    'memo', null, 'pending', false);
  pending jsonb := jsonb_build_object(
    'account_source_id', 'nightly', 'source_id', 'pending', 'posted_at', null,
    'transacted_at', null, 'amount_minor', -100, 'description', 'd', 'payee', null,
    'memo', null, 'pending', true);
  old jsonb := jsonb_build_object(
    'account_source_id', 'nightly', 'source_id', 'old', 'posted_at', now() - interval '80 days',
    'transacted_at', null, 'amount_minor', -100, 'description', 'd', 'payee', null,
    'memo', null, 'pending', false);
  since constant timestamptz := now() - interval '60 days';
  run public.bank_pulls;
  n integer;
begin
  set local role service_role;

  run := public.bank_store(owner, 'simplefin',
    jsonb_build_object('accounts', accounts, 'transactions', jsonb_build_array(recent, pending, old)),
    now(), 2, since, '');
  if (run.added, run.transactions, run.dropped) is distinct from (3, 3, 0) then
    raise exception 'first store: added %, seen %, dropped %, not 3, 3, 0',
      run.added, run.transactions, run.dropped;
  end if;

  run := public.bank_store(owner, 'simplefin',
    jsonb_build_object('accounts', accounts, 'transactions', jsonb_build_array(recent, pending, old)),
    now(), 2, since, '');
  select count(*) into n from public.transactions x join public.accounts a on a.id = x.account_id
  where a.user_id = owner and a.source_id = 'nightly';
  if run.added <> 0 or n <> 3 then
    raise exception 'a second identical store added % and left % rows, not 0 and 3', run.added, n;
  end if;

  -- The pending one posted under a new id, and the old one aged out of the window.
  run := public.bank_store(owner, 'simplefin',
    jsonb_build_object('accounts', accounts, 'transactions', jsonb_build_array(recent)),
    now(), 2, since, '');
  if run.dropped <> 1 then
    raise exception 'marked % dropped, not 1 (the pending one; the old one is before the date)',
      run.dropped;
  end if;
  select count(*) into n from public.transactions
  where user_id = owner and dropped_at is not null and source_id = 'pending';
  if n <> 1 then
    raise exception 'the pending transaction was not kept and marked';
  end if;

  -- An incomplete pull says not to look: nothing is marked.
  run := public.bank_store(owner, 'simplefin',
    jsonb_build_object('accounts', accounts, 'transactions', '[]'::jsonb),
    now(), 2, null, 'bridge error');
  if run.dropped <> 0 then
    raise exception 'a pull told not to mark drops marked %', run.dropped;
  end if;

  run := public.bank_store(owner, 'simplefin',
    jsonb_build_object('accounts', accounts, 'transactions', jsonb_build_array(recent, pending)),
    now(), 2, since, '');
  if run.restored <> 1 then
    raise exception 'restored %, not 1', run.restored;
  end if;
  select count(*) into n from public.transactions
  where user_id = owner and dropped_at is not null;
  if n <> 0 then
    raise exception '% transaction(s) still marked after the bank reported them again', n;
  end if;

  select count(*) into n from public.bank_pulls where user_id = owner and outcome = 'ok';
  if n <> 5 then
    raise exception '% run(s) recorded, not 5', n;
  end if;

  reset role;
  raise notice 'PASS  bank_store: reconciles, marks what the bank dropped, restores what returns';
end;
$$;

-- Only the system writes a pull. She can read her record of them and not change it.
do $$
declare
  visible integer;
begin
  insert into public.bank_pulls (user_id, source, outcome, started_at)
  values ('22222222-2222-2222-2222-222222222222', 'simplefin', 'ok', now());

  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;

  select count(*) into visible from public.bank_pulls
  where user_id = '22222222-2222-2222-2222-222222222222';
  if visible <> 0 then
    raise exception 'RLS leaked % pulls across users', visible;
  end if;

  begin
    perform public.bank_store('11111111-1111-1111-1111-111111111111', 'simplefin',
      '{"accounts":[],"transactions":[]}', now(), 0, null, '');
    raise exception 'authenticated called bank_store';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.bank_pulls set outcome = 'failed';
    raise exception 'the owner changed her pull record';
  exception
    when insufficient_privilege then null;
  end;

  reset role;
  raise notice 'PASS  bank_pulls: hers only, read-only; bank_store is service_role''s alone';
end;
$$;

-- A stored rate is what some total was converted at (ACCT-02, invariant 3). The job's
-- insert keeps the first rate for a date, nobody can change it afterwards, and she reads
-- only hers.
do $$
declare
  kept numeric;
  visible integer;
begin
  set local role service_role;
  insert into public.fx_rates (user_id, source, base, quote, rate_date, rate)
  values ('22222222-2222-2222-2222-222222222222', 'ecb', 'EUR', 'USD', '2000-01-03', '1.0090');
  -- What PostgREST sends for `Prefer: resolution=ignore-duplicates`.
  insert into public.fx_rates (user_id, source, base, quote, rate_date, rate)
  values ('22222222-2222-2222-2222-222222222222', 'ecb', 'EUR', 'USD', '2000-01-03', '2')
  on conflict (user_id, source, base, quote, rate_date) do nothing;
  select rate into kept from public.fx_rates
  where user_id = '22222222-2222-2222-2222-222222222222' and rate_date = '2000-01-03';
  if kept::text <> '1.0090' then
    raise exception 'the stored rate became %', kept;
  end if;

  begin
    update public.fx_rates set rate = 2;
    raise exception 'service_role changed a stored rate';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;

  select count(*) into visible from public.fx_rates
  where user_id = '22222222-2222-2222-2222-222222222222';
  if visible <> 0 then
    raise exception 'RLS leaked % rates across users', visible;
  end if;

  begin
    update public.fx_rates set rate = 2;
    raise exception 'the owner changed a stored rate';
  exception
    when insufficient_privilege then null;
  end;

  reset role;
  raise notice 'PASS  fx_rates: hers only; the first rate for a date is kept and never changed';
end;
$$;

-- Balance history (ACCT-03). A night keeps each account's reading on the bank's own day and
-- walks the days before the first one back through the settled transactions; a second
-- identical night writes nothing; a reading is never replaced by an older one or by a
-- rebuilt figure; an investment gets no rebuilt days; she reads only hers and changes none.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  card jsonb := jsonb_build_object(
    'source_id', 'history', 'institution', 'Bank', 'name', 'Card', 'currency', 'USD',
    'balance_minor', -10000, 'available_minor', null,
    'balance_at', '2026-09-25T09:00:00Z', 'holdings', 0);
  brokerage jsonb := jsonb_build_object(
    'source_id', 'brokerage', 'institution', 'Broker', 'name', 'Brokerage', 'currency', 'USD',
    'balance_minor', 500000, 'available_minor', null,
    'balance_at', '2026-09-25T09:00:00Z', 'holdings', 2);
  savings jsonb := jsonb_build_object(
    'source_id', 'savings', 'institution', 'Bank', 'name', 'Savings', 'currency', 'USD',
    'balance_minor', 70000, 'available_minor', null,
    'balance_at', '2026-09-25T09:00:00Z', 'holdings', 0);
  txs jsonb := jsonb_build_array(
    jsonb_build_object('account_source_id', 'history', 'source_id', 'h1',
      'posted_at', '2026-09-20T12:00:00Z', 'transacted_at', null, 'amount_minor', -3000,
      'description', 'd', 'payee', null, 'memo', null, 'pending', false),
    jsonb_build_object('account_source_id', 'history', 'source_id', 'h2',
      'posted_at', '2026-09-23T12:00:00Z', 'transacted_at', null, 'amount_minor', -2000,
      'description', 'd', 'payee', null, 'memo', null, 'pending', false),
    -- Posted on the reading's own day, before its time: the day before does not carry it.
    jsonb_build_object('account_source_id', 'history', 'source_id', 'h3',
      'posted_at', '2026-09-25T05:00:00Z', 'transacted_at', null, 'amount_minor', 1000,
      'description', 'd', 'payee', null, 'memo', null, 'pending', false),
    -- Pending: not in the bank's balance, so not walked back through.
    jsonb_build_object('account_source_id', 'history', 'source_id', 'h4',
      'posted_at', null, 'transacted_at', '2026-09-24T12:00:00Z', 'amount_minor', -500,
      'description', 'd', 'payee', null, 'memo', null, 'pending', true),
    jsonb_build_object('account_source_id', 'brokerage', 'source_id', 'b1',
      'posted_at', '2026-09-21T12:00:00Z', 'transacted_at', null, 'amount_minor', 100000,
      'description', 'd', 'payee', null, 'memo', null, 'pending', false));
  run public.bank_pulls;
  got text;
  n integer;
  visible integer;
begin
  set local role service_role;

  -- The pull says it holds everything from 18 Sep: the card goes back past its first
  -- transaction to then, and the idle savings account is flat to then.
  run := public.bank_store(owner, 'simplefin',
    jsonb_build_object('accounts', jsonb_build_array(card, brokerage, savings),
      'transactions', txs, 'history_from', '2026-09-18T09:00:00Z'),
    now(), 2, null, '');
  if (run.kept, run.rebuilt) is distinct from (3, 14) then
    raise exception 'first night kept % and rebuilt %, not 3 and 14', run.kept, run.rebuilt;
  end if;

  select string_agg(s.on_date || ' ' || s.kind || ' ' || s.balance_minor, ', ' order by s.on_date)
  into got
  from public.balance_snapshots s join public.accounts a on a.id = s.account_id
  where a.user_id = owner and a.source_id = 'history';
  if got is distinct from
     '2026-09-18 rebuilt -6000, 2026-09-19 rebuilt -6000, '
     '2026-09-20 rebuilt -9000, 2026-09-21 rebuilt -9000, 2026-09-22 rebuilt -9000, '
     '2026-09-23 rebuilt -11000, 2026-09-24 rebuilt -11000, 2026-09-25 read -10000' then
    raise exception 'the card''s history is %', got;
  end if;

  select count(*) into n
  from public.balance_snapshots s join public.accounts a on a.id = s.account_id
  where a.user_id = owner and a.source_id = 'savings' and s.kind = 'rebuilt'
    and s.balance_minor = 70000;
  if n <> 7 then
    raise exception 'the idle savings account has % flat rebuilt day(s), not 7', n;
  end if;

  select count(*) into n
  from public.balance_snapshots s join public.accounts a on a.id = s.account_id
  where a.user_id = owner and a.source_id = 'brokerage';
  if n <> 1 then
    raise exception 'the brokerage has % day(s), not its one reading', n;
  end if;

  run := public.bank_store(owner, 'simplefin',
    jsonb_build_object('accounts', jsonb_build_array(card, brokerage, savings),
      'transactions', txs, 'history_from', '2026-09-18T09:00:00Z'),
    now(), 2, null, '');
  if (run.kept, run.rebuilt) is distinct from (0, 0) then
    raise exception 'a second identical night kept % and rebuilt %', run.kept, run.rebuilt;
  end if;

  -- An older reading of the same day does not replace a newer one.
  run := public.bank_store(owner, 'simplefin',
    jsonb_build_object('accounts', jsonb_build_array(
      card || jsonb_build_object('balance_minor', -1, 'balance_at', '2026-09-25T08:00:00Z')),
      'transactions', txs),
    now(), 2, null, '');
  if run.kept <> 0 then
    raise exception 'an older reading replaced a newer one';
  end if;

  -- The next day's reading is kept, and the rebuilt days still hang from the first.
  run := public.bank_store(owner, 'simplefin',
    jsonb_build_object('accounts', jsonb_build_array(
      card || jsonb_build_object('balance_minor', -12000, 'balance_at', '2026-09-26T09:00:00Z')),
      'transactions', txs),
    now(), 2, null, '');
  if (run.kept, run.rebuilt) is distinct from (1, 0) then
    raise exception 'the next night kept % and rebuilt %, not 1 and 0', run.kept, run.rebuilt;
  end if;
  reset role;

  insert into public.balance_snapshots (user_id, account_id, on_date, kind, currency, balance_minor, as_of)
  values ('22222222-2222-2222-2222-222222222222', '99999999-0000-0000-0000-000000000001',
          '2026-09-25', 'read', 'USD', 0, now());

  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;

  select count(*) into visible from public.balance_snapshots
  where user_id = '22222222-2222-2222-2222-222222222222';
  if visible <> 0 then
    raise exception 'RLS leaked % balance snapshots across users', visible;
  end if;

  begin
    update public.balance_snapshots set balance_minor = 0;
    raise exception 'the owner changed a balance the bank reported';
  exception
    when insufficient_privilege then null;
  end;

  reset role;
  raise notice 'PASS  balance_snapshots: kept by the bank''s day, rebuilt before the first, hers and read-only';
end;
$$;

-- Account groups (ACCT-04), the first table she writes. She can set a group on her own
-- account and change it by setting it again, which is the app's upsert; she cannot point one
-- at somebody else's account, name a group that does not exist, or delete one; she sees only
-- hers; and the nightly job, which runs as service_role, cannot touch them at all.
insert into public.account_groups (user_id, account_id, kind)
values ('22222222-2222-2222-2222-222222222222', '99999999-0000-0000-0000-000000000001', 'card');

do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  own_account constant uuid := '99999999-0000-0000-0000-000000000002';
  n integer;
  got text;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;

  insert into public.account_groups (user_id, account_id, kind)
  values (owner, own_account, 'card')
  on conflict (user_id, account_id) do update set kind = excluded.kind;
  insert into public.account_groups (user_id, account_id, kind)
  values (owner, own_account, 'loan')
  on conflict (user_id, account_id) do update set kind = excluded.kind;

  select count(*), string_agg(kind, ',') into n, got from public.account_groups;
  if (n, got) is distinct from (1, 'loan') then
    raise exception 'after two choices she sees % group row(s): %', n, got;
  end if;

  begin
    insert into public.account_groups (user_id, account_id, kind)
    values (owner, '99999999-0000-0000-0000-000000000001', 'cash');
    raise exception 'a group was set on another user''s account';
  exception
    when foreign_key_violation then null;
  end;

  begin
    update public.account_groups set kind = 'house';
    raise exception 'a group outside the four was stored';
  exception
    when check_violation then null;
  end;

  begin
    delete from public.account_groups;
    raise exception 'the owner hard-deleted a group';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  set local role service_role;
  begin
    perform 1 from public.account_groups;
    raise exception 'service_role can read her groups';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'PASS  account_groups: hers only, set and reset by upsert, never deleted, not the job''s';
end;
$$;

-- Card terms (ACCT-10). She adds a figure, and a second for the same card sits beside the
-- first as history; she cannot rewrite a figure, only remove it with deleted_at; each kind
-- carries only its own columns, and a promo ends after it starts; she cannot point one at
-- somebody else's account or delete one; she sees only hers; the nightly job sees none.
insert into public.account_terms (user_id, account_id, kind, effective_on, amount_minor)
values ('22222222-2222-2222-2222-222222222222', '99999999-0000-0000-0000-000000000001',
  'credit_limit', '2026-01-01', 100000);

do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  own_account constant uuid := '99999999-0000-0000-0000-000000000002';
  n integer;
  first_id uuid;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;

  insert into public.account_terms (user_id, account_id, kind, effective_on, amount_minor)
  values (owner, own_account, 'credit_limit', '2026-01-01', 1000000);
  insert into public.account_terms (user_id, account_id, kind, effective_on, amount_minor)
  values (owner, own_account, 'credit_limit', '2026-06-01', 1500000);
  insert into public.account_terms (user_id, account_id, kind, effective_on, rate_bp, ends_on)
  values (owner, own_account, 'promo_apr', '2026-06-01', 0, '2027-06-01');

  select count(*) into n from public.account_terms;
  if n <> 3 then
    raise exception 'after three figures she sees % term row(s)', n;
  end if;
  select id into first_id from public.account_terms where effective_on = '2026-01-01';

  begin
    update public.account_terms set amount_minor = 1 where id = first_id;
    raise exception 'the owner rewrote a figure in place';
  exception
    when insufficient_privilege then null;
  end;

  update public.account_terms set deleted_at = now() where id = first_id;
  select count(*) into n from public.account_terms where deleted_at is null;
  if n <> 2 then
    raise exception 'removing a figure left % live row(s), not 2', n;
  end if;

  begin
    insert into public.account_terms (user_id, account_id, kind, effective_on, amount_minor)
    values (owner, '99999999-0000-0000-0000-000000000001', 'credit_limit', '2026-01-01', 1);
    raise exception 'a figure was set on another user''s account';
  exception
    when foreign_key_violation then null;
  end;

  begin
    insert into public.account_terms (user_id, account_id, kind, effective_on, amount_minor, rate_bp)
    values (owner, own_account, 'credit_limit', '2026-01-01', 1, 2499);
    raise exception 'a limit carrying a rate was stored';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.account_terms (user_id, account_id, kind, effective_on)
    values (owner, own_account, 'credit_limit', '2026-01-01');
    raise exception 'a limit with no amount was stored';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.account_terms (user_id, account_id, kind, effective_on, rate_bp)
    values (owner, own_account, 'promo_apr', '2026-01-01', 0);
    raise exception 'a promo with no end was stored';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.account_terms (user_id, account_id, kind, effective_on, rate_bp, ends_on)
    values (owner, own_account, 'promo_apr', '2026-06-01', 0, '2026-06-01');
    raise exception 'a promo ending the day it started was stored';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.account_terms (user_id, account_id, kind, effective_on, rate_bp)
    values (owner, own_account, 'purchase_apr', '2026-01-01', 10001);
    raise exception 'a rate past 100%% was stored';
  exception
    when check_violation then null;
  end;

  begin
    delete from public.account_terms;
    raise exception 'the owner hard-deleted a figure';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  set local role service_role;
  begin
    perform 1 from public.account_terms;
    raise exception 'service_role can read her figures';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'PASS  account_terms: hers only, added not rewritten, removed not deleted, shaped by kind, not the job''s';
end;
$$;

-- Monarch's history (ACCT-05). An import fills a linked account only before Dinora's own
-- first day of it, and an account with no bank whole; a second identical import writes
-- nothing; the bank's row wins where both have a day; the next night neither walks back
-- through an imported transaction nor marks one dropped; a link to nothing is refused; only
-- service_role may import.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  card jsonb := jsonb_build_object(
    'source_id', 'mcard', 'institution', 'Bank', 'name', 'Card', 'currency', 'USD',
    'balance_minor', -10000, 'available_minor', null,
    'balance_at', '2026-09-25T09:00:00Z', 'holdings', 0);
  night jsonb := jsonb_build_object(
    'accounts', jsonb_build_array(card),
    'transactions', jsonb_build_array(jsonb_build_object(
      'account_source_id', 'mcard', 'source_id', 'bank-1',
      'posted_at', '2026-09-23T12:00:00Z', 'transacted_at', null, 'amount_minor', -2000,
      'description', 'd', 'payee', null, 'memo', null, 'pending', false)),
    'history_from', '2026-09-22T09:00:00Z');
  accounts jsonb := jsonb_build_array(
    jsonb_build_object('monarch_name', 'Card (...1)', 'link', 'mcard', 'currency', 'USD',
      'balance_minor', -10000, 'balance_on', '2026-09-25'),
    jsonb_build_object('monarch_name', 'Old 401k', 'link', null, 'currency', 'USD',
      'balance_minor', 5000, 'balance_on', '2026-09-24'));
  txs jsonb := jsonb_build_array(
    -- Before the card's first rebuilt day, 22 Sep: imported.
    jsonb_build_object('account', 'Card (...1)', 'id', '1', 'on_date', '2026-09-20',
      'amount_minor', -700, 'payee', 'p', 'description', 'd', 'memo', null, 'category', 'c'),
    -- Inside the bank's own history: the bank's row stands for it.
    jsonb_build_object('account', 'Card (...1)', 'id', '2', 'on_date', '2026-09-23',
      'amount_minor', -2000, 'payee', 'p', 'description', 'd', 'memo', null, 'category', 'c'),
    -- A day Monarch has no balance for: a night walking back through it would rebuild 18 Sep.
    jsonb_build_object('account', 'Card (...1)', 'id', '4', 'on_date', '2026-09-18',
      'amount_minor', -100, 'payee', 'p', 'description', 'd', 'memo', null, 'category', 'c'),
    jsonb_build_object('account', 'Old 401k', 'id', '3', 'on_date', '2025-01-01',
      'amount_minor', 5000, 'payee', null, 'description', 'd', 'memo', null, 'category', null));
  balances jsonb := jsonb_build_array(
    jsonb_build_object('account', 'Card (...1)', 'on_date', '2026-09-20', 'balance_minor', -8700),
    jsonb_build_object('account', 'Card (...1)', 'on_date', '2026-09-21', 'balance_minor', -8000),
    -- The rebuilt 22 Sep is -8000 and 23 Sep is -10000: one agrees, one does not.
    jsonb_build_object('account', 'Card (...1)', 'on_date', '2026-09-22', 'balance_minor', -8000),
    jsonb_build_object('account', 'Card (...1)', 'on_date', '2026-09-23', 'balance_minor', -9999),
    jsonb_build_object('account', 'Old 401k', 'on_date', '2026-09-23', 'balance_minor', 4000),
    jsonb_build_object('account', 'Old 401k', 'on_date', '2026-09-24', 'balance_minor', 5000));
  payload jsonb;
  got jsonb;
  run public.bank_pulls;
  line text;
  n integer;
begin
  payload := jsonb_build_object('accounts', accounts, 'transactions', txs, 'balances', balances);
  set local role service_role;
  run := public.bank_store(owner, 'simplefin', night, now(), 1, null, '');

  got := public.monarch_store(owner, payload);
  if got is distinct from jsonb_build_object(
      'accounts_added', 1, 'accounts_changed', 0,
      'transactions_added', 3, 'transactions_changed', 0, 'transactions_left_to_bank', 1,
      'days_added', 4, 'days_changed', 0, 'days_left_to_bank', 2,
      'days_matched', 1, 'days_differed', 1) then
    raise exception 'the first import said %', got;
  end if;

  select string_agg(s.on_date || ' ' || s.kind || ' ' || s.balance_minor, ', ' order by s.on_date)
  into line
  from public.balance_snapshots s join public.accounts a on a.id = s.account_id
  where a.user_id = owner and a.source_id = 'mcard';
  if line is distinct from
     '2026-09-20 monarch -8700, 2026-09-21 monarch -8000, 2026-09-22 rebuilt -8000, '
     '2026-09-23 rebuilt -10000, 2026-09-24 rebuilt -10000, 2026-09-25 read -10000' then
    raise exception 'the card''s history after the import is %', line;
  end if;

  got := public.monarch_store(owner, payload);
  if (select sum(v::integer) from jsonb_each_text(got - 'transactions_left_to_bank'
        - 'days_left_to_bank' - 'days_matched' - 'days_differed') as e (k, v)) <> 0 then
    raise exception 'a second identical import wrote something: %', got;
  end if;

  -- A corrected file changes the row it corrects, and nothing else.
  got := public.monarch_store(owner, jsonb_set(payload, '{transactions,0,amount_minor}', '-701'));
  if (got ->> 'transactions_changed')::integer <> 1 or (got ->> 'transactions_added')::integer <> 0 then
    raise exception 'a corrected transaction was not one change: %', got;
  end if;

  -- The next night: the rebuilt days still start on 22 Sep, not at the imported 20 Sep, and
  -- the imported transaction the Bridge never reports is not marked dropped.
  run := public.bank_store(owner, 'simplefin', night, now(), 1, '2026-09-01T00:00:00Z', '');
  if (run.rebuilt, run.dropped) is distinct from (0, 0) then
    raise exception 'the night after an import rebuilt % and dropped %', run.rebuilt, run.dropped;
  end if;
  select count(*) into n from public.transactions x join public.accounts a on a.id = x.account_id
  where a.user_id = owner and x.origin = 'monarch' and x.dropped_at is not null;
  if n <> 0 then
    raise exception '% imported transaction(s) marked dropped', n;
  end if;

  begin
    perform public.monarch_store(owner, jsonb_build_object(
      'accounts', jsonb_build_array(jsonb_build_object('monarch_name', 'X', 'link', 'nothing',
        'currency', 'USD', 'balance_minor', 0, 'balance_on', '2026-09-24')),
      'transactions', '[]'::jsonb, 'balances', '[]'::jsonb));
    raise exception 'a link to no account was accepted';
  exception
    when raise_exception then
      if sqlerrm not like 'monarch_store: no bank account%' then raise; end if;
  end;
  reset role;

  if has_function_privilege('authenticated', 'public.monarch_store(uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.monarch_store(uuid, jsonb)', 'execute') then
    raise exception 'monarch_store is callable by someone other than service_role';
  end if;

  raise notice 'PASS  monarch_store: fills before the bank''s history, idempotent, never walked back through';
end;
$$;

-- Plaid as a second source (BANK-07). A Plaid night stores as `plaid` and records its own
-- pull; a source nobody named is refused; an account Monarch knew only as history, linked
-- once Plaid reaches it, takes its history onto Plaid's account and retires the copy, so
-- net worth never counts it twice.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  night jsonb := jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'source_id', 'plaid-cb', 'institution', 'Lakeside Bank', 'name', 'LB High Yield Savings',
      'currency', 'USD', 'balance_minor', 100000, 'available_minor', 100000,
      'balance_at', '2026-09-25T09:00:00Z', 'holdings', 0)),
    'transactions', '[]'::jsonb,
    'history_from', null);
  history jsonb := jsonb_build_object(
    'transactions', jsonb_build_array(jsonb_build_object(
      'account', 'LB High Yield Savings (...9)', 'id', 'cb1', 'on_date', '2026-09-01',
      'amount_minor', 500, 'payee', null, 'description', 'd', 'memo', null, 'category', null)),
    'balances', jsonb_build_array(
      jsonb_build_object('account', 'LB High Yield Savings (...9)', 'on_date', '2026-09-01',
        'balance_minor', 99500),
      jsonb_build_object('account', 'LB High Yield Savings (...9)', 'on_date', '2026-09-24',
        'balance_minor', 100000)));
  as_history jsonb;
  as_link jsonb;
  run public.bank_pulls;
  copy_id uuid;
  n integer;
  line text;
begin
  as_history := history || jsonb_build_object('accounts', jsonb_build_array(jsonb_build_object(
    'monarch_name', 'LB High Yield Savings (...9)', 'link', null, 'currency', 'USD',
    'balance_minor', 100000, 'balance_on', '2026-09-24')));
  as_link := history || jsonb_build_object('accounts', jsonb_build_array(jsonb_build_object(
    'monarch_name', 'LB High Yield Savings (...9)', 'link', 'plaid-cb', 'currency', 'USD',
    'balance_minor', 100000, 'balance_on', '2026-09-24')));

  set local role service_role;
  perform public.monarch_store(owner, as_history);
  select id into copy_id from public.accounts
  where user_id = owner and source = 'monarch' and source_id = 'LB High Yield Savings (...9)';

  run := public.bank_store(owner, 'plaid', night, now(), 2, null, '');
  if (run.source, run.accounts, run.kept) is distinct from ('plaid', 1, 1) then
    raise exception 'a Plaid night stored % % %', run.source, run.accounts, run.kept;
  end if;

  perform public.monarch_store(owner, as_link);

  select count(*) into n from public.accounts where id = copy_id and deleted_at is null;
  if n <> 0 then
    raise exception 'the history-only copy is still live beside Plaid''s account';
  end if;
  select count(*) into n from public.balance_snapshots
  where account_id = copy_id and deleted_at is null;
  if n <> 0 then
    raise exception '% day(s) of the retired copy are still live', n;
  end if;
  select count(*) into n from public.transactions
  where account_id = copy_id and deleted_at is null;
  if n <> 0 then
    raise exception '% transaction(s) of the retired copy are still live', n;
  end if;
  select count(*) into n from public.accounts where id = copy_id;
  if n <> 1 then
    raise exception 'the retired copy was removed, not marked';
  end if;

  select string_agg(s.on_date || ' ' || s.kind || ' ' || s.balance_minor, ', ' order by s.on_date)
  into line
  from public.balance_snapshots s join public.accounts a on a.id = s.account_id
  where a.user_id = owner and a.source = 'plaid' and a.source_id = 'plaid-cb'
    and s.deleted_at is null;
  if line is distinct from
     '2026-09-01 monarch 99500, 2026-09-24 monarch 100000, 2026-09-25 read 100000' then
    raise exception 'Plaid''s account after the link has %', line;
  end if;
  select count(*) into n from public.transactions x join public.accounts a on a.id = x.account_id
  where a.source = 'plaid' and a.source_id = 'plaid-cb' and x.origin = 'monarch'
    and x.deleted_at is null;
  if n <> 1 then
    raise exception 'Plaid''s account has % imported transaction(s), not 1', n;
  end if;

  begin
    perform public.bank_store(owner, 'nobody', night, now(), 1, null, '');
    raise exception 'a source nobody named was stored';
  exception
    when check_violation then null;
  end;
  reset role;

  raise notice 'PASS  plaid: stored as its own source, Monarch''s history moves onto it and retires the copy';
end;
$$;

-- Plaid's new transactions (BANK-14), the way the Gemini card met them: Monarch's history
-- moved onto the Plaid account up to 24 Sep, the first reading on 26 Sep, and a first sync
-- that reaches back over both. A day Monarch holds stays Monarch's; the day between is
-- filled; what Plaid removes is marked, not deleted; the cursor is written with the rows and
-- is nobody's to read but the job's.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  card constant jsonb := jsonb_build_object(
    'source_id', 'plaid-gemini', 'institution', 'Gemini', 'name', 'Gemini Credit Card',
    'currency', 'USD', 'balance_minor', -5000, 'available_minor', null, 'holdings', 0);
  monarch_name constant text := 'Gemini Credit Card (...4821)';
  history constant jsonb := jsonb_build_object(
    'transactions', jsonb_build_array(jsonb_build_object(
      'account', monarch_name, 'id', 'm24', 'on_date', '2026-09-24', 'amount_minor', -700,
      'payee', null, 'description', 'd', 'memo', null, 'category', null)),
    'balances', jsonb_build_array(
      jsonb_build_object('account', monarch_name, 'on_date', '2026-09-23', 'balance_minor', -4300),
      jsonb_build_object('account', monarch_name, 'on_date', '2026-09-24', 'balance_minor', -5000)));
  run public.bank_pulls;
  line text;
  n integer;
begin
  set local role service_role;
  perform public.monarch_store(owner, history || jsonb_build_object('accounts', jsonb_build_array(
    jsonb_build_object('monarch_name', monarch_name, 'link', null, 'currency', 'USD',
      'balance_minor', -5000, 'balance_on', '2026-09-24'))));
  perform public.bank_store(owner, 'plaid', jsonb_build_object(
    'accounts', jsonb_build_array(card || '{"balance_at": "2026-09-26T15:30:00Z"}'),
    'transactions', '[]'::jsonb), now(), 3, null, '');
  perform public.monarch_store(owner, history || jsonb_build_object('accounts', jsonb_build_array(
    jsonb_build_object('monarch_name', monarch_name, 'link', 'plaid-gemini', 'currency', 'USD',
      'balance_minor', -5000, 'balance_on', '2026-09-24'))));

  -- The first sync: the charge Monarch already has on 24 Sep, one on 25 Sep, one pending.
  run := public.bank_store(owner, 'plaid', jsonb_build_object(
    'accounts', jsonb_build_array(card || '{"balance_at": "2026-09-27T09:00:00Z"}'),
    'transactions', jsonb_build_array(
      jsonb_build_object('account_source_id', 'plaid-gemini', 'source_id', 'p24',
        'posted_at', '2026-09-24T12:00:00Z', 'transacted_at', null, 'amount_minor', -700,
        'description', 'd', 'payee', null, 'memo', null, 'pending', false),
      jsonb_build_object('account_source_id', 'plaid-gemini', 'source_id', 'p25',
        'posted_at', '2026-09-25T12:00:00Z', 'transacted_at', null, 'amount_minor', -300,
        'description', 'd', 'payee', null, 'memo', null, 'pending', false),
      jsonb_build_object('account_source_id', 'plaid-gemini', 'source_id', 'pending',
        'posted_at', null, 'transacted_at', '2026-09-27T12:00:00Z', 'amount_minor', -100,
        'description', 'd', 'payee', null, 'memo', null, 'pending', true)),
    'removed', '[]'::jsonb,
    'cursors', jsonb_build_array(jsonb_build_object('item', 'gemini-item', 'cursor', 'c1'))),
    now(), 4, null, '');
  if (run.transactions, run.added) is distinct from (2, 2) then
    raise exception 'the first sync stored % and added %, not 2 and 2', run.transactions, run.added;
  end if;

  select string_agg(x.source_id || ' ' || x.origin, ', ' order by x.source_id) into line
  from public.transactions x join public.accounts a on a.id = x.account_id
  where a.user_id = owner and a.source = 'plaid' and a.source_id = 'plaid-gemini'
    and x.deleted_at is null;
  if line is distinct from 'monarch:m24 monarch, p25 bank, pending bank' then
    raise exception 'the card holds %, where a day Monarch holds should stay its own', line;
  end if;

  select string_agg(s.on_date || ' ' || s.kind || ' ' || s.balance_minor, ', ' order by s.on_date)
  into line
  from public.balance_snapshots s join public.accounts a on a.id = s.account_id
  where a.user_id = owner and a.source = 'plaid' and a.source_id = 'plaid-gemini'
    and s.deleted_at is null;
  if line is distinct from '2026-09-23 monarch -4300, 2026-09-24 monarch -5000, '
     || '2026-09-25 rebuilt -5000, 2026-09-26 read -5000, 2026-09-27 read -5000' then
    raise exception 'the card''s days are %', line;
  end if;

  select cursor into line from public.bank_cursors
  where user_id = owner and source = 'plaid' and item = 'gemini-item';
  if line is distinct from 'c1' then
    raise exception 'the cursor after the first sync is %', line;
  end if;

  -- The next night: the pending charge posted under a new id, and Plaid removes the old one.
  run := public.bank_store(owner, 'plaid', jsonb_build_object(
    'accounts', jsonb_build_array(card || '{"balance_at": "2026-09-28T09:00:00Z"}'),
    'transactions', '[]'::jsonb,
    'removed', jsonb_build_array('pending', 'monarch:m24'),
    'cursors', jsonb_build_array(jsonb_build_object('item', 'gemini-item', 'cursor', 'c2'))),
    now(), 3, null, '');
  if run.dropped <> 1 then
    raise exception 'the night Plaid removed one counted % dropped', run.dropped;
  end if;
  select count(*) into n from public.transactions
  where user_id = owner and source_id = 'pending' and dropped_at is not null;
  if n <> 1 then
    raise exception 'what Plaid removed was not marked dropped, or was deleted';
  end if;
  select count(*) into n from public.transactions
  where user_id = owner and source_id = 'monarch:m24' and dropped_at is null
    and deleted_at is null;
  if n <> 1 then
    raise exception 'a removal reached Monarch''s own row';
  end if;
  select cursor into line from public.bank_cursors
  where user_id = owner and source = 'plaid' and item = 'gemini-item';
  if line is distinct from 'c2' then
    raise exception 'the cursor after the second night is %', line;
  end if;

  begin
    delete from public.bank_cursors where user_id = owner;
    raise exception 'service_role deleted a cursor';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;
  begin
    select count(*) into n from public.bank_cursors;
    raise exception 'she can read the job''s cursors';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'PASS  plaid transactions: Monarch''s days kept, the gap filled, removals marked, cursors the job''s alone';
end;
$$;

-- Property and valuables (ACCT-06). Hers only, and not the job's; a value is added, never
-- rewritten, and removed rather than deleted; an asset cannot change currency or claim to be
-- Monarch's, nor point at another user's loan; a second import of Monarch's values writes
-- nothing. The job reads none of her figures (ACCT-11 lets it read what estimates need).
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  own_loan constant uuid := '99999999-0000-0000-0000-000000000002';
  home uuid;
  first_value uuid;
  n integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;

  insert into public.assets (user_id, name, kind, acquired_on, cost_minor, financed_by)
  values (owner, 'Apartment', 'home', '2021-06-01', 40000000, own_loan)
  returning id into home;
  insert into public.asset_values (user_id, asset_id, valued_on, amount_minor)
  values (owner, home, '2026-01-01', 50000000)
  returning id into first_value;
  insert into public.asset_values (user_id, asset_id, valued_on, amount_minor)
  values (owner, home, '2026-09-01', 52000000);

  select count(*) into n from public.asset_values where asset_id = home;
  if n <> 2 then
    raise exception 'after two values she sees % value row(s)', n;
  end if;

  begin
    update public.asset_values set amount_minor = 1 where id = first_value;
    raise exception 'the owner rewrote a value in place';
  exception
    when insufficient_privilege then null;
  end;

  update public.asset_values set deleted_at = now() where id = first_value;
  select count(*) into n from public.asset_values where asset_id = home and deleted_at is null;
  if n <> 1 then
    raise exception 'removing a value left % live row(s), not 1', n;
  end if;

  update public.assets
  set name = 'Home', kind = 'home', acquired_on = '2021-07-01', cost_minor = 1, financed_by = null
  where id = home;

  begin
    update public.assets set currency = 'EUR' where id = home;
    raise exception 'an asset changed currency under its values';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.assets set monarch_name = 'Apartment' where id = home;
    raise exception 'an asset she made was passed off as Monarch''s';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.assets set financed_by = '99999999-0000-0000-0000-000000000001' where id = home;
    raise exception 'an asset was tied to another user''s loan';
  exception
    when foreign_key_violation then null;
  end;

  begin
    insert into public.assets (user_id, name, kind, cost_minor)
    values (owner, 'Ring', 'valuables', 100);
    raise exception 'a cost with no day it was paid was stored';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.assets (user_id, name, kind) values (owner, 'Boat', 'boat');
    raise exception 'an asset of no known kind was stored';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.asset_values (user_id, asset_id, valued_on, amount_minor)
    values (owner, home, '2026-09-02', -1);
    raise exception 'a value below zero was stored';
  exception
    when check_violation then null;
  end;

  begin
    insert into public.asset_values (user_id, asset_id, valued_on, amount_minor, source)
    values (owner, home, '2026-09-02', 1, 'zillow');
    raise exception 'a value from an unknown source was stored';
  exception
    when check_violation then null;
  end;

  -- Monarch's values: one per day, so a second import of the same day writes nothing.
  insert into public.asset_values (user_id, asset_id, valued_on, amount_minor, source)
  values (owner, home, '2025-01-15', 45000000, 'monarch');
  insert into public.asset_values (user_id, asset_id, valued_on, amount_minor, source)
  values (owner, home, '2025-01-15', 45000000, 'monarch')
  on conflict (user_id, asset_id, valued_on) where source = 'monarch' and deleted_at is null
  do nothing;
  select count(*) into n from public.asset_values where source = 'monarch';
  if n <> 1 then
    raise exception 'a second import of one day stored % Monarch value(s), not 1', n;
  end if;

  begin
    delete from public.asset_values;
    raise exception 'the owner hard-deleted a value';
  exception
    when insufficient_privilege then null;
  end;
  begin
    delete from public.assets;
    raise exception 'the owner hard-deleted an asset';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from public.assets;
  if n <> 0 then
    raise exception 'another user sees % of her assets', n;
  end if;
  begin
    insert into public.asset_values (user_id, asset_id, valued_on, amount_minor)
    values ('22222222-2222-2222-2222-222222222222', home, '2026-09-01', 1);
    raise exception 'another user valued her asset';
  exception
    when foreign_key_violation then null;
  end;
  reset role;

  -- The nightly job reads what the estimate sources are asked with (ACCT-11), and nothing
  -- about what she says any of it is worth.
  set local role service_role;
  begin
    perform name from public.assets;
    raise exception 'service_role can read what her assets are called';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform cost_minor from public.assets;
    raise exception 'service_role can read what her assets cost';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform amount_minor from public.asset_values;
    raise exception 'service_role can read her values';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'PASS  assets: hers only, values added not rewritten, removed not deleted, one Monarch value a day, no figure the job''s to read';
end;
$$;

-- Estimates (ACCT-11). Only the nightly job writes one and it writes nothing else; one per
-- asset, provider and day; she can remove one but not write one; and what the sources are
-- asked with belongs to the kind of asset it describes.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  home uuid;
  car uuid;
  n integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;
  insert into public.assets (user_id, name, kind, address)
  values (owner, 'Apartment', 'home', '1 Main St, San Diego, CA, 92101')
  returning id into home;
  insert into public.assets (user_id, name, kind, vin, postal_code, odometer_miles, odometer_on)
  values (owner, 'Car', 'vehicle', '2HGFE1F50PH000001', '92101', 12000, '2026-09-01')
  returning id into car;

  begin
    insert into public.asset_values (user_id, asset_id, valued_on, amount_minor, source, provider)
    values (owner, home, '2026-09-20', 1, 'estimate', 'rentcast');
    raise exception 'the owner wrote an estimate';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update public.assets set vin = '2HGFE1F50PH000001' where id = home;
    raise exception 'a home was given a VIN';
  exception
    when check_violation then null;
  end;
  begin
    update public.assets set address = '1 Main St' where id = car;
    raise exception 'a car was given an address';
  exception
    when check_violation then null;
  end;
  begin
    update public.assets set vin = '2HGFE1F50PH00000O' where id = car;
    raise exception 'a VIN with an O in it was stored';
  exception
    when check_violation then null;
  end;
  begin
    update public.assets set odometer_on = null where id = car;
    raise exception 'a mileage with no day it was read was stored';
  exception
    when check_violation then null;
  end;
  reset role;

  set local role service_role;
  select count(*) into n from public.assets where address is not null or vin is not null;
  if n <> 2 then
    raise exception 'service_role reads % asset(s) to estimate, not 2', n;
  end if;
  insert into public.asset_values
    (user_id, asset_id, valued_on, amount_minor, source, provider, low_minor, high_minor)
  values (owner, home, '2026-09-20', 55000000, 'estimate', 'rentcast', 50000000, 60000000);
  insert into public.asset_values (user_id, asset_id, valued_on, amount_minor, source, provider)
  values (owner, home, '2026-09-20', 56000000, 'estimate', 'rentcast')
  on conflict (user_id, asset_id, provider, valued_on) do nothing;
  select count(*) into n from public.asset_values where source = 'estimate';
  if n <> 1 then
    raise exception 'a second read of one day stored % estimate(s), not 1', n;
  end if;
  begin
    insert into public.asset_values (user_id, asset_id, valued_on, amount_minor)
    values (owner, home, '2026-09-21', 1);
    raise exception 'service_role wrote a value as hers';
  exception
    when insufficient_privilege then null;
  end;
  begin
    insert into public.asset_values (user_id, asset_id, valued_on, amount_minor, source)
    values (owner, car, '2026-09-21', 1, 'estimate');
    raise exception 'an estimate that names no provider was stored';
  exception
    when check_violation then null;
  end;
  begin
    insert into public.asset_values
      (user_id, asset_id, valued_on, amount_minor, source, provider, low_minor, high_minor)
    values (owner, car, '2026-09-21', 10, 'estimate', 'marketcheck', 20, 30);
    raise exception 'an estimate outside its own range was stored';
  exception
    when check_violation then null;
  end;
  begin
    update public.asset_values set deleted_at = now() where asset_id = home;
    raise exception 'service_role removed a value';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;
  update public.asset_values set deleted_at = now() where asset_id = home and source = 'estimate';
  select count(*) into n from public.asset_values where source = 'estimate' and deleted_at is null;
  if n <> 0 then
    raise exception 'removing an estimate left % live', n;
  end if;
  reset role;

  raise notice 'PASS  estimates: the job''s alone, one a day per provider, asked with what the kind of asset has';
end;
$$;

-- Metals (ACCT-12). A metal's weight and fineness belong to valuables, all three together; the
-- LBMA's prices are hers to read and the job's to write, the first price for a day kept; and the
-- job reads what a value is worked out from and nothing she says anything is worth.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  bracelet uuid;
  n integer;
  kept text;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;
  insert into public.assets (user_id, name, kind, acquired_on, cost_minor, metal, metal_mg, fineness)
  values (owner, 'Bracelet', 'valuables', '2022-03-01', 800000, 'gold', 52300, 750)
  returning id into bracelet;
  begin
    update public.assets set fineness = null where id = bracelet;
    raise exception 'a metal with no fineness was stored';
  exception
    when check_violation then null;
  end;
  begin
    update public.assets set kind = 'home' where id = bracelet;
    raise exception 'a home was given a metal';
  exception
    when check_violation then null;
  end;
  begin
    update public.assets set fineness = 1001 where id = bracelet;
    raise exception 'a fineness above pure was stored';
  exception
    when check_violation then null;
  end;
  begin
    insert into public.metal_prices (user_id, source, metal, currency, price_date, price)
    values (owner, 'lbma', 'gold', 'USD', '2026-09-24', 1);
    raise exception 'the owner wrote a price';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  set local role service_role;
  select count(*) into n from public.assets
  where metal = 'gold' and metal_mg = 52300 and fineness = 750 and acquired_on = '2022-03-01';
  if n <> 1 then
    raise exception 'service_role reads % metal(s) to value, not 1', n;
  end if;
  begin
    perform cost_minor from public.assets;
    raise exception 'service_role can read what a metal cost';
  exception
    when insufficient_privilege then null;
  end;
  insert into public.metal_prices (user_id, source, metal, currency, price_date, price)
  values (owner, 'lbma', 'gold', 'USD', '2026-09-24', 4266.4);
  insert into public.metal_prices (user_id, source, metal, currency, price_date, price)
  values (owner, 'lbma', 'gold', 'USD', '2026-09-24', 1)
  on conflict (user_id, source, metal, currency, price_date) do nothing;
  begin
    update public.metal_prices set price = 1;
    raise exception 'service_role rewrote a price';
  exception
    when insufficient_privilege then null;
  end;
  insert into public.asset_values (user_id, asset_id, valued_on, amount_minor, source, provider)
  values (owner, bracelet, '2026-09-24', 538041, 'estimate', 'lbma');
  reset role;

  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;
  select price::text into kept from public.metal_prices where price_date = '2026-09-24';
  if kept is distinct from '4266.4' then
    raise exception 'the price kept for a day is %, not the first one read', kept;
  end if;
  begin
    update public.metal_prices set price = 2;
    raise exception 'the owner rewrote a price';
  exception
    when insufficient_privilege then null;
  end;
  select count(*) into n from public.asset_values where provider = 'lbma';
  if n <> 1 then
    raise exception 'the owner sees % metal value(s), not 1', n;
  end if;
  reset role;

  raise notice 'PASS  metals: weight and fineness on valuables only, prices the job''s and kept, no figure of hers to it';
end;
$$;

-- Crypto (ACCT-21). A coin and its quantity belong to crypto, both together, in dollars, and
-- the quantity is kept to the digit; Gemini's closes are hers to read and the job's to insert,
-- the first for a day kept; a Gemini value names the quantity it counted, and a quantity she
-- changes later leaves it as it was.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  holding uuid;
  n integer;
  kept text;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;
  insert into public.assets (user_id, name, kind, coin, coin_quantity)
  values (owner, 'Card rewards', 'crypto', 'BTC', '0.01230000')
  returning id into holding;
  begin
    insert into public.assets (user_id, name, kind) values (owner, 'No coin', 'crypto');
    raise exception 'crypto with no coin was stored';
  exception
    when check_violation then null;
  end;
  begin
    insert into public.assets (user_id, name, kind, coin, coin_quantity)
    values (owner, 'Ring', 'valuables', 'BTC', 1);
    raise exception 'a valuable was given a coin';
  exception
    when check_violation then null;
  end;
  begin
    insert into public.assets (user_id, name, kind, currency, coin, coin_quantity)
    values (owner, 'Euros of it', 'crypto', 'EUR', 'BTC', 1);
    raise exception 'crypto in euros was stored';
  exception
    when check_violation then null;
  end;
  begin
    update public.assets set coin_quantity = '0.0000000000000000001' where id = holding;
    raise exception 'a quantity past eighteen places was stored';
  exception
    when check_violation then null;
  end;
  begin
    update public.assets set coin_quantity = 0 where id = holding;
    raise exception 'a quantity of nothing was stored';
  exception
    when check_violation then null;
  end;
  begin
    update public.assets set coin = 'btc' where id = holding;
    raise exception 'a coin in lower case was stored';
  exception
    when check_violation then null;
  end;
  begin
    insert into public.crypto_prices (user_id, source, coin, currency, price_date, price)
    values (owner, 'gemini', 'BTC', 'USD', '2026-09-25', 1);
    raise exception 'the owner wrote a close';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  set local role service_role;
  select coin_quantity::text into kept from public.assets where kind = 'crypto' and coin = 'BTC';
  if kept is distinct from '0.01230000' then
    raise exception 'service_role reads the quantity as %, not as she stored it', kept;
  end if;
  begin
    perform name from public.assets;
    raise exception 'service_role can read what a holding is called';
  exception
    when insufficient_privilege then null;
  end;
  insert into public.crypto_prices (user_id, source, coin, currency, price_date, price)
  values (owner, 'gemini', 'BTC', 'USD', '2026-09-25', '84098');
  insert into public.crypto_prices (user_id, source, coin, currency, price_date, price)
  values (owner, 'gemini', 'BTC', 'USD', '2026-09-25', 1), (owner, 'gemini', 'SHIB', 'USD', '2026-09-25', '0.000005959')
  on conflict (user_id, source, coin, currency, price_date) do nothing;
  begin
    update public.crypto_prices set price = 1;
    raise exception 'service_role rewrote a close';
  exception
    when insufficient_privilege then null;
  end;
  begin
    insert into public.asset_values (user_id, asset_id, valued_on, amount_minor, source, provider)
    values (owner, holding, '2026-09-25', 103441, 'estimate', 'gemini');
    raise exception 'a Gemini value that names no quantity was stored';
  exception
    when check_violation then null;
  end;
  begin
    insert into public.asset_values
      (user_id, asset_id, valued_on, amount_minor, source, provider, coin_quantity)
    values (owner, holding, '2026-09-25', 1, 'estimate', 'lbma', 1);
    raise exception 'a quantity was stored on a value that is not Gemini''s';
  exception
    when check_violation then null;
  end;
  insert into public.asset_values
    (user_id, asset_id, valued_on, amount_minor, source, provider, coin_quantity)
  values (owner, holding, '2026-09-25', 103441, 'estimate', 'gemini', '0.0123');
  reset role;

  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;
  update public.assets set coin_quantity = '0.0200' where id = holding;
  select coin_quantity::text into kept from public.asset_values where provider = 'gemini';
  if kept is distinct from '0.0123' then
    raise exception 'a new quantity changed a stored value''s to %', kept;
  end if;
  select price::text into kept from public.crypto_prices where coin = 'BTC';
  if kept is distinct from '84098' then
    raise exception 'the close kept for a day is %, not the first one read', kept;
  end if;
  select price::text into kept from public.crypto_prices where coin = 'SHIB';
  if kept is distinct from '0.000005959' then
    raise exception 'a close in millionths was kept as %', kept;
  end if;
  begin
    update public.crypto_prices set price = 2;
    raise exception 'the owner rewrote a close';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'PASS  crypto: coin and quantity on crypto only, in dollars, to the digit; closes the job''s and kept; a value keeps the quantity it counted';
end;
$$;

-- Goals (GOAL-01). Hers only, and nothing of the job's; a saving has a target and a payoff
-- none; kind and currency fixed; a goal counts only her own accounts, each once; a link is
-- removed, never repointed; nothing is deleted.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  own_account constant uuid := '99999999-0000-0000-0000-000000000002';
  other_account constant uuid := '99999999-0000-0000-0000-000000000001';
  fund uuid;
  car uuid;
  link uuid;
  n integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;

  insert into public.goals (user_id, name, kind, target_minor, starts_on, target_on)
  values (owner, 'Emergency fund', 'save', 2000000, '2026-06-01', '2027-06-01')
  returning id into fund;
  insert into public.goals (user_id, name, kind, starts_on)
  values (owner, 'Car paid off', 'payoff', '2024-04-16')
  returning id into car;
  insert into public.goal_accounts (user_id, goal_id, account_id)
  values (owner, fund, own_account)
  returning id into link;

  begin
    insert into public.goal_accounts (user_id, goal_id, account_id)
    values (owner, fund, own_account);
    raise exception 'an account was counted twice in one goal';
  exception
    when unique_violation then null;
  end;

  begin
    insert into public.goal_accounts (user_id, goal_id, account_id)
    values (owner, fund, other_account);
    raise exception 'a goal counted another user''s account';
  exception
    when foreign_key_violation then null;
  end;

  begin
    update public.goal_accounts set account_id = other_account where id = link;
    raise exception 'a link was repointed in place';
  exception
    when insufficient_privilege then null;
  end;

  -- Taken out and put back: a second row, beside the removed one.
  update public.goal_accounts set deleted_at = now() where id = link;
  insert into public.goal_accounts (user_id, goal_id, account_id)
  values (owner, fund, own_account);
  select count(*) into n from public.goal_accounts where goal_id = fund;
  if n <> 2 then
    raise exception 'an account taken out and put back left % link row(s), not 2', n;
  end if;

  update public.goals
  set name = 'Rainy day', target_minor = 2500000, starts_on = '2026-07-01', target_on = null
  where id = fund;

  begin
    update public.goals set kind = 'payoff', target_minor = null where id = fund;
    raise exception 'a goal changed kind';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update public.goals set currency = 'EUR' where id = fund;
    raise exception 'a goal changed currency under its target';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.goals (user_id, name, kind, starts_on)
    values (owner, 'Nothing to reach', 'save', '2026-09-01');
    raise exception 'a saving with no target was stored';
  exception
    when check_violation then null;
  end;
  begin
    insert into public.goals (user_id, name, kind, target_minor, starts_on)
    values (owner, 'Owe less', 'payoff', 100, '2026-09-01');
    raise exception 'a payoff with a target of its own was stored';
  exception
    when check_violation then null;
  end;
  begin
    insert into public.goals (user_id, name, kind, target_minor, starts_on)
    values (owner, 'Negative', 'save', -1, '2026-09-01');
    raise exception 'a saving with a target below zero was stored';
  exception
    when check_violation then null;
  end;
  begin
    update public.goals set target_on = '2024-01-01' where id = car;
    raise exception 'a goal was due before it started';
  exception
    when check_violation then null;
  end;
  begin
    insert into public.goals (user_id, name, kind, target_minor, starts_on)
    values (owner, 'Holiday', 'spend', 1, '2026-09-01');
    raise exception 'a goal of no known kind was stored';
  exception
    when check_violation then null;
  end;

  update public.goals set deleted_at = now() where id = car;
  select count(*) into n from public.goals where deleted_at is null;
  if n <> 1 then
    raise exception 'giving up a goal left % live goal(s), not 1', n;
  end if;

  begin
    delete from public.goal_accounts;
    raise exception 'the owner hard-deleted a goal''s account';
  exception
    when insufficient_privilege then null;
  end;
  begin
    delete from public.goals;
    raise exception 'the owner hard-deleted a goal';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from public.goals;
  if n <> 0 then
    raise exception 'another user sees % of her goals', n;
  end if;
  begin
    insert into public.goal_accounts (user_id, goal_id, account_id)
    values ('22222222-2222-2222-2222-222222222222', fund, other_account);
    raise exception 'another user added an account to her goal';
  exception
    when foreign_key_violation then null;
  end;
  reset role;

  set local role service_role;
  begin
    perform target_minor from public.goals;
    raise exception 'service_role can read her targets';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform account_id from public.goal_accounts;
    raise exception 'service_role can read which accounts her goals count';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'PASS  goals: hers only, a target for a saving and none for a payoff, kind and currency fixed, her accounts each once, removed not deleted, nothing for the job';
end;
$$;

-- Budgets (BUD-01). Hers only, and nothing of the job's; one live category per name, one
-- budget per month, one choice per transaction; budgets and rules start on the first of a
-- month; choices and rules are removed, never repointed; nothing is deleted.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  own_txn uuid;
  other_txn uuid;
  groceries uuid;
  dining uuid;
  budget uuid;
  chosen uuid;
  rule uuid;
  n integer;
begin
  select id into own_txn from public.transactions
  where account_id = '99999999-0000-0000-0000-000000000002' and source_id = 't';
  select id into other_txn from public.transactions
  where account_id = '99999999-0000-0000-0000-000000000001' and source_id = 't';

  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;

  insert into public.categories (user_id, name, kind, guesses_from)
  values (owner, 'Groceries', 'spend', '{Groceries}')
  returning id into groceries;
  insert into public.categories (user_id, name, kind)
  values (owner, 'Eating out', 'spend')
  returning id into dining;

  begin
    insert into public.categories (user_id, name, kind) values (owner, 'groceries', 'spend');
    raise exception 'two live categories share a name';
  exception
    when unique_violation then null;
  end;
  begin
    insert into public.categories (user_id, name, kind) values (owner, 'Savings', 'save');
    raise exception 'a category of no known kind was stored';
  exception
    when check_violation then null;
  end;
  update public.categories
  set name = 'Food', kind = 'spend', guesses_from = '{Groceries,"Coffee Shops"}'
  where id = groceries;

  insert into public.category_budgets (user_id, category_id, starts_on, amount_minor)
  values (owner, groceries, '2026-09-01', 60000)
  returning id into budget;
  -- No budget from October: a row with no amount, beside September's.
  insert into public.category_budgets (user_id, category_id, starts_on, amount_minor)
  values (owner, groceries, '2026-10-01', null);
  begin
    insert into public.category_budgets (user_id, category_id, starts_on, amount_minor)
    values (owner, groceries, '2026-09-01', 1);
    raise exception 'a category had two budgets for one month';
  exception
    when unique_violation then null;
  end;
  begin
    insert into public.category_budgets (user_id, category_id, starts_on, amount_minor)
    values (owner, dining, '2026-09-15', 1);
    raise exception 'a budget started mid-month';
  exception
    when check_violation then null;
  end;
  begin
    insert into public.category_budgets (user_id, category_id, starts_on, amount_minor)
    values (owner, dining, '2026-09-01', -1);
    raise exception 'a budget below zero was stored';
  exception
    when check_violation then null;
  end;
  update public.category_budgets set amount_minor = 65000 where id = budget;
  begin
    update public.category_budgets set starts_on = '2026-08-01' where id = budget;
    raise exception 'a budget was moved to another month in place';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update public.category_budgets set category_id = dining where id = budget;
    raise exception 'a budget was moved to another category in place';
  exception
    when insufficient_privilege then null;
  end;

  insert into public.transaction_categories (user_id, transaction_id, category_id)
  values (owner, own_txn, groceries)
  returning id into chosen;
  begin
    insert into public.transaction_categories (user_id, transaction_id, category_id)
    values (owner, own_txn, dining);
    raise exception 'a transaction was put in two categories';
  exception
    when unique_violation then null;
  end;
  begin
    insert into public.transaction_categories (user_id, transaction_id, category_id)
    values (owner, other_txn, groceries);
    raise exception 'she categorised another user''s transaction';
  exception
    when foreign_key_violation then null;
  end;
  begin
    update public.transaction_categories set category_id = dining where id = chosen;
    raise exception 'a choice was repointed in place';
  exception
    when insufficient_privilege then null;
  end;
  -- Changed: the old choice removed, a new one beside it.
  update public.transaction_categories set deleted_at = now() where id = chosen;
  insert into public.transaction_categories (user_id, transaction_id, category_id)
  values (owner, own_txn, dining);
  select count(*) into n from public.transaction_categories where transaction_id = own_txn;
  if n <> 2 then
    raise exception 'a changed choice left % row(s), not 2', n;
  end if;

  insert into public.category_rules (user_id, payee, category_id, starts_on)
  values (owner, 'whole foods', groceries, '2026-09-01')
  returning id into rule;
  -- Stopped from October: a newer rule with no category.
  insert into public.category_rules (user_id, payee, category_id, starts_on)
  values (owner, 'whole foods', null, '2026-10-01');
  begin
    insert into public.category_rules (user_id, payee, category_id, starts_on)
    values (owner, 'whole foods', groceries, '2026-09-25');
    raise exception 'a rule started mid-month';
  exception
    when check_violation then null;
  end;
  begin
    update public.category_rules set starts_on = '2026-01-01' where id = rule;
    raise exception 'a rule was moved back in place, rewriting earlier months';
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.category_rules;
    raise exception 'the owner hard-deleted a rule';
  exception
    when insufficient_privilege then null;
  end;
  begin
    delete from public.transaction_categories;
    raise exception 'the owner hard-deleted a choice';
  exception
    when insufficient_privilege then null;
  end;
  begin
    delete from public.category_budgets;
    raise exception 'the owner hard-deleted a budget';
  exception
    when insufficient_privilege then null;
  end;
  begin
    delete from public.categories;
    raise exception 'the owner hard-deleted a category';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update public.transactions set amount_minor = 1 where id = own_txn;
    raise exception 'categorising opened the bank''s transactions to her edits';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  set local role authenticated;
  select (select count(*) from public.categories)
       + (select count(*) from public.category_budgets)
       + (select count(*) from public.transaction_categories)
       + (select count(*) from public.category_rules)
  into n;
  if n <> 0 then
    raise exception 'another user sees % of her budget rows', n;
  end if;
  begin
    insert into public.transaction_categories (user_id, transaction_id, category_id)
    values ('22222222-2222-2222-2222-222222222222', other_txn, groceries);
    raise exception 'another user filed a transaction under her category';
  exception
    when foreign_key_violation then null;
  end;
  reset role;

  set local role service_role;
  begin
    perform name from public.categories;
    raise exception 'service_role can read her categories';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform amount_minor from public.category_budgets;
    raise exception 'service_role can read her budgets';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform category_id from public.transaction_categories;
    raise exception 'service_role can read how she sorted her transactions';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform payee from public.category_rules;
    raise exception 'service_role can read her rules';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'PASS  budgets: hers only, one category per name, a budget per month from the first, one choice per transaction, removed not repointed, nothing deleted, nothing for the job';
end;
$$;

-- Goal plans (GOAL-04). Hers only, and nothing of the job's; one plan per goal per month, from
-- the first, never below zero; a plan is not moved to another month or goal; nothing deleted.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  fund uuid;
  trip uuid;
  plan uuid;
  n integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;

  insert into public.goals (user_id, name, kind, target_minor, starts_on)
  values (owner, 'House fund', 'save', 5000000, '2026-01-01')
  returning id into fund;
  insert into public.goals (user_id, name, kind, target_minor, starts_on)
  values (owner, 'Trip', 'save', 300000, '2026-01-01')
  returning id into trip;

  insert into public.goal_plans (user_id, goal_id, starts_on, amount_minor)
  values (owner, fund, '2026-09-01', 50000)
  returning id into plan;
  -- No plan from October: a row with no amount, beside September's.
  insert into public.goal_plans (user_id, goal_id, starts_on, amount_minor)
  values (owner, fund, '2026-10-01', null);
  begin
    insert into public.goal_plans (user_id, goal_id, starts_on, amount_minor)
    values (owner, fund, '2026-09-01', 1);
    raise exception 'a goal had two plans for one month';
  exception
    when unique_violation then null;
  end;
  begin
    insert into public.goal_plans (user_id, goal_id, starts_on, amount_minor)
    values (owner, trip, '2026-09-15', 1);
    raise exception 'a plan started mid-month';
  exception
    when check_violation then null;
  end;
  begin
    insert into public.goal_plans (user_id, goal_id, starts_on, amount_minor)
    values (owner, trip, '2026-09-01', -1);
    raise exception 'a plan below zero was stored';
  exception
    when check_violation then null;
  end;
  update public.goal_plans set amount_minor = 60000 where id = plan;
  begin
    update public.goal_plans set starts_on = '2026-08-01' where id = plan;
    raise exception 'a plan was moved to another month in place';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update public.goal_plans set goal_id = trip where id = plan;
    raise exception 'a plan was moved to another goal in place';
  exception
    when insufficient_privilege then null;
  end;
  begin
    delete from public.goal_plans;
    raise exception 'the owner hard-deleted a plan';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from public.goal_plans;
  if n <> 0 then
    raise exception 'another user sees % of her plans', n;
  end if;
  begin
    insert into public.goal_plans (user_id, goal_id, starts_on, amount_minor)
    values ('22222222-2222-2222-2222-222222222222', fund, '2026-09-01', 1);
    raise exception 'another user planned for her goal';
  exception
    when foreign_key_violation then null;
  end;
  reset role;

  set local role service_role;
  begin
    perform amount_minor from public.goal_plans;
    raise exception 'service_role can read her plans';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  raise notice 'PASS  goal plans: hers only, a plan per goal per month from the first, never below zero, not moved, nothing deleted, nothing for the job';
end;
$$;

-- A lender's statement (ACCT-20). It fills an account only before its first day of any other
-- kind; a second identical import writes nothing and a corrected figure changes one day; it
-- never overwrites a day of another kind; an account that is not hers, or not live, is
-- refused; only service_role may import.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  loan jsonb := jsonb_build_object(
    'source_id', 'sloan', 'institution', 'Lender', 'name', 'Mortgage', 'currency', 'USD',
    'balance_minor', -50000, 'available_minor', null,
    'balance_at', '2026-09-25T09:00:00Z', 'holdings', 0);
  night jsonb := jsonb_build_object(
    'accounts', jsonb_build_array(loan),
    'transactions', '[]'::jsonb,
    'history_from', '2026-09-22T09:00:00Z');
  days jsonb := jsonb_build_array(
    jsonb_build_object('on_date', '2026-09-01', 'balance_minor', -51000),
    jsonb_build_object('on_date', '2026-09-21', 'balance_minor', -50500),
    -- The bank's rebuilt 22 Sep stands for it.
    jsonb_build_object('on_date', '2026-09-22', 'balance_minor', -99));
  account uuid;
  run public.bank_pulls;
  got jsonb;
  line text;
begin
  set local role service_role;
  run := public.bank_store(owner, 'simplefin', night, now(), 1, null, '');
  select a.id into account from public.accounts a where a.user_id = owner and a.source_id = 'sloan';

  got := public.statement_store(owner, account, days);
  if got is distinct from jsonb_build_object('days_added', 2, 'days_changed', 0,
      'days_left_to_others', 1, 'fills_before', '2026-09-22') then
    raise exception 'the first statement import said %', got;
  end if;
  select string_agg(s.on_date || ' ' || s.kind || ' ' || s.balance_minor, ', ' order by s.on_date)
  into line from public.balance_snapshots s where s.account_id = account;
  if line is distinct from
     '2026-09-01 statement -51000, 2026-09-21 statement -50500, 2026-09-22 rebuilt -50000, '
     '2026-09-23 rebuilt -50000, 2026-09-24 rebuilt -50000, 2026-09-25 read -50000' then
    raise exception 'the loan''s history after the statement is %', line;
  end if;

  got := public.statement_store(owner, account, days);
  if got ->> 'days_added' <> '0' or got ->> 'days_changed' <> '0' then
    raise exception 'a second identical statement import said %', got;
  end if;
  got := public.statement_store(owner, account, jsonb_set(days, '{0,balance_minor}', '-51001'));
  if got ->> 'days_added' <> '0' or got ->> 'days_changed' <> '1' then
    raise exception 'a corrected statement import said %', got;
  end if;

  begin
    perform public.statement_store(owner, gen_random_uuid(), days);
    raise exception 'a statement for no account was stored';
  exception
    when raise_exception then
      if sqlerrm not like 'statement_store: no live account%' then raise; end if;
  end;
  begin
    perform public.statement_store('22222222-2222-2222-2222-222222222222', account, days);
    raise exception 'a statement was stored on another user''s account';
  exception
    when raise_exception then
      if sqlerrm not like 'statement_store: no live account%' then raise; end if;
  end;
  reset role;

  if has_function_privilege('authenticated', 'public.statement_store(uuid, uuid, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.statement_store(uuid, uuid, jsonb)', 'execute') then
    raise exception 'statement_store is callable by someone other than service_role';
  end if;

  raise notice 'PASS  statement_store: fills before every other kind, idempotent, hers only, service_role only';
end;
$$;

-- A Monarch decision (ACCT-18) is withdrawn, never rewritten or deleted (DIN-15): the table is the history the
-- file's copies used to be, and an edit in place would lose the decision it replaced.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  first_id uuid;
  n integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;
  insert into public.monarch_decisions (user_id, monarch_name, goes, decided_at)
  values (owner, 'Card (...1234)', 'history', '2026-09-24T12:00:00Z')
  returning id into first_id;
  insert into public.monarch_decisions (user_id, monarch_name, goes, link, decided_at)
  values (owner, 'Card (...1234)', 'link', 'ACT-1', '2026-09-26T12:00:00Z');

  begin
    update public.monarch_decisions set goes = 'skip' where id = first_id;
    raise exception 'a decision was rewritten in place';
  exception
    when insufficient_privilege then null;
  end;
  begin
    insert into public.monarch_decisions (user_id, monarch_name, goes, decided_at)
    values (owner, 'Card (...1234)', 'skip', '2026-09-26T12:00:00Z');
    raise exception 'two live decisions for one account at one instant';
  exception
    when unique_violation then null;
  end;
  begin
    insert into public.monarch_decisions (user_id, monarch_name, goes, asset_kind)
    values (owner, 'Wallet', 'asset', 'crypto');
    raise exception 'a crypto asset was decided, which the import cannot bring in';
  exception
    when check_violation then null;
  end;

  begin
    delete from public.monarch_decisions where id = first_id;
    raise exception 'a decision was deleted, not withdrawn';
  exception
    when insufficient_privilege then null;
  end;

  update public.monarch_decisions set deleted_at = now() where id = first_id;
  select count(*) into n from public.monarch_decisions
  where monarch_name = 'Card (...1234)' and deleted_at is null;
  if n <> 1 then
    raise exception 'withdrawing a decision left % live', n;
  end if;
  reset role;

  -- service_role reads and adds decisions for `monarch_join` (BANK-17), and neither rewrites
  -- nor withdraws one: that is hers.
  if has_table_privilege('service_role', 'public.monarch_decisions', 'UPDATE, DELETE, TRUNCATE') then
    raise exception 'service_role can change a decision on monarch_decisions';
  end if;

  raise notice 'PASS  monarch_decisions: withdrawn, never rewritten or deleted; one at a time; the job only adds';
end;
$$;

-- Put together from the app (BANK-17): `monarch_join` moves the copy's days before the bank's
-- own history, and the transactions on them, onto the bank's account with her category going
-- along, leaves what is in the bank's place on the copy, retires the copy, and keeps the link
-- as a decision. Refused for anything `linkPair` refuses, writing nothing.
do $$
declare
  owner constant uuid := '11111111-1111-1111-1111-111111111111';
  night jsonb := jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'source_id', 'join-bank', 'institution', 'Vanguard', 'name', 'MERIDIAN 401(K) - 550717',
      'currency', 'USD', 'balance_minor', 300000, 'available_minor', 300000,
      'balance_at', '2026-09-26T09:00:00Z', 'holdings', 0)),
    'transactions', '[]'::jsonb,
    'history_from', null);
  history jsonb := jsonb_build_object(
    'accounts', jsonb_build_array(jsonb_build_object(
      'monarch_name', 'MERIDIAN (...0717)', 'link', null, 'currency', 'USD',
      'balance_minor', 300000, 'balance_on', '2026-09-26')),
    'transactions', jsonb_build_array(
      jsonb_build_object('account', 'MERIDIAN (...0717)', 'id', 'j1', 'on_date', '2026-09-01',
        'amount_minor', 500, 'payee', null, 'description', 'd', 'memo', null, 'category', null),
      jsonb_build_object('account', 'MERIDIAN (...0717)', 'id', 'j2', 'on_date', '2026-09-26',
        'amount_minor', 700, 'payee', null, 'description', 'd', 'memo', null, 'category', null)),
    'balances', jsonb_build_array(
      jsonb_build_object('account', 'MERIDIAN (...0717)', 'on_date', '2026-09-01',
        'balance_minor', 299500),
      jsonb_build_object('account', 'MERIDIAN (...0717)', 'on_date', '2026-09-26',
        'balance_minor', 300000)));
  copy_id uuid;
  bank_id uuid;
  moved_tx uuid;
  category uuid;
  got jsonb;
  n integer;
  line text;
begin
  set local role service_role;
  perform public.monarch_store(owner, history);
  perform public.bank_store(owner, 'simplefin', night, now(), 1, null, '');
  select id into copy_id from public.accounts
  where user_id = owner and source = 'monarch' and source_id = 'MERIDIAN (...0717)';
  select id into bank_id from public.accounts
  where user_id = owner and source = 'simplefin' and source_id = 'join-bank';
  select id into moved_tx from public.transactions
  where account_id = copy_id and source_id = 'monarch:j1';
  reset role;

  -- Her category on the copy's transaction, and the mapping as the import left it.
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;
  insert into public.categories (user_id, name, kind) values (owner, 'Join test', 'spend')
  returning id into category;
  insert into public.transaction_categories (user_id, transaction_id, category_id)
  values (owner, moved_tx, category);
  insert into public.monarch_decisions (user_id, monarch_name, goes, decided_at)
  values (owner, 'MERIDIAN (...0717)', 'skip', '2026-09-24T00:00:00Z');
  reset role;

  set local role service_role;
  -- Skipped in the mapping: refused, and nothing moved.
  begin
    perform public.monarch_join(owner, copy_id, bank_id);
    raise exception 'a pair was joined that the mapping skips';
  exception
    when raise_exception then
      if sqlerrm <> 'monarch_join: not_history' then raise; end if;
  end;
  reset role;
  set local role authenticated;
  insert into public.monarch_decisions (user_id, monarch_name, goes, decided_at)
  values (owner, 'MERIDIAN (...0717)', 'history', '2026-09-25T00:00:00Z');
  reset role;

  set local role service_role;
  for line in select unnest(array['not_monarch', 'not_bank']) loop
    begin
      if line = 'not_monarch' then
        perform public.monarch_join(owner, bank_id, bank_id);
      else
        perform public.monarch_join(owner, copy_id, copy_id);
      end if;
      raise exception 'monarch_join took the wrong kind of account (%)', line;
    exception
      when raise_exception then
        if sqlerrm <> 'monarch_join: ' || line then raise; end if;
    end;
  end loop;
  begin
    perform public.monarch_join('22222222-2222-2222-2222-222222222222', copy_id, bank_id);
    raise exception 'another user''s accounts were joined';
  exception
    when raise_exception then
      if sqlerrm <> 'monarch_join: not_monarch' then raise; end if;
  end;

  got := public.monarch_join(owner, copy_id, bank_id);
  if got is distinct from jsonb_build_object('days_moved', 1, 'days_left', 1,
      'transactions_moved', 1, 'transactions_left', 1) then
    raise exception 'monarch_join said %', got;
  end if;

  select string_agg(s.on_date || ' ' || s.kind, ', ' order by s.on_date) into line
  from public.balance_snapshots s where s.account_id = bank_id and s.deleted_at is null;
  if line not like '2026-09-01 monarch, %' or line like '%2026-09-26 monarch%' then
    raise exception 'the bank''s account after the join has %', line;
  end if;
  select count(*) into n from public.transactions
  where id = moved_tx and account_id = bank_id and deleted_at is null;
  if n <> 1 then
    raise exception 'the transaction before the bank''s history did not move with its id';
  end if;
  select count(*) into n from public.accounts where id = copy_id and deleted_at is not null;
  if n <> 1 then
    raise exception 'the copy was not retired';
  end if;
  select count(*) into n from public.transactions
  where account_id = copy_id and deleted_at is null;
  if n <> 0 then
    raise exception 'the copy kept % live transaction(s)', n;
  end if;
  select count(*) into n from public.monarch_decisions
  where user_id = owner and monarch_name = 'MERIDIAN (...0717)' and goes = 'link'
    and link = 'join-bank' and deleted_at is null;
  if n <> 1 then
    raise exception 'the join kept % link decision(s), not 1', n;
  end if;

  begin
    perform public.monarch_join(owner, copy_id, bank_id);
    raise exception 'a pair was joined twice';
  exception
    when raise_exception then
      if sqlerrm <> 'monarch_join: already_joined' then raise; end if;
  end;
  reset role;

  -- Her category went with the transaction, since it kept its id.
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from public.transaction_categories
  where transaction_id = moved_tx and category_id = category and deleted_at is null;
  if n <> 1 then
    raise exception 'her category did not go with the moved transaction';
  end if;
  reset role;

  -- A second import of the same files, now linked, writes nothing.
  set local role service_role;
  got := public.monarch_store(owner, jsonb_set(history, '{accounts,0,link}', '"join-bank"'));
  if (got ->> 'transactions_added', got ->> 'days_added') is distinct from ('0', '0') then
    raise exception 'the import after the join wrote %', got;
  end if;
  reset role;

  if has_function_privilege('authenticated', 'public.monarch_join(uuid, uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.monarch_join(uuid, uuid, uuid)', 'execute') then
    raise exception 'monarch_join is callable by someone other than service_role';
  end if;

  raise notice 'PASS  monarch_join: moves before the bank''s history with her categories, retires the copy, keeps the link, refuses what linkPair refuses';
end;
$$;
