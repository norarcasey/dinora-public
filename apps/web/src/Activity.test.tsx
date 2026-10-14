import type { AccountRow } from '@dinora/core/balances';
import type { CategoryRow, ChoiceRow, Month, RuleRow, TransactionRow } from '@dinora/core/budgets';
import type { GroupRow } from '@dinora/core/groups';
import type { RateRow } from '@dinora/core/rates';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncedRows } from './queries/synced.ts';
import { WriteError } from './queries/writes.ts';

// Noon UTC, so her local day is 25 Sep wherever the tests run.
const NOW = Date.parse('2026-09-25T12:00:00Z');
const USER = '11111111-1111-1111-1111-111111111111';
const AT = '2026-09-25T09:00:00+00:00';

const state: {
  transactions: SyncedRows<TransactionRow>;
  categories: SyncedRows<CategoryRow>;
  choices: SyncedRows<ChoiceRow>;
  rules: SyncedRows<RuleRow>;
  accounts: SyncedRows<AccountRow>;
  groups: SyncedRows<GroupRow>;
  rates: SyncedRows<RateRow>;
  online: boolean;
} = {
  transactions: { status: 'waiting' },
  categories: { status: 'waiting' },
  choices: { status: 'waiting' },
  rules: { status: 'waiting' },
  accounts: { status: 'waiting' },
  groups: { status: 'waiting' },
  rates: { status: 'waiting' },
  online: true,
};

const addRule =
  vi.fn<(user: string, payee: string, category: string | null, month: Month) => Promise<void>>();
const chooseCategory =
  vi.fn<
    (
      user: string,
      transaction: string,
      category: string | null,
      choices: readonly ChoiceRow[],
    ) => Promise<void>
  >();

vi.mock('./queries/synced.ts', () => ({
  useSynced: (table: { name: string }) => {
    switch (table.name) {
      case 'transactions':
        return state.transactions;
      case 'categories':
        return state.categories;
      case 'transaction_categories':
        return state.choices;
      case 'category_rules':
        return state.rules;
      case 'accounts':
        return state.accounts;
      case 'account_groups':
        return state.groups;
      case 'fx_rates':
        return state.rates;
      default:
        return { status: 'waiting' };
    }
  },
  defineSynced: (spec: { name: string }) => ({ ...spec, queryKey: ['synced', spec.name] }),
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
  addRule,
  chooseCategory,
}));
vi.mock('./queries/balances.ts', () => ({
  ACCOUNTS: { name: 'accounts', queryKey: ['synced', 'accounts'] },
  FX_RATES: { name: 'fx_rates', queryKey: ['synced', 'fx_rates'] },
}));
vi.mock('./queries/groups.ts', () => ({
  ACCOUNT_GROUPS: { name: 'account_groups', queryKey: ['synced', 'account_groups'] },
}));
vi.mock('./queries/goals.ts', () => ({
  GOALS: { name: 'goals', queryKey: ['synced', 'goals'] },
  GOAL_ACCOUNTS: { name: 'goal_accounts', queryKey: ['synced', 'goal_accounts'] },
  GOAL_PLANS: { name: 'goal_plans', queryKey: ['synced', 'goal_plans'] },
}));
vi.mock('./device/useOnline.ts', () => ({ useOnline: () => state.online }));

const { Activity } = await import('./Activity.tsx');
const { Payee } = await import('./Payee.tsx');

function held<Row>(rows: Row[]): SyncedRows<Row> {
  return { status: 'held', rows, asOf: NOW, refreshing: false, stale: false };
}

function account(id: string, name: string, holdings = 0): AccountRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    institution: 'Bank of America',
    name,
    currency: 'USD',
    balance_minor: 0,
    balance_at: AT,
    holdings,
    source: 'simplefin',
  };
}

function category(id: string, name: string, overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    name,
    kind: 'spend',
    guesses_from: [],
    created_at: AT,
    ...overrides,
  };
}

function txn(
  id: string,
  on: string,
  minor: number,
  overrides: Partial<TransactionRow> = {},
): TransactionRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    account_id: 'card',
    posted_at: `${on}T12:00:00+00:00`,
    transacted_at: null,
    amount_minor: minor,
    payee: 'Netflix',
    description: '',
    source_category: null,
    pending: false,
    ...overrides,
  };
}

function rule(payee: string, categoryId: string | null, startsOn: string): RuleRow {
  return {
    id: `${payee}-${startsOn}`,
    updated_at: AT,
    deleted_at: null,
    payee,
    category_id: categoryId,
    starts_on: startsOn,
    created_at: AT,
  };
}

const fun = category('fun', 'Streaming');
const moves = category('moves', 'Transfers', { kind: 'transfer' });

const netflix = ['2026-06-14', '2026-07-14', '2026-08-14', '2026-09-14'].map((on, i) =>
  txn(`n${i}`, on, -1599),
);
const autopay = ['2026-06-02', '2026-07-02', '2026-08-02', '2026-09-02'].map((on, i) =>
  txn(`p${i}`, on, -50_000, { account_id: 'checking', payee: 'Card Autopay' }),
);

function hold(transactions: TransactionRow[], rules: RuleRow[] = [], choices: ChoiceRow[] = []) {
  state.transactions = held(transactions);
  state.categories = held([fun, moves]);
  state.choices = held(choices);
  state.rules = held(rules);
  state.accounts = held([account('card', 'Visa Signature'), account('checking', 'Checking')]);
  state.groups = held([]);
  state.rates = held([]);
}

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.transactions = { status: 'waiting' };
  state.categories = { status: 'waiting' };
  state.online = true;
  addRule.mockReset();
  addRule.mockResolvedValue(undefined);
  chooseCategory.mockReset();
  chooseCategory.mockResolvedValue(undefined);
  window.location.hash = '#/activity';
});

describe('Activity', () => {
  it('waits for the rows, and says so when there are none to read', () => {
    wrap(<Activity query="" userId={USER} />);
    expect(screen.queryByRole('heading', { name: 'Activity' })).toBeNull();
    state.transactions = { status: 'failed' };
    wrap(<Activity query="" userId={USER} />);
    expect(screen.getByText(/could not be reached/)).toBeTruthy();
  });

  it('lists what recurs, and leaves out a charge filed as a transfer', () => {
    const choices = autopay.map((t) => ({
      id: `c-${t.id}`,
      updated_at: AT,
      deleted_at: null,
      transaction_id: t.id,
      category_id: 'moves',
    }));
    hold([...netflix, ...autopay], [], choices);
    wrap(<Activity query="" userId={USER} />);
    const list = screen.getByRole('region', { name: 'Recurring' });
    expect(within(list).getByRole('link', { name: 'Netflix' }).getAttribute('href')).toBe(
      '#/payee/netflix',
    );
    expect(within(list).getByText(/Every month, next about Oct 14/)).toBeTruthy();
    expect(within(list).getByText('About $191.88 a year')).toBeTruthy();
    expect(within(list).queryByText('Card Autopay')).toBeNull();
  });

  it('says when nothing recurs yet', () => {
    hold([txn('a', '2026-09-01', -100)]);
    wrap(<Activity query="" userId={USER} />);
    expect(screen.getByText(/No charge has come back on a schedule yet/)).toBeTruthy();
  });

  it('searches every account as she types, and keeps the search in the address', () => {
    hold([...netflix, ...autopay]);
    wrap(<Activity query="" userId={USER} />);
    const box = screen.getByRole('searchbox', { name: 'Search transactions' });
    expect(box.getAttribute('placeholder')).toBe('Search 8 transactions');
    fireEvent.change(box, { target: { value: 'autopay checking' } });
    expect(screen.getByRole('heading', { name: '4 transactions' })).toBeTruthy();
    expect(window.location.hash).toBe('#/activity?q=autopay%20checking');
    fireEvent.change(box, { target: { value: '15.99' } });
    expect(screen.getByRole('heading', { name: '4 transactions' })).toBeTruthy();
    expect(screen.getAllByText('Uncategorized')).toHaveLength(4);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByRole('heading', { name: 'Nothing found' })).toBeTruthy();
    fireEvent.change(box, { target: { value: '' } });
    expect(window.location.hash).toBe('#/activity');
  });

  it('categorizes a transaction found, right where it is listed', async () => {
    hold([...netflix]);
    wrap(<Activity query="15.99" userId={USER} />);
    // Newest first: September's charge.
    const [newest] = screen.getAllByRole('button', { name: 'Category for Netflix: uncategorized' });
    if (newest === undefined) throw new Error('no chip');
    fireEvent.click(newest);
    const sheet = within(screen.getByRole('dialog', { name: 'Category for Netflix' }));
    fireEvent.click(
      within(sheet.getByRole('region', { name: 'Spending' })).getByRole('button', {
        name: 'Streaming',
      }),
    );
    await waitFor(() =>
      expect(chooseCategory).toHaveBeenCalledWith(USER, 'n3', 'fun', expect.anything()),
    );
    // The first choice for a payee asks whether to file every one of them there.
    expect(await screen.findByText(/File every “Netflix” under Streaming/)).toBeTruthy();
  });

  it('opens with the search it was left on, and shows only the newest of many', () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      txn(`m${i}`, `2026-0${1 + (i % 9)}-10`, -100 - i, { payee: 'Corner Shop' }),
    );
    hold(many);
    wrap(<Activity query="corner" userId={USER} />);
    expect(screen.getByRole('heading', { name: '120 transactions' })).toBeTruthy();
    expect(screen.getByText('The newest 100. Add a word to narrow it down.')).toBeTruthy();
  });
});

describe('Payee', () => {
  it('shows the year’s total, a column a month, and every transaction', () => {
    hold([...netflix, txn('old', '2024-01-05', -999)]);
    wrap(<Payee payee="netflix" userId={USER} />);
    expect(screen.getByRole('heading', { name: 'Netflix' })).toBeTruthy();
    expect(screen.getByText('$63.96')).toBeTruthy();
    expect(screen.getByText(/spent in the last twelve months, in 4 transactions/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /Spent each month/ })).toBeTruthy();
    expect(screen.getByText('September 2026: $15.99')).toBeTruthy();
    expect(screen.getByText('October 2025: $0.00')).toBeTruthy();
    expect(screen.getByText(/Every month, next about Oct 14, at \$15.99/)).toBeTruthy();
    expect(screen.getByText('5 in all')).toBeTruthy();
    expect(screen.getByText('The newest has no category.')).toBeTruthy();
  });

  it('reads the other way for money that comes in', () => {
    hold([txn('pay', '2026-09-01', 300_000, { payee: 'ACME Payroll', account_id: 'checking' })]);
    wrap(<Payee payee="acme payroll" userId={USER} />);
    expect(screen.getByText(/came in in the last twelve months, in 1 transaction/)).toBeTruthy();
  });

  it('says when no transaction is from the payee', () => {
    hold(netflix);
    wrap(<Payee payee="hulu" userId={USER} />);
    expect(screen.getByText('No transaction on this device is from this payee.')).toBeTruthy();
  });

  it('makes a rule from this month on', async () => {
    hold(netflix);
    wrap(<Payee payee="netflix" userId={USER} />);
    const button = screen.getByRole('button', { name: 'Make it a rule' });
    fireEvent.click(button);
    expect(await screen.findByText('Pick the category every one of them goes under.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Make it a rule'), { target: { value: 'fun' } });
    fireEvent.click(button);
    await waitFor(() => expect(addRule).toHaveBeenCalledWith(USER, 'netflix', 'fun', '2026-09'));
  });

  it('shows the rule in force, changes it and stops it', async () => {
    hold(netflix, [rule('netflix', 'fun', '2026-08-01')]);
    wrap(<Payee payee="netflix" userId={USER} />);
    expect(screen.getByText('Filed under Streaming by a rule.')).toBeTruthy();
    expect(
      screen.getByText(/A rule files every “netflix” under Streaming from August 2026/),
    ).toBeTruthy();
    const change = screen.getByRole('button', { name: 'Change the rule' });
    expect(change.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop the rule for netflix' }));
    await waitFor(() => expect(addRule).toHaveBeenCalledWith(USER, 'netflix', null, '2026-09'));
  });

  it('says why a rule was not saved', async () => {
    addRule.mockRejectedValue(new WriteError('the rule was not saved', '42501'));
    hold(netflix);
    wrap(<Payee payee="netflix" userId={USER} />);
    fireEvent.change(screen.getByLabelText('Make it a rule'), { target: { value: 'fun' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make it a rule' }));
    expect(await screen.findByText(/Dinora refused it \(code 42501\)/)).toBeTruthy();
  });

  it('turns rules off with no signal, and points to the budget with no categories', () => {
    state.online = false;
    hold(netflix);
    wrap(<Payee payee="netflix" userId={USER} />);
    expect(screen.getByLabelText('Make it a rule').hasAttribute('disabled')).toBe(true);
    state.categories = held([]);
    wrap(<Payee payee="netflix" userId={USER} />);
    expect(screen.getByRole('link', { name: 'budget' })).toBeTruthy();
  });

  it('lists fifty at first, and the rest on asking', () => {
    hold(Array.from({ length: 60 }, (_, i) => txn(`x${i}`, '2026-09-01', -100)));
    wrap(<Payee payee="netflix" userId={USER} />);
    const list = screen.getByRole('region', { name: /Transactions/ });
    expect(within(list).getAllByRole('listitem')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 60' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(60);
  });
});
