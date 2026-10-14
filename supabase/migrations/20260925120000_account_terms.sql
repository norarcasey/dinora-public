-- Card terms (ACCT-10): a card's credit limit, cash-advance limit, purchase APR, and a promo
-- APR with the day it ends, as Nora enters them.
--
-- Entered, because no bank sends them. Measured 25 Sep 2026 against the Bridge's answer for
-- all 20 linked accounts, key names and signs only: none carries SimpleFIN's `extra`, and
-- `available-balance` is zero on every account that owes money and equal to the balance on
-- every other, so no limit can be derived from it either. The protocol has no APR at all.
--
-- One row per figure per date it took effect, not one row per card: a limit raised does not
-- restate the rate, and last year's rate stays readable when this year's arrives, which a
-- projection of what a balance costs will want. Written from supabase/patterns/owned_table.sql,
-- with three differences:
--
--   * No DELETE, for her or anyone. A figure entered by mistake is removed with `deleted_at`.
--   * UPDATE is granted on `deleted_at` alone, so a figure cannot be rewritten in place:
--     a new value is a new row, and the old one stays as history.
--   * Each kind carries exactly its own columns (`account_terms_shape`). A limit is integer
--     minor units in the account's currency (invariant 1); a rate is hundredths of a
--     percent, 24.99% as 2499, so it is an integer too.
--
-- The account is referenced through (user_id, account_id), so the policy's check on user_id
-- also means the account is hers, as in account_groups (20260924220000).

create table public.account_terms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id uuid not null,
  foreign key (user_id, account_id) references public.accounts (user_id, id),

  kind text not null,
  effective_on date not null,
  amount_minor bigint,
  rate_bp integer,
  ends_on date,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint account_terms_user_id_id_key unique (user_id, id),
  constraint account_terms_kind_known check (
    kind in ('credit_limit', 'cash_advance_limit', 'purchase_apr', 'promo_apr')
  ),
  -- `is not null` spelled out: a check whose expression is null passes, so `amount_minor >= 0`
  -- alone would let a limit with no amount in.
  constraint account_terms_shape check (
    case kind
      when 'credit_limit' then
        amount_minor is not null and amount_minor >= 0 and rate_bp is null and ends_on is null
      when 'cash_advance_limit' then
        amount_minor is not null and amount_minor >= 0 and rate_bp is null and ends_on is null
      when 'purchase_apr' then
        rate_bp is not null and rate_bp between 0 and 10000
          and amount_minor is null and ends_on is null
      when 'promo_apr' then
        rate_bp is not null and rate_bp between 0 and 10000
          and amount_minor is null and ends_on is not null and ends_on > effective_on
      else false
    end
  )
);

create index account_terms_user_live_idx
  on public.account_terms (user_id, account_id, effective_on)
  where deleted_at is null;

-- The device's changed-since read (apps/web/src/queries/synced.ts).
create index account_terms_user_updated_idx
  on public.account_terms (user_id, updated_at);

create trigger account_terms_set_updated_at
  before update on public.account_terms
  for each row execute function public.set_updated_at();

create trigger account_terms_freeze_user_id
  before update on public.account_terms
  for each row execute function public.freeze_user_id();

alter table public.account_terms enable row level security;
alter table public.account_terms force row level security;

create policy account_terms_select_own on public.account_terms
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy account_terms_insert_own on public.account_terms
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy account_terms_update_own on public.account_terms
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Revoked first, as for account_groups: the local image leaves `authenticated` all seven
-- default privileges, TRUNCATE included. The nightly job never touches her figures, so
-- service_role gets no grant at all.
revoke all on table public.account_terms from authenticated;
revoke all on table public.account_terms from service_role;
grant select, insert on table public.account_terms to authenticated;
grant update (deleted_at) on table public.account_terms to authenticated;
