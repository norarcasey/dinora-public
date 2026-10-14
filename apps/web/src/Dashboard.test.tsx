import type { AssetRow, AssetValueRow } from '@dinora/core/assets';
import type { AccountRow, PullRow } from '@dinora/core/balances';
import type { BudgetRow, CategoryRow, TransactionRow } from '@dinora/core/budgets';
import type { GoalAccountRow, GoalRow } from '@dinora/core/goals';
import type { Group, GroupRow } from '@dinora/core/groups';
import type { SnapshotRow } from '@dinora/core/history';
import type { RateRow } from '@dinora/core/rates';
import type { TermRow } from '@dinora/core/terms';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncedRows } from './queries/synced.ts';

const NOW = Date.parse('2026-09-24T12:00:00Z');

const state: {
  accounts: SyncedRows<AccountRow>;
  pulls: SyncedRows<PullRow>;
  rates: SyncedRows<RateRow>;
  snapshots: SyncedRows<SnapshotRow>;
  groups: SyncedRows<GroupRow>;
  terms: SyncedRows<TermRow>;
  assets: SyncedRows<AssetRow>;
  values: SyncedRows<AssetValueRow>;
  goals: SyncedRows<GoalRow>;
  links: SyncedRows<GoalAccountRow>;
  transactions: SyncedRows<TransactionRow>;
  categories: SyncedRows<CategoryRow>;
  budgets: SyncedRows<BudgetRow>;
  online: boolean;
} = {
  accounts: { status: 'waiting' },
  pulls: { status: 'waiting' },
  rates: { status: 'waiting' },
  snapshots: { status: 'waiting' },
  groups: { status: 'waiting' },
  terms: { status: 'waiting' },
  assets: { status: 'waiting' },
  values: { status: 'waiting' },
  goals: { status: 'waiting' },
  links: { status: 'waiting' },
  transactions: { status: 'waiting' },
  categories: { status: 'waiting' },
  budgets: { status: 'waiting' },
  online: true,
};

vi.mock('./queries/synced.ts', () => ({
  useSynced: (table: { name: string }) => {
    switch (table.name) {
      case 'accounts':
        return state.accounts;
      case 'fx_rates':
        return state.rates;
      case 'balance_snapshots':
        return state.snapshots;
      case 'account_groups':
        return state.groups;
      case 'account_terms':
        return state.terms;
      case 'assets':
        return state.assets;
      case 'asset_values':
        return state.values;
      case 'goals':
        return state.goals;
      case 'goal_accounts':
        return state.links;
      case 'transactions':
        return state.transactions;
      case 'categories':
        return state.categories;
      case 'category_budgets':
        return state.budgets;
      case 'transaction_categories':
      case 'category_rules':
        return { status: 'waiting' };
      default:
        return state.pulls;
    }
  },
  defineSynced: (spec: { name: string }) => ({ ...spec, queryKey: ['synced', spec.name] }),
}));
vi.mock('./queries/groups.ts', () => ({
  ACCOUNT_GROUPS: { name: 'account_groups', queryKey: ['synced', 'account_groups'] },
}));
vi.mock('./queries/terms.ts', () => ({
  ACCOUNT_TERMS: { name: 'account_terms', queryKey: ['synced', 'account_terms'] },
}));
vi.mock('./queries/assets.ts', () => ({
  ASSETS: { name: 'assets', queryKey: ['synced', 'assets'] },
  ASSET_VALUES: { name: 'asset_values', queryKey: ['synced', 'asset_values'] },
}));
vi.mock('./queries/goals.ts', () => ({
  GOALS: { name: 'goals', queryKey: ['synced', 'goals'] },
  GOAL_ACCOUNTS: { name: 'goal_accounts', queryKey: ['synced', 'goal_accounts'] },
}));
vi.mock('./queries/budgets.ts', () => ({
  TRANSACTIONS: { name: 'transactions', queryKey: ['synced', 'transactions'] },
  CATEGORIES: { name: 'categories', queryKey: ['synced', 'categories'] },
  CATEGORY_BUDGETS: { name: 'category_budgets', queryKey: ['synced', 'category_budgets'] },
  TRANSACTION_CATEGORIES: {
    name: 'transaction_categories',
    queryKey: ['synced', 'transaction_categories'],
  },
  CATEGORY_RULES: { name: 'category_rules', queryKey: ['synced', 'category_rules'] },
}));
vi.mock('./device/useOnline.ts', () => ({ useOnline: () => state.online }));
vi.mock('./supabase/client.ts', () => ({
  auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
}));

const { Dashboard } = await import('./Dashboard.tsx');

function account(overrides: Partial<AccountRow>): AccountRow {
  return {
    id: 'a',
    updated_at: '2026-09-24T09:00:00+00:00',
    deleted_at: null,
    institution: 'Bank of America',
    name: 'Visa Signature',
    currency: 'USD',
    balance_minor: 0,
    balance_at: '2026-09-24T09:00:00+00:00',
    holdings: 0,
    source: 'simplefin',
    ...overrides,
  };
}

function pull(outcome: PullRow['outcome'], at: string, detail = '', source = 'simplefin'): PullRow {
  return {
    id: `${source}-${at}`,
    updated_at: at,
    deleted_at: null,
    source,
    outcome,
    finished_at: at,
    detail,
  };
}

function rate(overrides: Partial<RateRow> = {}): RateRow {
  return {
    id: 'r',
    updated_at: '2026-09-24T09:00:00+00:00',
    deleted_at: null,
    source: 'ecb',
    base: 'EUR',
    quote: 'USD',
    rate_date: '2026-09-23',
    rate: '1.1411',
    ...overrides,
  };
}

function snap(accountId: string, onDate: string, minor: number, kind: SnapshotRow['kind']) {
  return {
    id: `${accountId}-${onDate}`,
    updated_at: '2026-09-24T09:00:00+00:00',
    deleted_at: null,
    account_id: accountId,
    on_date: onDate,
    kind,
    currency: 'USD',
    balance_minor: minor,
    as_of: `${onDate}T09:00:00+00:00`,
  } satisfies SnapshotRow;
}

function chosen(accountId: string, kind: Group): GroupRow {
  return {
    id: `g-${accountId}`,
    updated_at: '2026-09-24T10:00:00+00:00',
    deleted_at: null,
    account_id: accountId,
    kind,
  };
}

function held<Row>(rows: Row[], extra: { stale?: boolean; asOf?: number } = {}): SyncedRows<Row> {
  return {
    status: 'held',
    rows,
    asOf: extra.asOf ?? NOW,
    refreshing: false,
    stale: extra.stale ?? false,
  };
}

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Dashboard />
    </QueryClientProvider>,
  );
}

/** Text as a person reads it: Intl's no-break spaces are spaces. */
function text(element: Element = document.body): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ');
}

function group(name: string): HTMLElement {
  return screen.getByRole('region', { name: new RegExp(`^${name}`) });
}

/** The accounts she linked on 24 Sep, in shape: every group has members. */
const LINKED = [
  account({ id: 'card', name: 'Customized Cash Rewards Visa Signature', balance_minor: -123_456 }),
  account({
    id: 'checking',
    name: 'Member Advantage Checking',
    institution: 'PSCU',
    balance_minor: 500_000,
  }),
  account({ id: 'auto', name: 'Auto Loan', institution: 'PSCU', balance_minor: -1_000_000 }),
  account({ id: 'loc', name: 'Line of Credit', institution: 'PSCU', balance_minor: -20_000 }),
  account({
    id: 'roth',
    name: 'Roth IRA',
    institution: 'Contoso Capital',
    balance_minor: 2_000_000,
    holdings: 1,
  }),
];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.accounts = { status: 'waiting' };
  state.pulls = { status: 'waiting' };
  state.rates = { status: 'waiting' };
  state.snapshots = { status: 'waiting' };
  state.groups = { status: 'waiting' };
  state.terms = { status: 'waiting' };
  state.assets = { status: 'waiting' };
  state.values = { status: 'waiting' };
  state.goals = { status: 'waiting' };
  state.links = { status: 'waiting' };
  state.transactions = { status: 'waiting' };
  state.categories = { status: 'waiting' };
  state.budgets = { status: 'waiting' };
  state.online = true;
  localStorage.clear();
});

describe('before anything is held', () => {
  it('shows nothing while the disk and the server have not answered', () => {
    show();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when nothing was saved and the server cannot be reached', () => {
    state.accounts = { status: 'failed' };
    show();
    expect(screen.getByRole('alert').textContent).toContain('could not be reached');
  });

  it('says when no account is linked', () => {
    state.accounts = held([]);
    show();
    expect(text()).toContain('No accounts are linked yet.');
  });
});

describe('net worth, cash, investments and debt', () => {
  beforeEach(() => {
    state.accounts = held(LINKED);
  });

  it('sums every account with no flip, a card owed negative', () => {
    show();
    // 5,000 + 20,000 - 1,234.56 - 10,000 - 200 = 13,565.44
    expect(text(document.querySelector('.hero') ?? document.body)).toContain('$13,565.44');
    expect(text()).toContain('Net worth · 5 accounts, all in USD');
  });

  it('shows debt as the amount owed, cards and loans together, the line of credit included', () => {
    show();
    const tiles = text(document.querySelector('.tiles') ?? document.body);
    expect(tiles).toContain('Cash$5,000.00');
    expect(tiles).toContain('Investments$20,000.00');
    // 1,234.56 + 10,000 + 200: the line of credit is a loan or a card, debt either way.
    expect(tiles).toContain('Debt owed$11,434.56');
  });

  it("keys each tile in its side's colour from the chart, beside its name (UI-05)", () => {
    show();
    const swatches = [...document.querySelectorAll('.tiles .swatch')].map((i) => i.className);
    expect(swatches).toEqual(['swatch cash', 'swatch investments', 'swatch debt']);
  });

  it('says which counts rest on a guess', () => {
    show();
    // Checking, the card, the auto loan and the Roth IRA; the line of credit is waiting on her.
    expect(text()).toContain('5 of these accounts are counted by a guess at their group.');
  });

  it('says how many count in none until she chooses', () => {
    state.accounts = held([account({ id: 'x', name: 'Everyday', balance_minor: 100 })]);
    show();
    expect(text()).toContain('1 account is in none of these until you say which group it is in.');
    expect(text(document.querySelector('.tiles') ?? document.body)).toContain('Cash$0.00');
  });

  it('nets a euro account in dollars at the newest rate, and names the rate and its date', () => {
    state.accounts = held([
      account({ id: 'a', balance_minor: -120_000 }),
      account({
        id: 'b',
        currency: 'EUR',
        balance_minor: 250_000,
        name: 'Cuenta Online',
        institution: 'Ejemplo',
      }),
    ]);
    state.rates = held([rate({ id: 'old', rate_date: '2026-09-22', rate: '1.1463' }), rate()]);
    show();
    // 2,500.00 EUR at 1.1411 is 2,852.75 USD, less 1,200.00 on the card.
    expect(text(document.querySelector('.hero') ?? document.body)).toContain('$1,652.75');
    expect(text()).toMatch(/€2,500\.00 is \$2,852\.75 at 1 EUR = 1\.1411 USD/);
    expect(document.querySelector('.rate time')?.getAttribute('dateTime')).toBe('2026-09-23');
  });

  it('switches the whole dashboard into euros, reading the published rate backwards and naming it', () => {
    state.accounts = held([
      account({ id: 'a', balance_minor: -120_000 }),
      account({
        id: 'b',
        currency: 'EUR',
        balance_minor: 250_000,
        name: 'Cuenta Online',
        institution: 'Ejemplo',
      }),
    ]);
    state.groups = held([chosen('a', 'card'), chosen('b', 'cash')]);
    // The same rate a month before, so the month's change is all saving and no rate.
    state.rates = held([rate({ id: 'aug', rate_date: '2026-08-31' }), rate()]);
    state.snapshots = held([
      snap('a', '2026-08-31', -150_000, 'read'),
      snap('a', '2026-09-23', -120_000, 'read'),
      { ...snap('b', '2026-08-31', 250_000, 'read'), currency: 'EUR' },
      { ...snap('b', '2026-09-23', 250_000, 'read'), currency: 'EUR' },
    ]);
    show();
    const hero = () => document.querySelector('.hero') ?? document.body;
    const tiles = () => text(document.querySelector('.tiles') ?? document.body);
    const month = () => screen.getByRole('region', { name: /What changed this month/ });
    expect(screen.getByRole('radio', { name: 'In dollars' })).toHaveProperty('checked', true);
    expect(tiles()).toContain('Debt owed$1,200.00');
    fireEvent.click(screen.getByRole('radio', { name: 'In euros' }));
    // 1,200.00 USD owed at 1 EUR = 1.1411 USD is 1,051.62 EUR, from 2,500.00 EUR held.
    expect(text(hero())).toContain('all in EUR');
    expect(text(hero())).toContain('€1,448.38');
    expect(text(hero())).toMatch(/-\$1,200\.00 is -€1,051\.62 at 1 EUR = 1\.1411 USD/);
    expect(document.querySelector('.rate time')?.getAttribute('dateTime')).toBe('2026-09-23');
    // The tiles, the groups, the chart and the month follow it (DIN-10).
    expect(tiles()).toContain('Cash€2,500.00');
    expect(tiles()).toContain('Debt owed€1,051.62');
    expect(text(group('Credit cards'))).toContain('-€1,051.62');
    fireEvent.focus(screen.getByRole('img'));
    expect(tip()).toContain('€1,448.38');
    // $300 paid off at 1.1411 is €262.90; the rate did not move, so nothing else changed.
    expect(text(month().querySelector('h2') ?? month())).toBe('What changed this month+€262.90');
    // Its rate named as the ECB published it, not turned round into a rate it never gave.
    expect(text(month())).toContain('1 EUR = 1.1411 USD on');
    expect(text(month())).not.toContain('1 USD =');
    // An account's own balance stays in its own currency.
    expect(text(group('Credit cards'))).toContain('-$1,200.00');

    // Remembered on this device: opened again, it is still in euros.
    cleanup();
    show();
    expect(screen.getByRole('radio', { name: 'In euros' })).toHaveProperty('checked', true);
    expect(text(hero())).toContain('€1,448.38');
    fireEvent.click(screen.getByRole('radio', { name: 'In dollars' }));
    expect(text(hero())).toContain('$1,652.75');
    expect(tiles()).toContain('Debt owed$1,200.00');
  });

  it('leaves the net unsaid, and says why, until a rate has been read', () => {
    state.accounts = held([account({ currency: 'EUR', balance_minor: 1 })]);
    state.rates = held([]);
    show();
    expect(text()).toContain('no exchange rate from EUR has been read');
    expect(document.querySelector('.hero-value')).toBeNull();
  });

  it('marks a rate the nightly read has not replaced in a week', () => {
    state.accounts = held([account({ currency: 'EUR', balance_minor: 1 })]);
    state.rates = held([rate({ rate_date: '2026-09-14' })]);
    show();
    expect(document.querySelector('.rate.stale')).not.toBeNull();
  });
});

describe('the groups', () => {
  beforeEach(() => {
    state.accounts = held(LINKED);
  });

  it('lists each account under its guessed group, marked as a guess', () => {
    show();
    expect(text(group('Credit cards'))).toContain('Customized Cash Rewards Visa Signature Guess');
    expect(text(group('Cash'))).toContain('Member Advantage Checking');
    expect(text(group('Loans'))).toContain('Auto Loan');
    expect(text(group('Investments'))).toContain('Roth IRA');
    expect(text(group('Investments'))).toContain('$20,000.00');
  });

  it("heads each group with how many accounts it holds and the group's total", () => {
    state.groups = held([chosen('loc', 'loan')]);
    show();
    const heading = within(group('Loans')).getByRole('heading');
    expect(text(heading)).toContain('Loans 2 accounts');
    expect(text(heading)).toContain('10,200.00');
    expect(text(within(group('Cash')).getByRole('heading'))).toContain('Cash 1 account');
  });

  it('starts each group closed on its total, and leaves the question open', () => {
    state.assets = held([]);
    state.values = held([]);
    show();
    for (const name of ['Cash', 'Credit cards', 'Loans', 'Investments']) {
      expect(group(name).querySelector('details')?.open).toBe(false);
    }
    expect(group('Which group').querySelector('details')).toBeNull();
    // Empty, Property is only the way to add something, so it is not folded away.
    expect(group('Property').querySelector('details')?.open).toBe(true);
  });

  it("rules each group in its side's colour, cards and loans both debt, the question in none (UI-05)", () => {
    show();
    expect(group('Cash').classList.contains('cash')).toBe(true);
    expect(group('Credit cards').classList.contains('debt')).toBe(true);
    expect(group('Loans').classList.contains('debt')).toBe(true);
    expect(group('Investments').classList.contains('investments')).toBe(true);
    expect(group('Property').classList.contains('property')).toBe(true);
    expect(group('Which group').className).toBe('group');
  });

  it('asks about the line of credit rather than guess, and edits nothing', () => {
    show();
    const waiting = group('Which group');
    expect(text(waiting)).toContain('Line of Credit');
    expect(text(waiting)).toContain('Open it to choose.');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('puts an account where she set it, with no guess shown', () => {
    state.groups = held([chosen('loc', 'card')]);
    show();
    expect(text(group('Credit cards'))).toContain('Line of Credit');
    expect(screen.queryByRole('region', { name: /^Which group/ })).toBeNull();
  });
});

describe('each account', () => {
  beforeEach(() => {
    state.accounts = held(LINKED);
  });

  it('opens its details from its name (ACCT-10)', () => {
    show();
    const link = screen.getByRole('link', { name: 'Auto Loan' });
    expect(link.getAttribute('href')).toBe('#/account/auto');
  });

  it("shows what a card's entered limit leaves, and nothing where none is entered", () => {
    state.terms = held([
      {
        id: 't',
        updated_at: '2026-09-24T10:00:00+00:00',
        deleted_at: null,
        account_id: 'card',
        kind: 'credit_limit',
        effective_on: '2026-01-01',
        amount_minor: 1_000_000,
        rate_bp: null,
        ends_on: null,
      },
    ]);
    show();
    expect(text(group('Credit cards'))).toContain('$8,765.44 available');
    expect(text(group('Loans'))).not.toContain('available');
  });
});

describe('each balance', () => {
  it('is dated by the bank’s own time', () => {
    state.accounts = held([account({ balance_at: '2026-09-24T09:00:00+00:00' })]);
    show();
    expect(text()).toContain('As of 3 hours ago');
  });

  it('turns amber, with a clock, once the bank has missed a night (UI-06)', () => {
    state.accounts = held([account({ balance_at: '2026-09-21T09:00:00+00:00' })]);
    show();
    expect(text()).toContain('Not updated since 3 days ago');
    expect(document.querySelector('.age.stale')).not.toBeNull();
  });
});

/** The chart's tooltip, as read. */
function tip(): string {
  return text(document.querySelector('.tooltip') ?? document.body);
}

describe('the chart', () => {
  beforeEach(() => {
    state.accounts = held([
      account({ id: 'card', balance_minor: -10_000 }),
      account({ id: 'roth', name: 'Roth IRA', balance_minor: 50_000, holdings: 1 }),
    ]);
  });

  // Nora, 27 Sep 2026: nothing by the title, and nothing on where a figure came from.
  it('says nothing around the chart but its switches', () => {
    state.snapshots = held([
      snap('card', '2026-09-21', -12_000, 'rebuilt'),
      snap('card', '2026-09-22', -11_000, 'rebuilt'),
      snap('card', '2026-09-23', -10_000, 'read'),
      snap('roth', '2026-09-23', 50_000, 'read'),
    ]);
    show();
    expect(screen.queryByRole('button', { name: 'What this line rests on' })).toBeNull();
    expect(text()).not.toContain('the line leaves out');
    expect(text()).not.toContain('rebuilt, not read');
    expect(document.querySelector('.marker')).toBeNull();
  });

  // Nora, 27 Sep 2026: where a figure came from is not worth a key.
  it("draws Monarch's, rebuilt and read days as one line, with no key", () => {
    state.snapshots = held([
      snap('card', '2026-09-20', -13_000, 'monarch'),
      snap('card', '2026-09-21', -12_000, 'monarch'),
      snap('card', '2026-09-22', -11_000, 'rebuilt'),
      snap('card', '2026-09-23', -10_000, 'read'),
      snap('roth', '2026-09-20', 50_000, 'monarch'),
      snap('roth', '2026-09-23', 50_000, 'read'),
    ]);
    show();
    expect(document.querySelectorAll('polyline.line.net')).toHaveLength(1);
    expect(document.querySelector('.chart-key')).toBeNull();
    for (const said of ['Monarch', 'Rebuilt', 'Read from the bank', 'How it is known']) {
      expect(text(document.querySelector('.chart') ?? document.body)).not.toContain(said);
    }
  });

  // Nora, 27 Sep 2026: no table under the chart; a day is read from its tooltip.
  it('reads each day from its tooltip, with the accounts it leaves out, and has no table', () => {
    state.snapshots = held([
      snap('card', '2026-09-22', -11_000, 'rebuilt'),
      snap('card', '2026-09-23', -10_000, 'read'),
      snap('roth', '2026-09-23', 50_000, 'read'),
    ]);
    show();
    expect(document.querySelector('.chart-table')).toBeNull();
    expect(text()).not.toContain('Show as a table');
    const chart = screen.getByRole('img');
    fireEvent.focus(chart);
    expect(tip()).toBe('$400.00Wed, Sep 23, 2026');
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(tip()).toContain('Leaves out 1 account');
    fireEvent.click(screen.getByRole('radio', { name: 'Stacked' }));
    expect(document.querySelector('.chart-table')).toBeNull();
  });

  it('reads a day on hover and from the keyboard', () => {
    state.snapshots = held([
      snap('card', '2026-09-22', -11_000, 'rebuilt'),
      snap('card', '2026-09-23', -10_000, 'read'),
    ]);
    show();
    const chart = screen.getByRole('img');
    fireEvent.focus(chart);
    expect(text(document.querySelector('.tooltip') ?? document.body)).toContain('-$100.00');
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(text(document.querySelector('.tooltip') ?? document.body)).toContain('-$110.00');
    fireEvent.blur(chart);
    expect(document.querySelector('.tooltip')).toBeNull();
  });

  it('draws one side at a time, debt as owed, in its own words', () => {
    state.snapshots = held([
      snap('card', '2026-09-22', -11_000, 'rebuilt'),
      snap('card', '2026-09-23', -10_000, 'read'),
      snap('roth', '2026-09-23', 50_000, 'read'),
    ]);
    show();
    expect(screen.getByRole('heading', { name: 'Net worth by day' })).toBeDefined();
    fireEvent.click(screen.getByRole('radio', { name: 'Debt owed' }));
    expect(screen.getByRole('heading', { name: 'Debt owed by day' })).toBeDefined();
    expect(document.querySelectorAll('polyline.line.debt')).toHaveLength(1);
    fireEvent.focus(screen.getByRole('img'));
    expect(tip()).toContain('$100.00');
    expect(tip()).not.toContain('-$100.00');

    fireEvent.click(screen.getByRole('radio', { name: 'Investments' }));
    // The Roth joins on its first night; the day before counts no investment.
    const chart = screen.getByRole('img');
    fireEvent.focus(chart);
    expect(tip()).toContain('$500.00');
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(tip()).toContain('Leaves out 1 account');
  });

  it('says a side with no account in it is empty, rather than draw it flat', () => {
    state.snapshots = held([snap('card', '2026-09-23', -10_000, 'read')]);
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'Cash' }));
    expect(text()).toContain('No account counts as cash yet.');
  });

  it('stacks the four sides, debt below zero, with the net over them', () => {
    state.snapshots = held([
      snap('card', '2026-09-22', -11_000, 'rebuilt'),
      snap('card', '2026-09-23', -10_000, 'read'),
      snap('roth', '2026-09-23', 50_000, 'read'),
    ]);
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'Stacked' }));
    expect(
      screen.getByRole('heading', { name: 'Cash, investments, property and debt' }),
    ).toBeDefined();
    expect(text()).toContain('Each day.');
    expect(text()).not.toContain('Paler columns');
    expect(document.querySelectorAll('.column')).toHaveLength(2);
    expect(document.querySelectorAll('.column rect.segment.debt')).toHaveLength(2);
    expect(document.querySelectorAll('.column rect.segment.investments')).toHaveLength(1);

    fireEvent.focus(screen.getByRole('img'));
    expect(tip()).toContain('Investments $500.00');
    expect(tip()).toContain('Debt owed $100.00');
    expect(tip()).toContain('Net worth $400.00');
  });

  // UI-07: two years drawn whole left last month a few pixels wide, under dates with no year.
  it('opens on a year, narrows to a month, and dates its ends with their years', () => {
    state.snapshots = held([
      snap('card', '2024-09-23', -30_000, 'monarch'),
      snap('card', '2025-06-01', -11_000, 'rebuilt'),
      snap('card', '2026-09-23', -10_000, 'read'),
    ]);
    show();
    const drawn = () => screen.getByRole('img').getAttribute('aria-label') ?? '';
    const ticks = () => [...document.querySelectorAll('text.tick.date')].map((tick) => text(tick));
    expect(screen.getByRole('radio', { name: 'One year' })).toHaveProperty('checked', true);
    expect(drawn()).toContain('Tue, Sep 23, 2025 to Wed, Sep 23, 2026');
    expect(ticks()).toContain('Sep 23, 2025');
    // The axis runs on through the year ahead, to where the projection ends.
    expect(ticks()).toContain('Jan 2027');
    expect(ticks()[ticks().length - 1]).toBe('Sep 23, 2027');

    fireEvent.click(screen.getByRole('radio', { name: 'One month' }));
    expect(drawn()).toContain('Sun, Aug 23, 2026 to Wed, Sep 23, 2026');
    expect(ticks()[0]).toBe('Aug 23, 2026');

    fireEvent.click(screen.getByRole('radio', { name: 'All of it' }));
    expect(drawn()).toContain('Mon, Sep 23, 2024 to Wed, Sep 23, 2026');

    // The first week of the year began on Monday 29 Dec; the axis starts where the range does.
    fireEvent.click(screen.getByRole('radio', { name: 'Year to date' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Stacked' }));
    expect(text()).toContain('Each week');
    expect(ticks()[0]).toBe('Jan 1, 2026');
  });

  it('says there is nothing to draw before the first night', () => {
    state.snapshots = held([]);
    show();
    expect(text()).toContain('Nothing to draw yet.');
  });
});

describe('when the bank was last read', () => {
  beforeEach(() => {
    state.accounts = held([account({})]);
  });

  it('shows the newest successful read', () => {
    state.pulls = held([pull('ok', '2026-09-24T11:00:00+00:00')]);
    show();
    expect(text()).toContain('Banks last read 1 hour ago.');
  });

  it('shows a failure newer than it, with its detail', () => {
    state.pulls = held([
      pull('ok', '2026-09-23T09:00:00+00:00'),
      pull('failed', '2026-09-24T09:00:00+00:00', 'bridge 503 twice'),
    ]);
    show();
    expect(text()).toContain('Banks last read yesterday.');
    expect(screen.getByRole('alert').textContent).toContain('bridge 503 twice');
  });

  it('says when no read has ever succeeded', () => {
    state.pulls = held([]);
    show();
    expect(text()).toContain('The banks have not been read yet.');
  });

  it("names each source once there are two, and keeps one's failure from the other's success", () => {
    state.pulls = held([
      pull('ok', '2026-09-23T09:00:00+00:00'),
      pull('failed', '2026-09-24T10:59:00+00:00', 'bridge 503 twice'),
      pull('ok', '2026-09-24T11:00:00+00:00', '', 'plaid'),
    ]);
    show();
    expect(text()).toContain('Banks last read: Plaid 1 hour ago, SimpleFIN yesterday.');
    expect(screen.getByRole('alert').textContent).toContain(
      'The SimpleFIN read 1 hour ago failed: bridge 503 twice',
    );
  });

  it('shows what a successful read complained of, named, and not as a failure', () => {
    state.pulls = held([
      pull(
        'ok',
        '2026-09-24T11:00:00+00:00',
        'con.auth: Connection to PSCU may need attention.; con.auth: Connection to Northwind may need attention.',
      ),
    ]);
    show();
    expect(text()).toContain("SimpleFIN's last read came with 2 warnings:");
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(
      expect.arrayContaining([
        'Connection to PSCU may need attention.',
        'Connection to Northwind may need attention.',
      ]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists under a warning the accounts of the bank it names, each a way to its page', () => {
    state.accounts = held([
      account({ id: 'v', institution: 'Northwind', name: 'Retirement Savings' }),
      account({ id: 'b', institution: 'PSCU', name: 'Auto Loan' }),
      account({ id: 'c', institution: 'Citibank', name: 'Double Cash' }),
    ]);
    state.pulls = held([
      pull(
        'ok',
        '2026-09-24T11:00:00+00:00',
        'con.auth: Connection to PSCU may need attention.; con.auth: Connection to Northwind may need attention.',
      ),
    ]);
    show();
    const warning = screen.getByText("SimpleFIN's last read came with 2 warnings:").parentElement;
    if (warning === null) throw new Error('no warning');
    const links = within(warning).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Auto Loan', '#/account/b'],
      ['Retirement Savings', '#/account/v'],
    ]);
  });

  it('lists nothing under a warning that names no bank it holds', () => {
    state.accounts = held([account({ id: 'c', institution: 'Citibank', name: 'Double Cash' })]);
    state.pulls = held([pull('ok', '2026-09-24T11:00:00+00:00', 'gen.err: try again later')]);
    show();
    const warning = screen.getByText("SimpleFIN's last read came with a warning:").parentElement;
    if (warning === null) throw new Error('no warning');
    expect(within(warning).queryAllByRole('link')).toHaveLength(0);
  });

  it('says an account Monarch had and a bank now reads may be counted twice (BANK-15)', () => {
    state.accounts = held([
      account({
        id: 'm',
        source: 'monarch',
        institution: 'Monarch',
        name: 'MERIDIAN 401(K) - **0717 (...0717)',
      }),
      account({ id: 'b', institution: 'Vanguard', name: 'MERIDIAN 401(K) - 550717' }),
      account({ id: 'c', institution: 'Citibank', name: 'Double Cash (0717)', currency: 'EUR' }),
    ]);
    show();
    const flag = screen.getByText(/This account may be counted twice/).parentElement;
    if (flag === null) throw new Error('no flag');
    expect(
      within(flag)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['MERIDIAN 401(K) - **0717 (...0717)', '#/account/m'],
      ['MERIDIAN 401(K) - 550717', '#/account/b'],
    ]);
    expect(flag.textContent).toContain('from Vanguard.');
    expect(within(flag).getByRole('button', { name: 'Put these together' })).toBeTruthy();
  });

  it('says nothing of a pair already put together', () => {
    state.accounts = held([
      account({
        id: 'm',
        source: 'monarch',
        name: 'MERIDIAN 401(K) (...0717)',
        deleted_at: '2026-09-26T18:00:00+00:00',
      }),
      account({ id: 'b', name: 'MERIDIAN 401(K) - 550717' }),
    ]);
    show();
    expect(screen.queryByText(/counted twice/)).toBeNull();
  });

  it('says a source has not been read yet beside one that has', () => {
    state.pulls = held([
      pull('ok', '2026-09-24T11:00:00+00:00'),
      pull('failed', '2026-09-24T11:00:00+00:00', 'not configured', 'plaid'),
    ]);
    show();
    expect(text()).toContain('Banks last read: Plaid not yet, SimpleFIN 1 hour ago.');
    expect(screen.getByRole('alert').textContent).toContain('The Plaid read');
  });

  it('offers to sign a Plaid bank in again under the failure that asks for it (BANK-12)', () => {
    state.pulls = held([
      pull('ok', '2026-09-24T11:00:00+00:00'),
      pull('ok', '2026-09-23T11:00:00+00:00', '', 'plaid'),
      pull(
        'failed',
        '2026-09-24T11:00:00+00:00',
        'Harbor Mortgage needs signing in again',
        'plaid',
      ),
    ]);
    show();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
  });

  it('offers nothing for a Plaid failure it cannot fix, or for SimpleFIN', () => {
    state.pulls = held([
      pull('failed', '2026-09-24T11:00:00+00:00', 'PSCU needs signing in again'),
      pull('failed', '2026-09-24T11:00:00+00:00', 'item 1: Plaid refused /accounts/get', 'plaid'),
    ]);
    show();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });

  it('offers it under the warning when the read kept the other banks (BANK-10)', () => {
    state.pulls = held([
      pull('ok', '2026-09-24T11:00:00+00:00'),
      pull('ok', '2026-09-24T11:00:00+00:00', 'Harbor Mortgage needs signing in again', 'plaid'),
    ]);
    show();
    expect(text()).toContain("Plaid's last read came with a warning:");
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toContain(
      'Harbor Mortgage needs signing in again',
    );
    expect(screen.getAllByRole('button', { name: 'Sign in again' })).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers it once when a failure and a warning both ask for it', () => {
    state.pulls = held([
      pull('ok', '2026-09-23T11:00:00+00:00', "item 2's bank needs signing in again", 'plaid'),
      pull(
        'failed',
        '2026-09-24T11:00:00+00:00',
        'Harbor Mortgage needs signing in again',
        'plaid',
      ),
    ]);
    show();
    expect(screen.getAllByRole('button', { name: 'Sign in again' })).toHaveLength(1);
  });

  it('links a SimpleFIN bank that wants signing in to the Bridge, and names its accounts (BANK-13)', () => {
    state.accounts = held([
      account({ id: 'v', name: 'Retirement Savings', institution: 'Northwind' }),
    ]);
    state.pulls = held([
      pull('ok', '2026-09-24T11:00:00+00:00', 'Northwind needs signing in again'),
    ]);
    show();
    const link = screen.getByRole('link', { name: 'Sign in again at SimpleFIN' });
    expect(link.getAttribute('href')).toBe('https://beta-bridge.simplefin.org/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getAllByRole('link', { name: 'Retirement Savings' })).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });

  it('names the account a SimpleFIN row was left out of, and offers no sign-in for it', () => {
    state.pulls = held([
      pull(
        'ok',
        '2026-09-24T11:00:00+00:00',
        "Vanguard's 401(K) PLAN was left out: its currency is not an ISO 4217 code",
      ),
    ]);
    show();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toContain(
      "Vanguard's 401(K) PLAN was left out: its currency is not an ISO 4217 code",
    );
    expect(screen.queryByRole('link', { name: 'Sign in again at SimpleFIN' })).toBeNull();
  });

  it('offers it with one source too', () => {
    state.pulls = held([
      pull('failed', '2026-09-24T11:00:00+00:00', "item 2's bank needs signing in again", 'plaid'),
    ]);
    show();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
  });
});

describe('offline', () => {
  it('says it is showing what this device last read, and how old that is', () => {
    state.online = false;
    state.accounts = held([account({})], { asOf: NOW - 2 * 3_600_000 });
    show();
    expect(screen.getByRole('status').textContent).toMatch(
      /Offline\. Showing what this device last read, 2 hours ago/,
    );
  });

  it('says the server could not be reached when the network is up but the read failed', () => {
    state.accounts = held([account({})], { stale: true });
    show();
    expect(screen.getByRole('status').textContent).toContain('Dinora could not be reached.');
  });
});

describe('property (ACCT-06)', () => {
  function owned(overrides: Partial<AssetRow>): AssetRow {
    return {
      id: 'home',
      updated_at: '2026-09-24T09:00:00+00:00',
      deleted_at: null,
      name: 'Apartment',
      kind: 'home',
      currency: 'USD',
      acquired_on: null,
      cost_minor: null,
      financed_by: null,
      address: null,
      postal_code: null,
      vin: null,
      odometer_miles: null,
      odometer_on: null,
      metal: null,
      metal_mg: null,
      fineness: null,
      coin: null,
      coin_quantity: null,
      ...overrides,
    };
  }

  function valued(
    assetId: string,
    on: string,
    minor: number,
    source: AssetValueRow['source'] = 'entered',
  ): AssetValueRow {
    return {
      id: `${assetId}-${on}`,
      updated_at: '2026-09-24T09:00:00+00:00',
      deleted_at: null,
      asset_id: assetId,
      valued_on: on,
      amount_minor: minor,
      source,
      provider: source === 'estimate' ? 'rentcast' : null,
      low_minor: null,
      high_minor: null,
      coin_quantity: null,
      created_at: `${on}T09:00:00+00:00`,
    };
  }

  beforeEach(() => {
    state.accounts = held([
      account({ id: 'checking', name: 'Checking', institution: 'PSCU', balance_minor: 100_000 }),
      account({ id: 'auto', name: 'Auto Loan', institution: 'PSCU', balance_minor: -1_800_000 }),
    ]);
    state.rates = held([]);
  });

  it('offers to add something before anything is owned', () => {
    state.assets = held([]);
    state.values = held([]);
    show();
    const property = group('Property');
    expect(text(property)).toContain('counts in net worth at the value you give it');
    expect(within(property).getByRole('link', { name: 'Add something you own' })).toBeDefined();
    expect(text()).not.toContain('Property$');
  });

  it('counts each asset in net worth, and says what it gained and what of it is hers', () => {
    state.assets = held([
      owned({ id: 'car', name: 'Civic', kind: 'vehicle', financed_by: 'auto' }),
      owned({
        id: 'gold',
        name: 'Gold bracelet',
        kind: 'valuables',
        acquired_on: '2022-05-01',
        cost_minor: 800_000,
      }),
    ]);
    state.values = held([
      valued('car', '2026-09-01', 3_000_000),
      valued('gold', '2026-09-20', 1_400_000),
    ]);
    show();
    // 1,000 + 30,000 + 14,000 - 18,000.
    expect(text()).toContain('Net worth · 2 accounts and 2 assets, all in USD');
    expect(text()).toContain('$27,000.00');
    expect(text()).toContain('Property$44,000.00');
    expect(document.querySelector('.tiles .swatch.property')).not.toBeNull();

    const property = group('Property');
    expect(text(property)).toContain('2 assets');
    expect(text(property)).toContain('$12,000.00 yours after Auto Loan');
    expect(text(property)).toContain('+$6,000.00 (+75%) since 2022');
    expect(text(property)).toContain('Valued 4 days ago');
    expect(within(property).getByRole('link', { name: 'Civic' }).getAttribute('href')).toBe(
      '#/asset/car',
    );
    // The loan names what it bought.
    expect(text(group('Loans'))).toContain('PSCU · for Civic');
  });

  it('counts crypto with the investments, not the property (ACCT-21)', () => {
    state.accounts = held([
      account({ id: 'roth', name: 'Roth IRA', balance_minor: 50_000, holdings: 1 }),
    ]);
    state.assets = held([
      owned({}),
      owned({ id: 'btc', name: 'Card rewards', kind: 'crypto', coin: 'BTC', coin_quantity: '1' }),
    ]);
    state.values = held([
      valued('home', '2026-09-20', 50_000_000),
      { ...valued('btc', '2026-09-23', 103_441, 'estimate'), provider: 'gemini' },
    ]);
    show();
    expect(text()).toContain('Investments$1,534.41');
    expect(text()).toContain('Property$500,000.00');
    const investments = group('Investments');
    expect(text(investments)).toContain('1 account and 1 holding');
    expect(text(investments)).toContain('At Gemini’s close, 1 day ago');
    expect(within(investments).getByRole('link', { name: 'Card rewards' })).toBeDefined();
    expect(text(group('Property'))).not.toContain('Card rewards');
  });

  it("marks a value past half a year as old, and one of Monarch's as Monarch's", () => {
    state.assets = held([owned({})]);
    state.values = held([valued('home', '2025-01-15', 45_000_000, 'monarch')]);
    show();
    const age = group('Property').querySelector('.age');
    expect(age?.className).toContain('stale');
    expect(text(age ?? document.body)).toBe('Monarch’s value, 617 days ago');
  });

  it('draws property as its own line, in its own words', () => {
    state.assets = held([owned({})]);
    state.values = held([valued('home', '2026-09-23', 50_000_000)]);
    state.snapshots = held([
      snap('checking', '2026-09-22', 100_000, 'read'),
      snap('checking', '2026-09-23', 100_000, 'read'),
    ]);
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'Property' }));
    expect(screen.getByRole('heading', { name: 'Property by day' })).toBeDefined();
    const chart = screen.getByRole('img');
    fireEvent.focus(chart);
    expect(tip()).toContain('$500,000.00');
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(tip()).toContain('Leaves out 1 asset');
  });

  it('shows an estimate quietly under her value, and names it when it is the value', () => {
    state.assets = held([owned({}), owned({ id: 'car', name: 'Civic', kind: 'vehicle' })]);
    state.values = held([
      valued('home', '2026-09-01', 50_000_000),
      valued('home', '2026-09-20', 52_740_000, 'estimate'),
      valued('car', '2026-09-20', 2_745_000, 'estimate'),
    ]);
    show();
    const property = group('Property');
    // Hers counts: 500,000 + 27,450.
    expect(text(property)).toContain('$527,450.00');
    expect(text(property.querySelector('.note') ?? document.body)).toBe('Estimated at $527,400.00');
    const ages = [...property.querySelectorAll('.age')].map((el) => text(el));
    expect(ages).toEqual(['Valued 23 days ago', 'RentCast estimate, 4 days ago']);
  });

  it('says the property line is empty until something is valued', () => {
    state.assets = held([]);
    state.values = held([]);
    state.snapshots = held([snap('checking', '2026-09-23', 100_000, 'read')]);
    show();
    fireEvent.click(screen.getByRole('radio', { name: 'Property' }));
    expect(text()).toContain('Nothing you own is valued yet.');
  });
});

describe('goals (GOAL-01)', () => {
  function goal(overrides: Partial<GoalRow>): GoalRow {
    return {
      id: 'fund',
      updated_at: '2026-09-24T09:00:00+00:00',
      deleted_at: null,
      name: 'Emergency fund',
      kind: 'save',
      currency: 'USD',
      target_minor: 1_000_000,
      starts_on: '2026-06-01',
      target_on: null,
      created_at: '2026-09-24T09:00:00+00:00',
      ...overrides,
    };
  }

  function counts(goalId: string, accountId: string): GoalAccountRow {
    return {
      id: `${goalId}-${accountId}`,
      updated_at: '2026-09-24T09:00:00+00:00',
      deleted_at: null,
      goal_id: goalId,
      account_id: accountId,
    };
  }

  it('offers the first goal, open, while there is none', () => {
    state.accounts = held(LINKED);
    state.goals = held([]);
    show();
    const goals = group('Goals');
    expect(goals.querySelector('details')?.open).toBe(true);
    expect(within(goals).getByRole('link', { name: 'Add a goal' }).getAttribute('href')).toBe(
      '#/new-goal',
    );
  });

  it('shows each goal with its bar and when it gets there', () => {
    state.accounts = held(LINKED);
    // Checking held $4,000 on 26 Jun, 90 days back, and $5,000 now, against $10,000.
    state.snapshots = held([snap('checking', '2026-06-26', 400_000, 'read')]);
    state.goals = held([
      goal({}),
      goal({ id: 'car', name: 'Car paid off', kind: 'payoff', target_minor: null }),
      goal({ id: 'gone', name: 'Old goal', deleted_at: '2026-09-24T09:00:00+00:00' }),
    ]);
    state.links = held([counts('fund', 'checking'), counts('car', 'auto')]);
    show();
    const goals = group('Goals');
    expect(text(goals)).toContain('2 goals');
    expect(text(goals)).not.toContain('Old goal');
    expect(within(goals).getByRole('link', { name: 'Emergency fund' }).getAttribute('href')).toBe(
      '#/goal/fund',
    );
    expect(text(goals)).toContain('$5,000.00of $10,000.00');
    // $1,000 in 90 days: $5,000 more takes 450, to 18 Dec 2027.
    expect(text(goals)).toContain('50% · about Dec 2027 at this pace');
    expect(within(goals).getByRole('progressbar', { name: 'Emergency fund' })).toBeDefined();
    // The loan has no history, so no share and no bar: only what it owes.
    expect(text(goals)).toContain('$10,000.00owed');
    expect(within(goals).queryByRole('progressbar', { name: 'Car paid off' })).toBeNull();
  });
});

describe('what is due (ACCT-15)', () => {
  function promo(id: string, accountId: string, endsOn: string): TermRow {
    return {
      id,
      updated_at: '2026-09-24T09:00:00+00:00',
      deleted_at: null,
      account_id: accountId,
      kind: 'promo_apr',
      effective_on: '2026-03-01',
      amount_minor: null,
      rate_bp: 0,
      ends_on: endsOn,
    };
  }

  function apr(accountId: string, bp: number): TermRow {
    return {
      id: `apr-${accountId}`,
      updated_at: '2026-09-24T09:00:00+00:00',
      deleted_at: null,
      account_id: accountId,
      kind: 'purchase_apr',
      effective_on: '2026-01-01',
      amount_minor: null,
      rate_bp: bp,
      ends_on: null,
    };
  }

  const trip: GoalRow = {
    id: 'trip',
    updated_at: '2026-09-24T09:00:00+00:00',
    deleted_at: null,
    name: 'Summer trip',
    kind: 'save',
    currency: 'USD',
    target_minor: 1_000_000,
    starts_on: '2026-06-01',
    target_on: '2026-11-01',
    created_at: '2026-09-24T09:00:00+00:00',
  };

  it('says nothing while nothing is due', () => {
    state.accounts = held(LINKED);
    state.terms = held([promo('p', 'card', '2027-06-01')]);
    state.goals = held([]);
    show();
    expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull();
  });

  it('lists a promo ending and a goal’s date, soonest first, each linking to its page', () => {
    state.accounts = held(LINKED);
    state.terms = held([promo('p', 'card', '2026-10-10'), apr('card', 2499)]);
    state.goals = held([trip]);
    state.links = held([
      {
        id: 'trip-checking',
        updated_at: '2026-09-24T09:00:00+00:00',
        deleted_at: null,
        goal_id: 'trip',
        account_id: 'checking',
      },
    ]);
    show();
    const due = screen.getByRole('region', { name: 'Coming up' });
    const rows = within(due).getAllByRole('listitem');
    expect(rows.map((row) => text(row))).toEqual([
      'Customized Cash Rewards Visa Signature0% promo APR ends Oct 10, 2026, then 24.99%in 16 days',
      'Summer tripDue Nov 1, 2026in 38 days',
    ]);
    expect(
      within(due)
        .getByRole('link', { name: 'Customized Cash Rewards Visa Signature' })
        .getAttribute('href'),
    ).toBe('#/account/card');
    expect(within(due).getByRole('link', { name: 'Summer trip' }).getAttribute('href')).toBe(
      '#/goal/trip',
    );
    // Inside the month the card's own page warns in, so in the warning colour.
    expect(within(due).getByText('in 16 days').className).toContain('error');
  });

  it('keeps a goal a fortnight past its date, not reached', () => {
    state.accounts = held(LINKED);
    state.goals = held([{ ...trip, starts_on: '2026-01-01', target_on: '2026-09-20' }]);
    state.links = held([]);
    show();
    const due = screen.getByRole('region', { name: 'Coming up' });
    expect(text(due)).toContain('Was due Sep 20, 2026, not reached4 days ago');
  });
});

describe('this month’s budget (BUD-01)', () => {
  const AT = '2026-09-24T09:00:00+00:00';

  function spent(id: string, accountId: string, minor: number, category: string | null) {
    return {
      id,
      updated_at: AT,
      deleted_at: null,
      account_id: accountId,
      posted_at: '2026-09-10T12:00:00+00:00',
      transacted_at: null,
      amount_minor: minor,
      payee: 'Whole Foods',
      description: '',
      source_category: category,
      pending: false,
    };
  }

  const groceries: CategoryRow = {
    id: 'food',
    updated_at: AT,
    deleted_at: null,
    name: 'Groceries',
    kind: 'spend',
    guesses_from: ['Groceries'],
    created_at: AT,
  };

  it('links to the month while the transactions are still being read, and says no total', () => {
    state.accounts = held(LINKED);
    show();
    const budget = group('Budget');
    expect(within(budget).getByRole('link', { name: 'Budget' }).getAttribute('href')).toBe(
      '#/budget',
    );
    expect(text(budget)).not.toContain('spent');
  });

  it('is a card, not a fold: its header is all it says', () => {
    state.accounts = held(LINKED);
    show();
    expect(group('Budget').querySelector('details, summary')).toBeNull();
  });

  it('says what the month has spent of its budget, counting cards and cash only', () => {
    state.accounts = held(LINKED);
    state.categories = held([groceries]);
    state.budgets = held([
      {
        id: 'b',
        updated_at: AT,
        deleted_at: null,
        category_id: 'food',
        starts_on: '2026-09-01',
        amount_minor: 60_000,
        currency: 'USD',
      },
    ]);
    state.transactions = held([
      spent('t1', 'card', -12_000, 'Groceries'),
      spent('t2', 'checking', -3_000, null),
      // A loan's and a retirement account's are not spending.
      spent('t3', 'auto', -50_000, 'Groceries'),
      spent('t4', 'roth', -50_000, 'Groceries'),
    ]);
    show();
    const budget = group('Budget');
    expect(text(budget)).toContain(
      'September 2026: $120.00 spent of $600.00 budgeted · 1 to categorize',
    );
    expect(within(budget).getByRole('link', { name: 'Categorize 1' }).getAttribute('href')).toBe(
      '#/categorize',
    );
    expect(
      within(budget).getByRole('progressbar', { name: 'Spent of this month’s budget' }),
    ).not.toBeNull();
  });
});

describe('what changed this month (ACCT-13)', () => {
  beforeEach(() => {
    state.accounts = held([
      account({ id: 'checking', name: 'Checking', balance_minor: 120_000 }),
      account({ id: 'card', balance_minor: -5_000 }),
      account({ id: 'roth', name: 'Roth IRA', balance_minor: 60_000 }),
      account({ id: 'loan', name: 'Harbor Mortgage', balance_minor: -9_000_000 }),
    ]);
    state.groups = held([
      chosen('checking', 'cash'),
      chosen('card', 'card'),
      chosen('roth', 'investment'),
      chosen('loan', 'loan'),
    ]);
    state.rates = held([]);
    state.snapshots = held([
      snap('checking', '2026-08-31', 100_000, 'read'),
      snap('checking', '2026-09-23', 120_000, 'read'),
      snap('card', '2026-08-31', -15_000, 'read'),
      snap('card', '2026-09-23', -5_000, 'read'),
      snap('roth', '2026-08-31', 55_000, 'read'),
      snap('roth', '2026-09-23', 60_000, 'read'),
      snap('loan', '2026-09-10', -9_000_000, 'read'),
    ]);
  });

  const card = () => screen.getByRole('region', { name: /What changed this month/ });
  const row = (name: string) =>
    [...card().querySelectorAll<HTMLElement>('.bridge > li')].find((li) =>
      text(li).startsWith(name),
    ) ?? card();

  it('walks from the end of last month to the last day, by side', () => {
    show();
    // What was already counted gained $350; the mortgage linked this month is not a loss.
    expect(text(card().querySelector('h2') ?? card())).toBe('What changed this month+$350.00');
    expect(text(card())).toContain('$1,400.00 on Aug 31, 2026, then -$88,250.00');
    expect(text(card())).toContain(
      'Of that, -$90,000.00 was counted for the first time, and is not in the change.',
    );
    expect([...card().querySelectorAll('.bridge > li')].map((li) => text(li))).toEqual([
      expect.stringContaining('Cash+$200.00'),
      expect.stringContaining('Investments+$50.00'),
      expect.stringContaining('Debt$100.00 paid down'),
      expect.stringContaining('Newly counted-$90,000.00'),
    ]);
  });

  it('opens each part onto the accounts that moved it, and a loan linked this month is no loss', () => {
    show();
    expect(within(row('Debt')).getByRole('link', { name: 'Visa Signature' })).toBeTruthy();
    expect(text(row('Newly counted'))).toContain('is neither a gain nor a loss');
    expect(
      within(row('Newly counted')).getByRole('link', { name: 'Harbor Mortgage' }),
    ).toBeTruthy();
  });

  it('says investments, never returns', () => {
    show();
    expect(text(row('Investments'))).toContain(
      'what the market did and what was paid in are one figure',
    );
    expect(text(card()).toLowerCase()).not.toContain('return');
  });

  it('is not drawn before there are two days to walk between', () => {
    state.snapshots = held([snap('checking', '2026-09-23', 120_000, 'read')]);
    show();
    expect(screen.queryByRole('region', { name: /What changed this month/ })).toBeNull();
  });
});
