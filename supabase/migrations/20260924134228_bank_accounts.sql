-- Accounts and their transactions, as an aggregator reports them (BANK-01).
--
-- Written from supabase/patterns/owned_table.sql with one deliberate difference:
-- `authenticated` may only read. These rows are the bank's, written by the sync as
-- service_role; nothing Nora does in the app changes what the bank said, so there is no
-- insert, update or delete to grant her. When the app lets her annotate a row — a category,
-- a hidden account — that is a column or a table of her own, granted where it is added.
--
-- Revoked, not merely left without a policy: the foundation leaves authenticated its
-- default privileges, which on the local image are all seven — TRUNCATE included, which RLS
-- does not govern (measured 24 Sep 2026). A missing policy made an owner's UPDATE touch 0
-- rows; the revoke makes it an error, so "read-only" is a grant and not an absence.
--
-- Amounts are integer minor units in the account's currency (invariant 1). `source` and
-- `source_id` are the aggregator's name and its id for the row, the key a later pull
-- reconciles on (BANK-02) rather than appending.

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  source text not null,
  source_id text not null,
  institution text not null default '',
  name text not null default '',
  currency text not null,
  balance_minor bigint not null,
  available_minor bigint,
  -- When the bank says the balance was true, which is not when it was fetched: a stale
  -- bank has to look stale (ACCT-01).
  balance_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint accounts_user_id_id_key unique (user_id, id),
  constraint accounts_source_key unique (user_id, source, source_id),
  constraint accounts_source_known check (source in ('simplefin')),
  constraint accounts_currency_iso check (currency ~ '^[A-Z]{3}$'),
  constraint accounts_text_length check (
    char_length(source_id) <= 500
    and char_length(institution) <= 500
    and char_length(name) <= 500
  )
);

create index accounts_user_live_idx
  on public.accounts (user_id, created_at)
  where deleted_at is null;

create trigger accounts_set_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

create trigger accounts_freeze_user_id
  before update on public.accounts
  for each row execute function public.freeze_user_id();

alter table public.accounts enable row level security;
alter table public.accounts force row level security;

create policy accounts_select_own on public.accounts
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.accounts from authenticated;
grant select on table public.accounts to authenticated;
grant select, insert, update on table public.accounts to service_role;

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null,
  foreign key (user_id, account_id) references public.accounts (user_id, id),

  source_id text not null,
  -- Null while pending: SimpleFIN sends `posted: 0` until the bank settles it.
  posted_at timestamptz,
  transacted_at timestamptz,
  amount_minor bigint not null,
  description text not null default '',
  payee text,
  memo text,
  pending boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint transactions_user_id_id_key unique (user_id, id),
  constraint transactions_source_key unique (user_id, account_id, source_id),
  constraint transactions_text_length check (
    char_length(source_id) <= 500
    and char_length(description) <= 2000
    and char_length(coalesce(payee, '')) <= 500
    and char_length(coalesce(memo, '')) <= 2000
  )
);

create index transactions_user_live_idx
  on public.transactions (user_id, created_at)
  where deleted_at is null;

create index transactions_account_posted_idx
  on public.transactions (account_id, posted_at)
  where deleted_at is null;

create trigger transactions_set_updated_at
  before update on public.transactions
  for each row execute function public.set_updated_at();

create trigger transactions_freeze_user_id
  before update on public.transactions
  for each row execute function public.freeze_user_id();

alter table public.transactions enable row level security;
alter table public.transactions force row level security;

create policy transactions_select_own on public.transactions
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.transactions from authenticated;
grant select on table public.transactions to authenticated;
grant select, insert, update on table public.transactions to service_role;
