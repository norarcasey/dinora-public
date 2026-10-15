-- A year of invented money for one@example.test, for the README's screenshots (DIN-21).
--
--   pnpm db:demo
--
-- Local only: `scripts/db/demo.ts` runs it in this checkout's own database container, so it
-- has no way to reach a deployed project. Not part of seed.sql, because the RLS tests want
-- the two users and nothing else, and a demo that ran on every `db:reset` would be the data
-- every local session saw.
--
-- Every name and figure here is made up: the banks, the payees, the amounts and the dates,
-- which are counted back from the day it runs so the pages always show a current month. Not
-- one is taken from Nora's accounts (invariant 4). Amounts follow from `hashtext`, so a rerun
-- on the same day draws the same year.
--
-- Running it again replaces the demo: it starts by removing one@example.test's rows, which
-- only a local database allows (the service role holds DELETE on nothing, invariant 2; this
-- runs as postgres).

begin;

create temporary table demo_owner on commit drop as
select '11111111-1111-1111-1111-111111111111'::uuid as id,
       (current_date - 400) as first_day,
       current_date as last_day;

delete from public.goal_plans where user_id = (select id from demo_owner);
delete from public.goal_accounts where user_id = (select id from demo_owner);
delete from public.goals where user_id = (select id from demo_owner);
delete from public.category_rules where user_id = (select id from demo_owner);
delete from public.transaction_categories where user_id = (select id from demo_owner);
delete from public.category_budgets where user_id = (select id from demo_owner);
delete from public.categories where user_id = (select id from demo_owner);
delete from public.balance_snapshots where user_id = (select id from demo_owner);
delete from public.transactions where user_id = (select id from demo_owner);
delete from public.account_terms where user_id = (select id from demo_owner);
delete from public.account_groups where user_id = (select id from demo_owner);
delete from public.accounts where user_id = (select id from demo_owner);
delete from public.bank_pulls where user_id = (select id from demo_owner);

/* ─── accounts ─────────────────────────────────────────────────────────────────────────── */

create temporary table demo_accounts (
  key text primary key,
  institution text not null,
  name text not null,
  grp text not null,
  holdings integer not null,
  opening_minor bigint not null
) on commit drop;

insert into demo_accounts values
  ('checking', 'Larkspur Credit Union', 'Everyday Checking', 'cash', 0, 320000),
  ('savings', 'Larkspur Credit Union', 'High-Yield Savings', 'cash', 0, 980000),
  ('card', 'Tidewater Bank', 'Rewards Visa', 'card', 0, 0),
  ('auto', 'Tidewater Bank', 'Auto Loan', 'loan', 0, -1460000),
  ('brokerage', 'Juniper Investments', 'Individual Brokerage', 'investment', 14, 4120000),
  ('ira', 'Juniper Investments', 'Roth IRA', 'investment', 6, 3380000);

insert into public.accounts
  (user_id, source, source_id, institution, name, currency, balance_minor, balance_at, holdings)
select o.id, 'simplefin', 'demo-' || a.key, a.institution, a.name, 'USD', 0, now(), a.holdings
from demo_accounts a cross join demo_owner o;

insert into public.account_groups (user_id, account_id, kind)
select acc.user_id, acc.id, a.grp
from public.accounts acc
join demo_accounts a on acc.source_id = 'demo-' || a.key
where acc.user_id = (select id from demo_owner);

insert into public.account_terms (user_id, account_id, kind, effective_on, amount_minor, rate_bp)
select acc.user_id, acc.id, t.kind, (select first_day from demo_owner), t.amount, t.rate
from public.accounts acc
cross join (values ('credit_limit', 1500000::bigint, null::integer),
                   ('purchase_apr', null, 2149)) as t (kind, amount, rate)
where acc.user_id = (select id from demo_owner) and acc.source_id = 'demo-card';

create temporary table demo_account_ids on commit drop as
select a.key, acc.id
from public.accounts acc
join demo_accounts a on acc.source_id = 'demo-' || a.key
where acc.user_id = (select id from demo_owner);

/* ─── transactions ─────────────────────────────────────────────────────────────────────── */

create temporary table demo_days on commit drop as
select d::date as day
from demo_owner o, generate_series(o.first_day, o.last_day, interval '1 day') as d;

create temporary table demo_tx (
  account text not null,
  day date not null,
  amount_minor bigint not null,
  payee text not null,
  category text
) on commit drop;

-- What she spends on the card: a payee every `every` days, at a price that wanders by `spread`
-- cents either side of `base` (a deterministic draw, so the year is the same on a rerun).
insert into demo_tx
select 'card', d.day,
       -(p.base + (abs(hashtext(p.payee || d.day::text)::bigint) % (2 * p.spread + 1)) - p.spread),
       p.payee, p.category
from demo_days d
cross join (values
  ('Corner Grocer', 'Groceries', 3, 0, 6800, 2600),
  ('Fernwood Market', 'Groceries', 7, 2, 11400, 3800),
  ('Harbor Coffee', 'Dining', 2, 1, 640, 180),
  ('Little Lantern Noodles', 'Dining', 9, 4, 4200, 1300),
  ('Saffron & Sage', 'Dining', 16, 6, 9600, 2800),
  ('Northline Transit', 'Transport', 7, 3, 3000, 0),
  ('Quickfuel', 'Transport', 12, 5, 4800, 900),
  ('Bramble Books', 'Shopping', 23, 11, 3400, 1400),
  ('Pinewood Outfitters', 'Shopping', 37, 19, 12800, 5200),
  ('Streamwell', 'Subscriptions', 30, 8, 1599, 0),
  ('Cloudnote', 'Subscriptions', 30, 21, 999, 0),
  ('Evergreen Gym', 'Health', 30, 2, 5500, 0),
  ('Willow Pharmacy', 'Health', 26, 13, 2200, 900)
) as p (payee, category, every, phase, base, spread)
where (d.day - (select first_day from demo_owner)) % p.every = p.phase;

-- The month's fixed lines on checking. Paid on the same day every month.
insert into demo_tx
select 'checking', d.day, f.amount, f.payee, f.category
from demo_days d
cross join (values
  (1, 485000, 'Brightwave Studio Payroll', 'Paycheck'),
  (15, 485000, 'Brightwave Studio Payroll', 'Paycheck'),
  (1, -215000, 'Maple Row Apartments', 'Rent'),
  (6, -8900, 'Pinecrest Power & Light', 'Utilities'),
  (9, -6500, 'Fibernet Home Internet', 'Utilities'),
  (12, -4500, 'Clearline Mobile', 'Utilities'),
  (18, -14200, 'Cobalt Auto Insurance', 'Transport'),
  (28, -250000, 'Juniper Investments', 'Transfers')
) as f (dom, amount, payee, category)
where extract(day from d.day) = f.dom;

-- The car: a payment from checking and its other side on the loan, paired as a transfer.
insert into demo_tx
select side.account, d.day, side.amount, side.payee, null
from demo_days d
cross join (values ('checking', -38500, 'Tidewater Auto Loan Payment'),
                   ('auto', 31200, 'Payment received')) as side (account, amount, payee)
where extract(day from d.day) = 5;

-- Into savings for the emergency fund, and the interest it earns.
insert into demo_tx
select side.account, d.day, side.amount, side.payee, null
from demo_days d
cross join (values ('checking', -90000, 'Transfer to Savings'),
                   ('savings', 90000, 'Transfer from Checking')) as side (account, amount, payee)
where extract(day from d.day) = 16;

insert into demo_tx
select 'savings', d.day, 3400 + (extract(month from d.day)::bigint * 85), 'Interest', 'Interest'
from demo_days d
where d.day = (date_trunc('month', d.day) + interval '1 month - 1 day')::date;

-- The card is paid in full on the 20th, for whatever it spent in the month before.
insert into demo_tx
select side.account, d.day, side.sign * owed.total, side.payee, null
from demo_days d
cross join lateral (
  select coalesce(-sum(t.amount_minor), 0) as total
  from demo_tx t
  where t.account = 'card'
    and t.day >= (date_trunc('month', d.day) - interval '1 month')::date
    and t.day < date_trunc('month', d.day)::date
) as owed
cross join (values ('checking', -1, 'Tidewater Card Payment'),
                   ('card', 1, 'Payment - Thank You')) as side (account, sign, payee)
where extract(day from d.day) = 20 and owed.total > 0;

-- A few this month with no rule yet, so the Categorize queue has something in it.
insert into demo_tx
select 'card', current_date - x.ago, x.amount, x.payee, null
from (values (2, -4675, 'Saturday Farmers Market'),
             (4, -2389, 'Hollis Hardware'),
             (6, -11850, 'Riverside Vet Clinic')) as x (ago, amount, payee)
where current_date - x.ago >= date_trunc('month', current_date)::date;

insert into public.transactions
  (user_id, account_id, source_id, posted_at, transacted_at, amount_minor, description, payee)
select o.id, ids.id,
       'demo-' || row_number() over (order by t.account, t.day, t.payee),
       (t.day + time '12:00') at time zone 'UTC',
       (t.day + time '12:00') at time zone 'UTC',
       t.amount_minor, upper(t.payee), t.payee
from demo_tx t
join demo_account_ids ids on ids.key = t.account
cross join demo_owner o;

/* ─── history ──────────────────────────────────────────────────────────────────────────── */

-- Banked accounts: the opening balance plus every transaction up to the day.
insert into public.balance_snapshots
  (user_id, account_id, on_date, kind, currency, balance_minor, as_of)
select o.id, ids.id, d.day, 'read', 'USD',
       a.opening_minor + coalesce((
         select sum(t.amount_minor) from demo_tx t
         where t.account = a.key and t.day <= d.day), 0)::bigint,
       (d.day + time '23:00') at time zone 'UTC'
from demo_accounts a
join demo_account_ids ids on ids.key = a.key
cross join demo_days d
cross join demo_owner o
where a.grp <> 'investment';

-- Invested accounts have no transactions here: a market that rises about 9% over the year,
-- with a dip in the spring, plus the monthly contribution into the brokerage.
insert into public.balance_snapshots
  (user_id, account_id, on_date, kind, currency, balance_minor, as_of)
select o.id, ids.id, d.day, 'read', 'USD',
       round(
         (a.opening_minor
           + case when a.key = 'brokerage'
                  then 250000 * ((d.day - o.first_day) / 30)
                  else 0 end)
         * (1 + 0.09 * (d.day - o.first_day) / 400.0
              - 0.05 * exp(-power((d.day - o.first_day - 190) / 28.0, 2))
              + 0.012 * sin((d.day - o.first_day) / 6.0)
              + 0.006 * sin((d.day - o.first_day) / 2.3))
       )::bigint,
       (d.day + time '23:00') at time zone 'UTC'
from demo_accounts a
join demo_account_ids ids on ids.key = a.key
cross join demo_days d
cross join demo_owner o
where a.grp = 'investment';

update public.accounts acc
set balance_minor = s.balance_minor, balance_at = s.as_of
from public.balance_snapshots s
where s.account_id = acc.id
  and s.on_date = (select last_day from demo_owner)
  and acc.user_id = (select id from demo_owner);

insert into public.bank_pulls
  (user_id, source, outcome, started_at, finished_at, requests, accounts, transactions)
select id, 'simplefin', 'ok', now() - interval '5 hours', now() - interval '5 hours', 1, 6, 0
from demo_owner;

/* ─── budget ───────────────────────────────────────────────────────────────────────────── */

insert into public.categories (user_id, name, kind)
select o.id, c.name, c.kind
from demo_owner o
cross join (values
  ('Groceries', 'spend'), ('Dining', 'spend'), ('Transport', 'spend'),
  ('Shopping', 'spend'), ('Subscriptions', 'spend'), ('Health', 'spend'),
  ('Rent', 'spend'), ('Utilities', 'spend'), ('Pets', 'spend'),
  ('Paycheck', 'income'), ('Interest', 'income'), ('Transfers', 'transfer')
) as c (name, kind);

insert into public.category_budgets (user_id, category_id, starts_on, amount_minor)
select c.user_id, c.id, date_trunc('month', o.first_day)::date, b.amount
from public.categories c
cross join demo_owner o
join (values ('Groceries', 90000::bigint), ('Dining', 55000), ('Transport', 42000),
             ('Shopping', 25000), ('Subscriptions', 3000), ('Health', 9000),
             ('Rent', 215000), ('Utilities', 22000), ('Pets', 8000))
  as b (name, amount) on b.name = c.name
where c.user_id = o.id;

-- One rule per payee, from the first month: how a year of card spending files itself. A
-- rule's payee is the key `normalisePayee` makes, lower case.
insert into public.category_rules (user_id, payee, category_id, starts_on)
select distinct on (t.payee) o.id, lower(t.payee), c.id, date_trunc('month', o.first_day)::date
from demo_tx t
cross join demo_owner o
join public.categories c on c.user_id = o.id and c.name = t.category
order by t.payee;

/* ─── goals ────────────────────────────────────────────────────────────────────────────── */

insert into public.goals (user_id, name, kind, target_minor, starts_on, target_on)
select o.id, g.name, g.kind, g.target, o.first_day, g.target_on
from demo_owner o
cross join (values
  ('Emergency fund', 'save', 3000000::bigint, (current_date + 290)),
  ('Car paid off', 'payoff', null, (current_date + 1030))
) as g (name, kind, target, target_on);

insert into public.goal_accounts (user_id, goal_id, account_id)
select g.user_id, g.id, ids.id
from public.goals g
join demo_account_ids ids
  on ids.key = case g.name when 'Emergency fund' then 'savings' else 'auto' end
where g.user_id = (select id from demo_owner);

insert into public.goal_plans (user_id, goal_id, starts_on, amount_minor)
select g.user_id, g.id, date_trunc('month', o.first_day)::date,
       case g.name when 'Emergency fund' then 90000 else 31200 end
from public.goals g
cross join demo_owner o
where g.user_id = o.id;

commit;
