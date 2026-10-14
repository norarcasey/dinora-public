-- The nightly pull (BANK-02): where it stores, what it records, and how a transaction the
-- bank stops reporting is kept.
--
-- Vercel Cron delivers at best once a day, may skip a night and may deliver twice, and
-- does not retry (docs/vercel.md). So the pull reconciles: every run re-reads the last 90
-- days, upserts on the aggregator's ids, and writes one `bank_pulls` row saying what it did.
-- The newest `ok` row is the "last read" ACCT-01 shows; a night with no row is a night the
-- job did not run, which is only visible because the rows exist.

-- A transaction the bank reported and later stopped reporting. Usually a pending charge
-- that posted under a new id, sometimes a reversal. Marked, never deleted (invariant 2),
-- and not `deleted_at`: that is a person's decision, this is the bank's, and a row the bank
-- reports again is un-marked by the next pull. Totals leave marked rows out.
alter table public.transactions add column dropped_at timestamptz;

create table public.bank_pulls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  source text not null,
  outcome text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  requests integer not null default 0,
  accounts integer not null default 0,
  transactions integer not null default 0,
  added integer not null default 0,
  dropped integer not null default 0,
  restored integer not null default 0,
  -- From when a missing transaction counted as dropped; null when this run did not look,
  -- because what came back was incomplete (a Bridge error, a row it could not read).
  drops_from timestamptz,
  -- Why a run failed, or what the Bridge complained of. Counts and codes only: never an
  -- amount or a payee (invariant 4), because this is shown on screen and read in a log.
  detail text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint bank_pulls_user_id_id_key unique (user_id, id),
  constraint bank_pulls_source_known check (source in ('simplefin')),
  constraint bank_pulls_outcome_known check (outcome in ('ok', 'failed')),
  constraint bank_pulls_detail_length check (char_length(detail) <= 2000)
);

create index bank_pulls_user_live_idx
  on public.bank_pulls (user_id, created_at)
  where deleted_at is null;

create index bank_pulls_user_finished_idx
  on public.bank_pulls (user_id, outcome, finished_at desc)
  where deleted_at is null;

create trigger bank_pulls_set_updated_at
  before update on public.bank_pulls
  for each row execute function public.set_updated_at();

create trigger bank_pulls_freeze_user_id
  before update on public.bank_pulls
  for each row execute function public.freeze_user_id();

alter table public.bank_pulls enable row level security;
alter table public.bank_pulls force row level security;

create policy bank_pulls_select_own on public.bank_pulls
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Read-only to her for the reason the bank tables are (20260924134228_bank_accounts.sql):
-- a record of what the job did is not hers to edit.
revoke all on table public.bank_pulls from authenticated;
grant select on table public.bank_pulls to authenticated;
grant select, insert on table public.bank_pulls to service_role;

-- One pull's rows into the tables, and its record, in one transaction: a run that stored
-- rows cannot fail to say so, and a run that says `ok` stored them.
--
-- The one writer, for the cron (through PostgREST) and `pnpm bank:pull` (through psql)
-- alike, so the two cannot drift. Invoker, not definer: it runs with the rights of
-- service_role, which is the only role allowed to call it.
--
-- `p_drops_from` null means "do not mark anything dropped". Otherwise a live transaction of
-- an account in this pull, dated on or after it and missing from the pull, is marked; one
-- that comes back is un-marked. The caller chooses the date (`dropsFrom` in
-- packages/core/src/simplefin.ts) because only it knows what span the pull covered.
create function public.bank_store(
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
  v_run public.bank_pulls;
begin
  insert into public.accounts
    (user_id, source, source_id, institution, name, currency,
     balance_minor, available_minor, balance_at)
  select p_user, p_source, a.source_id, a.institution, a.name, a.currency,
         a.balance_minor, a.available_minor, a.balance_at
  from jsonb_to_recordset(p_payload -> 'accounts') as a (
    source_id text, institution text, name text, currency text,
    balance_minor bigint, available_minor bigint, balance_at timestamptz)
  on conflict (user_id, source, source_id) do update set
    institution = excluded.institution,
    name = excluded.name,
    currency = excluded.currency,
    balance_minor = excluded.balance_minor,
    available_minor = excluded.available_minor,
    balance_at = excluded.balance_at;
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

  insert into public.bank_pulls
    (user_id, source, outcome, started_at, requests, accounts, transactions,
     added, dropped, restored, drops_from, detail)
  values
    (p_user, p_source, 'ok', p_started_at, p_requests, v_accounts, v_seen,
     v_added, v_dropped, v_restored, p_drops_from, coalesce(p_detail, ''))
  returning * into v_run;

  return v_run;
end;
$$;

-- Supabase's default privileges grant every new function to anon and authenticated.
revoke all on function public.bank_store(uuid, text, jsonb, timestamptz, integer, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.bank_store(uuid, text, jsonb, timestamptz, integer, timestamptz, text)
  to service_role;
