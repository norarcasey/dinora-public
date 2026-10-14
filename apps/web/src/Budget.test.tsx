import type { AccountRow } from '@dinora/core/balances';
import type {
  BudgetRow,
  CategoryRow,
  ChoiceRow,
  Month,
  RuleRow,
  TransactionRow,
} from '@dinora/core/budgets';
import type { GoalPlanRow } from '@dinora/core/contributions';
import type { GoalAccountRow, GoalRow } from '@dinora/core/goals';
import type { GroupRow } from '@dinora/core/groups';
import type { RateRow } from '@dinora/core/rates';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CategoryDetails } from './queries/budgets.ts';
import type { SyncedRows } from './queries/synced.ts';
import { WriteError } from './queries/writes.ts';

// Noon UTC, so her local day is 25 Sep wherever the tests run: 5 days of September after it.
const NOW = Date.parse('2026-09-25T12:00:00Z');
const USER = '11111111-1111-1111-1111-111111111111';
const AT = '2026-09-25T09:00:00+00:00';

const state: {
  transactions: SyncedRows<TransactionRow>;
  categories: SyncedRows<CategoryRow>;
  budgets: SyncedRows<BudgetRow>;
  choices: SyncedRows<ChoiceRow>;
  rules: SyncedRows<RuleRow>;
  accounts: SyncedRows<AccountRow>;
  groups: SyncedRows<GroupRow>;
  rates: SyncedRows<RateRow>;
  goals: SyncedRows<GoalRow>;
  goalLinks: SyncedRows<GoalAccountRow>;
  plans: SyncedRows<GoalPlanRow>;
  online: boolean;
} = {
  transactions: { status: 'waiting' },
  categories: { status: 'waiting' },
  budgets: { status: 'waiting' },
  choices: { status: 'waiting' },
  rules: { status: 'waiting' },
  accounts: { status: 'waiting' },
  groups: { status: 'waiting' },
  rates: { status: 'waiting' },
  goals: { status: 'waiting' },
  goalLinks: { status: 'waiting' },
  plans: { status: 'waiting' },
  online: true,
};

const addCategory = vi.fn<(user: string, details: CategoryDetails) => Promise<string>>();
const addCategories = vi.fn<(user: string, list: readonly CategoryDetails[]) => Promise<void>>();
const updateCategory = vi.fn<(id: string, details: CategoryDetails) => Promise<void>>();
const removeCategory = vi.fn<(id: string) => Promise<void>>();
const setBudget =
  vi.fn<
    (
      user: string,
      category: string,
      month: Month,
      minor: number | null,
      currency: string,
      budgets: readonly BudgetRow[],
    ) => Promise<void>
  >();
const chooseCategory =
  vi.fn<
    (
      user: string,
      transaction: string,
      category: string | null,
      choices: readonly ChoiceRow[],
    ) => Promise<void>
  >();
const addRule =
  vi.fn<(user: string, payee: string, category: string | null, month: Month) => Promise<void>>();
const setPlan =
  vi.fn<
    (
      user: string,
      goal: string,
      month: Month,
      minor: number | null,
      plans: readonly GoalPlanRow[],
    ) => Promise<void>
  >();

vi.mock('./queries/synced.ts', () => ({
  useSynced: (table: { name: string }) => {
    switch (table.name) {
      case 'transactions':
        return state.transactions;
      case 'categories':
        return state.categories;
      case 'category_budgets':
        return state.budgets;
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
      case 'goals':
        return state.goals;
      case 'goal_accounts':
        return state.goalLinks;
      case 'goal_plans':
        return state.plans;
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
  addCategory,
  addCategories,
  updateCategory,
  removeCategory,
  setBudget,
  chooseCategory,
  addRule,
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
  setPlan,
}));
vi.mock('./device/useOnline.ts', () => ({ useOnline: () => state.online }));

const { Budget } = await import('./Budget.tsx');
const { Category } = await import('./Category.tsx');
const { Categories } = await import('./Categories.tsx');
const { Categorize } = await import('./Categorize.tsx');
const { Rules } = await import('./Rules.tsx');
const { readBudget, readCategory } = await import('./CategoryForms.tsx');

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
    payee: 'Whole Foods',
    description: '',
    source_category: null,
    pending: false,
    ...overrides,
  };
}

function budget(categoryId: string, startsOn: string, minor: number | null): BudgetRow {
  return {
    id: `${categoryId}-${startsOn}`,
    updated_at: AT,
    deleted_at: null,
    category_id: categoryId,
    starts_on: startsOn,
    amount_minor: minor,
    currency: 'USD',
  };
}

function rule(
  payee: string,
  categoryId: string | null,
  startsOn: string,
  createdAt: string = AT,
): RuleRow {
  return {
    id: `${payee}-${startsOn}-${categoryId ?? 'stop'}`,
    updated_at: AT,
    deleted_at: null,
    payee,
    category_id: categoryId,
    starts_on: startsOn,
    created_at: createdAt,
  };
}

function choiceOf(transactionId: string, categoryId: string): ChoiceRow {
  return {
    id: `c-${transactionId}`,
    updated_at: AT,
    deleted_at: null,
    transaction_id: transactionId,
    category_id: categoryId,
  };
}

const food = category('food', 'Groceries', { guesses_from: ['Groceries'] });
const eating = category('eat', 'Eating out');
const pay = category('pay', 'Paychecks', { kind: 'income', guesses_from: ['Paychecks'] });

const CAFE_CHOICE: ChoiceRow = {
  id: 'c',
  updated_at: AT,
  deleted_at: null,
  transaction_id: 'cafe',
  category_id: 'eat',
};

function show(ui: () => ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => <QueryClientProvider client={client}>{ui()}</QueryClientProvider>;
  const { rerender } = render(tree());
  // The rows as the state now holds them: what a refetch after a save does in the app.
  return { again: () => rerender(tree()) };
}

const month = (m: string | null = null) => show(() => <Budget month={m} userId={USER} />);
const categoryPage = (id: string, m: string | null = null) =>
  show(() => <Category categoryId={id} month={m} userId={USER} />);

function openPicker(payee: string) {
  fireEvent.click(
    screen.getByRole('button', { name: (name) => name.startsWith(`Category for ${payee}:`) }),
  );
}

function picker(title: string) {
  return within(screen.getByRole('dialog', { name: title }));
}

function pickIn(title: string, group: string, name: string) {
  fireEvent.click(
    within(picker(title).getByRole('region', { name: group })).getByRole('button', { name }),
  );
}

function text(element: Element = document.body): string {
  return element.textContent ?? '';
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

/** The month with a category over, one on track, income, and one uncategorized. */
function aMonth() {
  state.categories = held([food, eating, pay]);
  state.budgets = held([budget('food', '2026-01-01', 60_000), budget('eat', '2026-09-01', 4_000)]);
  state.transactions = held([
    txn('wf', '2026-09-16', -12_000, { source_category: 'Groceries' }),
    txn('cafe', '2026-09-17', -4_500, { payee: 'Corner Cafe' }),
    txn('salary', '2026-09-16', 500_000, {
      account_id: 'checking',
      payee: 'ACME',
      source_category: 'Paychecks',
    }),
    txn('odd', '2026-09-20', -700, { payee: 'Square *Odd' }),
    txn('august', '2026-08-30', -99_999, { source_category: 'Groceries' }),
    txn('ira', '2026-09-03', -99_999, { account_id: 'roth', source_category: 'Groceries' }),
  ]);
  state.choices = held([CAFE_CHOICE]);
}

/** Two more uncategorized, the newer first in the queue: one more from Square *Odd, and parking. */
function uncategorizedToo() {
  if (state.transactions.status !== 'held') throw new Error('no transactions');
  state.transactions = held([
    ...state.transactions.rows,
    txn('odd2', '2026-09-21', -900, { payee: 'Square *Odd' }),
    txn('park', '2026-09-22', -1_500, {
      payee: 'Pay by Phone',
      description: 'PAYBYPHONE 4411',
      source_category: 'Parking',
    }),
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  window.location.hash = '';
  state.transactions = held([]);
  state.categories = held([]);
  state.budgets = held([]);
  state.choices = held([]);
  state.rules = held([]);
  state.accounts = held([
    account('card', 'Customized Cash Rewards Visa Signature'),
    account('checking', 'Member Advantage Checking'),
    account('roth', 'Roth IRA', 1),
  ]);
  state.groups = held([]);
  state.rates = held([]);
  state.goals = held([]);
  state.goalLinks = held([]);
  state.plans = held([]);
  state.online = true;
  for (const mock of [
    setPlan,
    addCategory,
    addCategories,
    updateCategory,
    removeCategory,
    setBudget,
    chooseCategory,
    addRule,
  ]) {
    mock.mockReset();
  }
  addCategory.mockResolvedValue('new');
  addCategories.mockResolvedValue();
  updateCategory.mockResolvedValue();
  removeCategory.mockResolvedValue();
  setBudget.mockResolvedValue();
  chooseCategory.mockResolvedValue();
  addRule.mockResolvedValue();
  setPlan.mockResolvedValue();
});

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('before anything is held', () => {
  it('shows nothing while the transactions have not been read', () => {
    state.transactions = { status: 'waiting' };
    month();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('says so on every budget page when nothing was saved and the server cannot be reached', () => {
    state.categories = { status: 'failed' };
    month();
    categoryPage('eat');
    show(() => <Categories userId={USER} />);
    show(() => <Rules categoryId={null} userId={USER} />);
    show(() => <Categorize month={null} userId={USER} />);
    expect(screen.getAllByText(/no transactions saved from before/)).toHaveLength(5);
  });

  it('waits on every budget page while nothing is read', () => {
    state.categories = { status: 'waiting' };
    categoryPage('eat');
    show(() => <Categories userId={USER} />);
    show(() => <Rules categoryId={null} userId={USER} />);
    show(() => <Categorize month={null} userId={USER} />);
    expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(4);
  });
});

describe('the first start', () => {
  it('offers Monarch’s categories as a start, and makes one for each', async () => {
    state.transactions = held([
      txn('1', '2026-09-02', -100, { source_category: 'Groceries' }),
      txn('2', '2026-09-03', -100, { source_category: 'Groceries' }),
      txn('3', '2026-09-04', 5_000, { source_category: 'Paychecks' }),
    ]);
    month();
    expect(text()).toContain('Start from the 2 categories Monarch used in your history');
    fireEvent.click(screen.getByRole('button', { name: 'Start from Monarch’s categories' }));
    await waitFor(() => expect(addCategories).toHaveBeenCalled());
    expect(addCategories).toHaveBeenCalledWith(USER, [
      { name: 'Groceries', kind: 'spend', guessesFrom: ['Groceries'] },
      { name: 'Paychecks', kind: 'income', guessesFrom: ['Paychecks'] },
    ]);
  });

  it('adds a category by hand when there is no history to start from', async () => {
    month();
    expect(screen.queryByRole('button', { name: 'Start from Monarch’s categories' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Rent ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    await waitFor(() => expect(addCategory).toHaveBeenCalled());
    expect(addCategory).toHaveBeenCalledWith(USER, {
      name: 'Rent',
      kind: 'spend',
      guessesFrom: [],
    });
  });

  it('refuses a category with no name, and says why a save was refused', async () => {
    addCategory.mockRejectedValue(new WriteError('the category was not saved', '23505'));
    month();
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    expect(text()).toContain('Give the category a name.');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));
    expect(await screen.findByText(/code 23505/)).toBeDefined();
  });

  it('says why a start was refused', async () => {
    state.transactions = held([txn('1', '2026-09-02', -100, { source_category: 'Groceries' })]);
    addCategories.mockRejectedValue(new WriteError('the categories were not saved', '23505'));
    month();
    fireEvent.click(screen.getByRole('button', { name: 'Start from Monarch’s categories' }));
    expect((await screen.findByRole('alert')).textContent).toContain('code 23505');
  });
});

describe('the month', () => {
  beforeEach(aMonth);

  it('says how the month is going against today, and what is not counted', () => {
    month();
    expect(screen.getByRole('navigation', { name: 'Month' }).textContent).toContain(
      'September 2026',
    );
    expect(text()).toContain('$165.00spent of $640.00 budgeted');
    expect(text()).toContain('On pace · $475.00 left for 5 days');
    expect(text()).toContain('1 transaction without a category');
    expect(text()).toContain('Not counted until it has one');
    expect(screen.getByRole('link', { name: 'Categorize 1' }).getAttribute('href')).toBe(
      '#/categorize',
    );
    // A retirement account's buys are not spending, and August is another month.
    expect(text()).not.toContain('$999.99');
  });

  it('draws the month’s spending by day against an even pace, August behind it', () => {
    month();
    const chart = screen.getByRole('img', { name: /^Spent by day/ });
    expect(chart.getAttribute('aria-label')).toBe(
      'Spent by day, $165.00 by Sep 25; an even pace would be $533.33; August had spent $0.00. Use the arrow keys to read each day.',
    );
    expect(text()).toContain('Even pace to $640.00');

    fireEvent.focus(chart);
    const tip = (): string => text(screen.getByText(/^spent by/).parentElement ?? document.body);
    expect(tip()).toContain('$165.00spent by Sep 25');
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    // Today is as far as it reads: the days after it hold nothing yet.
    expect(tip()).toContain('by Sep 25');
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(tip()).toContain('$0.00spent by Sep 1');
    expect(tip()).toContain('Even pace $21.33');
    expect(tip()).toContain('August by Aug 1 $0.00');
    fireEvent.keyDown(chart, { key: 'ArrowRight' });
    expect(tip()).toContain('spent by Sep 2');

    const rows = within(screen.getByRole('region', { name: 'The chart as a table' })).getAllByRole(
      'row',
    );
    expect(rows).toHaveLength(26);
    expect(text(rows[1] ?? document.body)).toBe('Sep 25$165.00$533.33$0.00');
    expect(text(rows[9] ?? document.body)).toBe('Sep 17$165.00$362.67$0.00');
    expect(text(rows[10] ?? document.body)).toBe('Sep 16$120.00$341.33$0.00');
  });

  it('draws a past month to its end, and no month before one with nothing read', () => {
    month('2026-08');
    const chart = screen.getByRole('img', { name: /^Spent by day/ });
    expect(chart.getAttribute('aria-label')).toBe(
      'Spent by day, $999.99 by Aug 31; an even pace would be $600.00. Use the arrow keys to read each day.',
    );
    expect(text()).not.toContain('July');
    fireEvent.focus(chart);
    expect(text(screen.getByText(/^spent by/).parentElement ?? document.body)).toContain(
      '$999.99spent by Aug 31',
    );
  });

  it('lists the categories by what needs looking at, over first', () => {
    month();
    const over = region('Over budget');
    expect(text(over)).toContain('Eating out$45.00of $40.00');
    expect(text(over)).toContain('$5.00 over');
    expect(
      within(over).getByRole('progressbar', { name: 'Eating out, spent' }).className,
    ).toContain('over');
    const onTrack = region('On track');
    expect(text(onTrack)).toContain('$480.00 left for 5 days');
    expect(screen.queryByRole('region', { name: 'Ahead of pace' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Eating out' }).getAttribute('href')).toBe(
      '#/category/eat',
    );
    expect(screen.getByRole('link', { name: 'Categories and rules' }).getAttribute('href')).toBe(
      '#/categories',
    );
  });

  it('puts a category spending faster than the month goes ahead of pace', () => {
    state.transactions = held([txn('wf', '2026-09-16', -52_000, { source_category: 'Groceries' })]);
    month();
    const ahead = region('Ahead of pace');
    expect(text(ahead)).toContain('$80.00 left for 5 days');
    expect(
      within(ahead).getByRole('progressbar', { name: 'Groceries, spent' }).className,
    ).toContain('ahead');
    // The month as a whole can be on pace while one category runs ahead of it.
    expect(text()).toContain('On pace · $120.00 left for 5 days');
  });

  it('says by how much the month is over', () => {
    state.budgets = held([budget('food', '2026-01-01', 10_000)]);
    month();
    expect(text()).toContain('$65.00 over budget');
  });

  it('folds income and transfers away, with what came in', () => {
    state.categories = held([
      food,
      eating,
      pay,
      category('move', 'Card payments', { kind: 'transfer' }),
    ]);
    state.choices = held([CAFE_CHOICE, choiceOf('odd', 'move')]);
    month();
    expect(text()).toContain('Income and transfers$5,000.00 in');
    expect(text()).toContain('Transfer, not counted as spent');
    expect(screen.getByRole('link', { name: /^Paychecks/ }).getAttribute('href')).toBe(
      '#/category/pay',
    );
  });

  it('sets a budget from the list, offering what it spent before', async () => {
    month();
    fireEvent.click(screen.getByRole('button', { name: 'Budget for Groceries: $600.00' }));
    const sheet = picker('Budget for Groceries');
    const input = sheet.getByLabelText('Each month');
    // The sign is the field's affix, not part of what is in it.
    expect(input).toHaveProperty('value', '600.00');
    expect(sheet.getByRole('button', { name: 'Use Jul, $0.00' })).toBeDefined();
    expect(sheet.getByRole('button', { name: 'Use the average, $333.33' })).toBeDefined();
    fireEvent.click(sheet.getByRole('button', { name: 'Use Aug, $999.99' }));
    expect(input).toHaveProperty('value', '999.99');
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setBudget).toHaveBeenCalled());
    expect(setBudget.mock.calls[0]?.slice(0, 5)).toEqual([USER, 'food', '2026-09', 99_999, 'USD']);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('saves nothing when the budget is left as it was, and none when emptied', async () => {
    month();
    fireEvent.click(screen.getByRole('button', { name: 'Budget for Groceries: $600.00' }));
    fireEvent.click(picker('Budget for Groceries').getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(setBudget).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Budget for Eating out: $40.00' }));
    const sheet = picker('Budget for Eating out');
    fireEvent.change(sheet.getByLabelText('Each month'), { target: { value: ' ' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setBudget).toHaveBeenCalled());
    expect(setBudget.mock.calls[0]?.[3]).toBeNull();
  });

  it('refuses a budget that is not a number, and says why a save was refused', async () => {
    setBudget.mockRejectedValue(new WriteError('the budget was not saved', '42501'));
    month();
    fireEvent.click(screen.getByRole('button', { name: 'Budget for Groceries: $600.00' }));
    const sheet = picker('Budget for Groceries');
    fireEvent.change(sheet.getByLabelText('Each month'), { target: { value: 'lots' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    expect(text(screen.getByRole('dialog'))).toContain(
      'Enter the budget as a number, like 600, or leave it empty.',
    );
    expect(setBudget).not.toHaveBeenCalled();
    fireEvent.change(sheet.getByLabelText('Each month'), { target: { value: '700' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    expect(await sheet.findByText(/code 42501/)).toBeDefined();
  });

  it('sets a first budget for a category without one, folded below the rest', async () => {
    state.categories = held([food, eating, pay, category('misc', 'Misc')]);
    state.choices = held([CAFE_CHOICE, choiceOf('odd', 'misc')]);
    month();
    expect(screen.queryByRole('link', { name: /^Categorize/ })).toBeNull();
    expect(text()).toContain('Without a budget · 1$7.00');
    fireEvent.click(screen.getByRole('button', { name: 'Set a budget for Misc' }));
    const sheet = picker('Budget for Misc');
    expect(sheet.getByLabelText('Each month')).toHaveProperty('value', '');
    fireEvent.change(sheet.getByLabelText('Each month'), { target: { value: '50' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setBudget).toHaveBeenCalled());
    expect(setBudget.mock.calls[0]?.slice(0, 5)).toEqual([USER, 'misc', '2026-09', 5_000, 'USD']);
  });

  it('keeps a budget from being saved with no signal', () => {
    state.online = false;
    month();
    fireEvent.click(screen.getByRole('button', { name: 'Budget for Groceries: $600.00' }));
    expect(
      picker('Budget for Groceries').getByRole<HTMLButtonElement>('button', { name: 'Save' })
        .disabled,
    ).toBe(true);
  });
});

describe('the month, day by day', () => {
  beforeEach(aMonth);

  it('shades each day by how it ranks in the month, Monday first', () => {
    month();
    const calendar = region('Day by day');
    const heads = within(calendar).getAllByRole('columnheader');
    expect(heads.map((h) => h.textContent)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
      'Fri',
      'Sat',
      'Sun',
    ]);
    const busiest = within(calendar).getByRole('button', {
      name: 'Wed, Sep 16: $120.00 spent, 2 transactions',
    });
    expect(busiest.className).toContain('shade-4');
    expect(
      within(calendar).getByRole('button', { name: 'Thu, Sep 17: $45.00 spent, 1 transaction' })
        .className,
    ).toContain('shade-2');
    // Uncategorized is listed but not spent, as in the month's total.
    expect(
      within(calendar).getByRole('button', {
        name: 'Sun, Sep 20: nothing spent, 1 transaction, 1 without a category',
      }).className,
    ).toContain('shade-0');
    // Marked, since its shade leaves it out; the days fully categorized are not, and the key
    // says what the mark means.
    expect(
      within(calendar)
        .getAllByRole('button')
        .filter((b) => b.querySelector('.calendar-flag')),
    ).toHaveLength(1);
    expect(text(calendar)).toContain('has transactions without a category, not counted yet');
    // A day with nothing on it, and one still to come, open nothing.
    expect(within(calendar).getAllByRole('button')).toHaveLength(3);
  });

  it('opens a day’s transactions, spent and not', () => {
    month();
    fireEvent.click(
      screen.getByRole('button', { name: 'Wed, Sep 16: $120.00 spent, 2 transactions' }),
    );
    const sheet = picker('Wed, Sep 16');
    sheet.getByRole('button', { name: 'Category for Whole Foods: Groceries, Monarch’s guess' });
    sheet.getByRole('button', { name: 'Category for ACME: Paychecks, Monarch’s guess' });
    expect(sheet.getByRole('link', { name: 'ACME' }).getAttribute('href')).toBe('#/payee/acme');
    expect(text(screen.getByRole('dialog', { name: 'Wed, Sep 16' }))).toContain('$120.00 spent');
    expect(text(screen.getByRole('dialog', { name: 'Wed, Sep 16' }))).toContain(
      'Income and transfers are listed but not counted as spent.',
    );
  });

  it('categorizes what is uncategorized right there, and counts it once it is', async () => {
    const { again } = month();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Sun, Sep 20: nothing spent, 1 transaction, 1 without a category',
      }),
    );
    const day = picker('Sun, Sep 20');
    expect(text(screen.getByRole('dialog', { name: 'Sun, Sep 20' }))).toContain(
      '1 transaction without a category, not counted until it has one.',
    );
    fireEvent.click(day.getByRole('button', { name: 'Category for Square *Odd: uncategorized' }));
    pickIn('Category for Square *Odd', 'Spending', 'Eating out');
    await waitFor(() =>
      expect(chooseCategory).toHaveBeenCalledWith(USER, 'odd', 'eat', expect.anything()),
    );
    // The rows as a refetch brings them: filed, and so counted in the day.
    state.choices = held([CAFE_CHOICE, choiceOf('odd', 'eat')]);
    again();
    // The day's sheet stays open on the same day, now with it counted.
    const open = screen.getByRole('dialog', { name: 'Sun, Sep 20' });
    expect(text(open)).toContain('$7.00 spent');
    within(open).getByRole('button', { name: 'Category for Square *Odd: Eating out, yours' });
    screen.getByRole('button', { name: 'Sun, Sep 20: $7.00 spent, 1 transaction' });
  });
});

describe('a month already over', () => {
  beforeEach(aMonth);

  it('keeps its budgets as they were, and steps forward to this month', () => {
    month('2026-08');
    const nav = screen.getByRole('navigation', { name: 'Month' });
    expect(within(nav).getByRole('link', { name: 'The month after' }).getAttribute('href')).toBe(
      '#/budget',
    );
    expect(within(nav).getByRole('link', { name: 'The month before' }).getAttribute('href')).toBe(
      '#/budget/2026-07',
    );
    expect(screen.queryByRole('button', { name: /^Budget for/ })).toBeNull();
    expect(text(region('Over budget'))).toContain('Groceries$999.99of $600.00');
    expect(text()).toContain('$399.99 over budget');
    // A month over has no pace to be ahead of, and its categories open on that month.
    expect(screen.getByRole('link', { name: 'Groceries' }).getAttribute('href')).toBe(
      '#/category/food/2026-08',
    );
  });

  it('says a month within its budget is within it', () => {
    state.transactions = held([txn('a', '2026-08-03', -100, { source_category: 'Groceries' })]);
    month('2026-08');
    expect(text()).toContain('Within budget · $599.00 left');
  });

  it('has no month after this one', () => {
    month();
    expect(screen.queryByRole('link', { name: 'The month after' })).toBeNull();
  });
});

describe('a category', () => {
  beforeEach(aMonth);

  it('shows what it spent against its budget, the months before, and what is filed in it', () => {
    categoryPage('eat');
    expect(screen.getByRole('heading', { name: 'Eating out' })).toBeDefined();
    expect(text()).toContain('$45.00spent of $40.00');
    expect(text()).toContain('$5.00 over, with 5 days to go');
    expect(text()).toContain('Aug $0.00 · Jul $0.00 · Jun $0.00');
    const entries = region('Transactions 1 transaction');
    expect(text(entries)).toContain('Corner Cafe');
    expect(text(entries)).not.toContain('Whole Foods');
    expect(screen.getByRole('link', { name: '‹ Budget' }).getAttribute('href')).toBe('#/budget');
  });

  it('steps through its months, and back to the budget of the month shown', () => {
    categoryPage('food', '2026-08');
    const nav = screen.getByRole('navigation', { name: 'Month' });
    expect(within(nav).getByRole('link', { name: 'The month after' }).getAttribute('href')).toBe(
      '#/category/food',
    );
    expect(screen.getByRole('link', { name: '‹ Budget' }).getAttribute('href')).toBe(
      '#/budget/2026-08',
    );
    expect(text()).toContain('$399.99 over');
    expect(screen.queryByRole('button', { name: 'Set budget' })).toBeNull();
  });

  it('says so when nothing is filed in it this month', () => {
    state.transactions = held([]);
    categoryPage('food');
    expect(text()).toContain('None filed here in September 2026.');
    expect(text()).toContain('$0.00spent of $600.00');
  });

  it('sets its budget from its page', async () => {
    categoryPage('eat');
    fireEvent.click(screen.getByRole('button', { name: 'Set budget' }));
    const sheet = picker('Budget for Eating out');
    fireEvent.change(sheet.getByLabelText('Each month'), { target: { value: '50' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setBudget).toHaveBeenCalled());
    expect(setBudget.mock.calls[0]?.slice(0, 5)).toEqual([USER, 'eat', '2026-09', 5_000, 'USD']);
  });

  it('offers a first budget to one with none', () => {
    state.budgets = held([]);
    categoryPage('eat');
    expect(text()).toContain('spent, with no budget');
    expect(screen.getByRole('button', { name: 'Set a budget' })).toBeDefined();
  });

  it('files a transaction from the picker, keeps it in the list, and offers a rule', async () => {
    const view = categoryPage('food');
    openPicker('Whole Foods');
    const sheet = picker('Category for Whole Foods');
    // Her recent choice first; where it is filed now is marked, though Monarch put it there.
    expect(
      within(sheet.getByRole('region', { name: 'Recent' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Eating out']);
    expect(
      within(sheet.getByRole('region', { name: 'Spending' }))
        .getByRole('button', { name: 'Groceries' })
        .getAttribute('aria-current'),
    ).toBe('true');
    // A guess is not hers, so there is nothing to take back.
    expect(sheet.queryByRole('button', { name: 'Take my choice back' })).toBeNull();
    pickIn('Category for Whole Foods', 'Recent', 'Eating out');
    await waitFor(() => expect(chooseCategory).toHaveBeenCalled());
    expect(chooseCategory).toHaveBeenCalledWith(
      USER,
      'wf',
      'eat',
      expect.arrayContaining([expect.objectContaining({ id: 'c' })]),
    );
    expect(
      await screen.findByText(/File every “Whole Foods” under Eating out from September 2026 on\?/),
    ).toBeDefined();
    state.choices = held([CAFE_CHOICE, choiceOf('wf', 'eat')]);
    view.again();
    expect(
      screen.getByRole('button', { name: 'Category for Whole Foods: Eating out, yours' }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Make it a rule' }));
    await waitFor(() => expect(addRule).toHaveBeenCalled());
    expect(addRule).toHaveBeenCalledWith(USER, 'whole foods', 'eat', '2026-09');
    expect((await screen.findByRole('status')).textContent).toContain(
      'Earlier months are as they were.',
    );
  });

  it('takes her choice away, says where it goes back to, and offers no rule for it', async () => {
    categoryPage('eat');
    openPicker('Corner Cafe');
    expect(text(screen.getByRole('dialog'))).toContain('It goes back to uncategorized.');
    fireEvent.click(
      picker('Category for Corner Cafe').getByRole('button', { name: 'Take my choice back' }),
    );
    await waitFor(() => expect(chooseCategory).toHaveBeenCalled());
    expect(chooseCategory.mock.calls[0]?.[2]).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make it a rule' })).toBeNull();
  });

  it('declines a rule for just the one, and says why a choice was not saved', async () => {
    categoryPage('food');
    openPicker('Whole Foods');
    pickIn('Category for Whole Foods', 'Spending', 'Eating out');
    fireEvent.click(await screen.findByRole('button', { name: 'Just this one' }));
    expect(screen.queryByRole('button', { name: 'Make it a rule' })).toBeNull();
    expect(addRule).not.toHaveBeenCalled();

    chooseCategory.mockRejectedValue(new WriteError('the category was not saved', '42501'));
    openPicker('Whole Foods');
    pickIn('Category for Whole Foods', 'Spending', 'Eating out');
    expect((await screen.findByRole('alert')).textContent).toContain('code 42501');
  });

  it('turns categorizing off with no signal', () => {
    state.online = false;
    categoryPage('food');
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Category for Whole Foods: Groceries, Monarch’s guess',
      }).disabled,
    ).toBe(true);
  });

  it('counts the rules that file here, and opens them', () => {
    state.rules = held([
      rule('corner cafe', 'eat', '2026-09-01'),
      rule('canlis', 'eat', '2026-07-01'),
      rule('whole foods', 'food', '2026-07-01'),
    ]);
    categoryPage('eat');
    const link = screen.getByRole('link', { name: /^2 rules file here/ });
    expect(link.getAttribute('href')).toBe('#/rules?category=eat');
    expect(text(link)).toContain('1 made this month');
  });

  it('changes its name alone, leaving its budget', async () => {
    categoryPage('eat');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const sheet = picker('Edit Eating out');
    fireEvent.change(sheet.getByDisplayValue('Eating out'), { target: { value: 'Restaurants' } });
    fireEvent.click(sheet.getByRole('radio', { name: 'Income' }));
    expect(text(screen.getByRole('dialog'))).toContain('A kind is changed for every month');
    fireEvent.click(sheet.getByRole('radio', { name: 'Spending' }));
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateCategory).toHaveBeenCalled());
    expect(updateCategory).toHaveBeenCalledWith('eat', {
      name: 'Restaurants',
      kind: 'spend',
      guessesFrom: [],
    });
    expect(setBudget).not.toHaveBeenCalled();
  });

  it('offers Monarch’s names no category takes, and refuses no name', async () => {
    uncategorizedToo();
    updateCategory.mockRejectedValue(new WriteError('the category was not saved', '23505'));
    categoryPage('food');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const sheet = picker('Edit Groceries');
    fireEvent.click(sheet.getByRole('checkbox', { name: 'Parking' }));
    fireEvent.click(sheet.getByRole('checkbox', { name: 'Groceries' }));
    fireEvent.change(sheet.getByDisplayValue('Groceries'), { target: { value: ' ' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    expect(text(screen.getByRole('dialog'))).toContain('Give the category a name.');
    fireEvent.change(sheet.getByLabelText('Name'), { target: { value: 'Food' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateCategory).toHaveBeenCalledWith('food', {
        name: 'Food',
        kind: 'spend',
        guessesFrom: ['Parking'],
      }),
    );
    expect(await sheet.findByText(/code 23505/)).toBeDefined();
  });

  it('removes it after asking, and goes to the categories', async () => {
    categoryPage('eat');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Eating out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove Eating out' }));
    await waitFor(() => expect(removeCategory).toHaveBeenCalledWith('eat'));
    await waitFor(() => expect(window.location.hash).toBe('#/categories'));
  });

  it('says so when the category is gone', () => {
    categoryPage('gone');
    expect(text()).toContain('This category was removed.');
  });

  it('shows what came in for income, with no budget to set', () => {
    categoryPage('pay');
    expect(text()).toContain('$5,000.00came in');
    expect(screen.queryByRole('button', { name: /budget/i })).toBeNull();
  });

  it('shows what moved for a transfer, nothing when none did', () => {
    state.categories = held([food, eating, pay, category('move', 'Savings', { kind: 'transfer' })]);
    categoryPage('move');
    expect(text()).toContain('Transfer, not counted as spent');
    expect(text()).toContain('$0.00moved');
  });

  it('keeps the month beside it on a wide window, the category marked', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    categoryPage('eat');
    expect(screen.getByRole('region', { name: 'Budget, September 2026' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Eating out' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('heading', { name: 'Eating out' })).toBeDefined();
  });
});

describe('both sides of a transfer', () => {
  const moves = category('move', 'Transfers', { kind: 'transfer' });
  const out = txn('out', '2026-09-03', -200_000, {
    account_id: 'checking',
    payee: 'Chase Autopay',
  });
  const into = txn('in', '2026-09-04', 200_000, {
    payee: 'Payment Thank You',
    source_category: 'Groceries',
  });

  beforeEach(() => {
    state.categories = held([food, moves]);
    state.transactions = held([txn('wf', '2026-09-16', -12_000), out, into]);
  });

  it('files a card payment’s two sides together, the card’s before Monarch’s guess', () => {
    categoryPage('move');
    for (const payee of ['Chase Autopay', 'Payment Thank You']) {
      expect(
        screen.getByRole('button', {
          name: `Category for ${payee}: Transfers, paired as a transfer`,
        }),
      ).toBeDefined();
    }
    openPicker('Payment Thank You');
    expect(text(screen.getByRole('dialog'))).toContain(
      'Filed with its other side, Chase Autopay on Thu, Sep 3.',
    );
  });

  it('says a choice taken back goes back to the pair', () => {
    state.choices = held([choiceOf('out', 'move')]);
    categoryPage('move');
    openPicker('Chase Autopay');
    expect(text(screen.getByRole('dialog'))).toContain(
      'It goes back to Transfers, paired as a transfer.',
    );
  });
});

describe('goals in the month', () => {
  const moves = category('move', 'Transfers', { kind: 'transfer' });

  function goal(id: string, name: string, overrides: Partial<GoalRow> = {}): GoalRow {
    return {
      id,
      updated_at: AT,
      deleted_at: null,
      name,
      kind: 'payoff',
      currency: 'USD',
      target_minor: null,
      starts_on: '2026-01-01',
      target_on: null,
      created_at: AT,
      ...overrides,
    };
  }

  function link(goalId: string, accountId: string): GoalAccountRow {
    return {
      id: `${goalId}-${accountId}`,
      updated_at: AT,
      deleted_at: null,
      goal_id: goalId,
      account_id: accountId,
    };
  }

  beforeEach(() => {
    state.accounts = held([
      account('card', 'Customized Cash Rewards Visa Signature'),
      account('checking', 'Member Advantage Checking'),
      account('savings', 'Way2Save Savings'),
    ]);
    state.categories = held([food, moves]);
    state.transactions = held([
      // Groceries on the card: spending, and nothing given to paying it off.
      txn('wf', '2026-09-16', -12_000, { source_category: 'Groceries' }),
      txn('out', '2026-09-03', -200_000, { account_id: 'checking', payee: 'Chase Autopay' }),
      txn('in', '2026-09-04', 200_000, { payee: 'Payment Thank You' }),
      txn('aug-out', '2026-08-05', -50_000, { account_id: 'checking', payee: 'Chase Autopay' }),
      txn('aug-in', '2026-08-06', 50_000, { payee: 'Payment Thank You' }),
      txn('save-out', '2026-09-10', -30_000, { account_id: 'checking', payee: 'To savings' }),
      txn('save-in', '2026-09-10', 30_000, { account_id: 'savings', payee: 'From checking' }),
    ]);
    state.goals = held([
      goal('visa', 'Visa paid off'),
      goal('trip', 'Trip', {
        kind: 'save',
        target_minor: 400_000,
        created_at: '2026-09-25T10:00:00+00:00',
      }),
    ]);
    state.goalLinks = held([link('visa', 'card'), link('trip', 'savings')]);
    state.plans = held([
      {
        id: 'p',
        updated_at: AT,
        deleted_at: null,
        goal_id: 'visa',
        starts_on: '2026-09-01',
        amount_minor: 150_000,
      },
    ]);
  });

  it('shows what each goal was given beside the categories, against its plan', () => {
    month();
    const goals = region('Goals');
    expect(text(goals)).toContain('Visa paid off$2,000.00of $1,500.00');
    expect(text(goals)).toContain('Plan met, and $500.00 more');
    expect(text(goals)).toContain('Trip$300.00');
    expect(text(goals)).toContain('No plan');
    expect(screen.getByRole('button', { name: 'Set a plan for Trip' })).toBeDefined();
  });

  it('counts a card payment once: not spent, and given to the goal', () => {
    month();
    expect(text()).toContain('$120.00spent');
    expect(text(region('Goals'))).toContain('$2,000.00');
  });

  it('opens what counted, and sets the plan from this month, offering what it was given', async () => {
    month();
    fireEvent.click(screen.getByRole('button', { name: 'Visa paid off' }));
    const sheet = picker('Visa paid off in September 2026');
    expect(text(screen.getByRole('dialog'))).toContain('Payment Thank You');
    expect(text(screen.getByRole('dialog'))).toContain('Sep 4 · other side Chase Autopay, Sep 3');
    expect(text(screen.getByRole('dialog'))).not.toContain('Whole Foods');
    const input = sheet.getByLabelText('Plan each month');
    expect(input).toHaveProperty('value', '1,500.00');
    fireEvent.click(sheet.getByRole('button', { name: 'Use Aug, $500.00' }));
    expect(input).toHaveProperty('value', '500.00');
    fireEvent.change(input, { target: { value: '1800' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setPlan).toHaveBeenCalled());
    expect(setPlan.mock.calls[0]?.slice(0, 4)).toEqual([USER, 'visa', '2026-09', 180_000]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('refuses a plan that is not a number, and saves none when emptied', async () => {
    month();
    fireEvent.click(screen.getByRole('button', { name: 'Visa paid off' }));
    const sheet = picker('Visa paid off in September 2026');
    fireEvent.change(sheet.getByLabelText('Plan each month'), { target: { value: 'lots' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    expect(text(screen.getByRole('dialog'))).toContain(
      'Enter the plan as a number, like 500, or leave it empty.',
    );
    expect(setPlan).not.toHaveBeenCalled();
    fireEvent.change(sheet.getByLabelText('Plan each month'), { target: { value: '' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setPlan).toHaveBeenCalled());
    expect(setPlan.mock.calls[0]?.[3]).toBeNull();
  });

  it('says what was taken back out of a goal', () => {
    if (state.transactions.status !== 'held') throw new Error('no transactions');
    state.transactions = held([
      ...state.transactions.rows,
      txn('back-out', '2026-09-20', -50_000, { account_id: 'savings', payee: 'To checking' }),
      txn('back-in', '2026-09-21', 50_000, { account_id: 'checking', payee: 'From savings' }),
    ]);
    month();
    expect(text(region('Goals'))).toContain('Trip-$200.00');
    expect(text(region('Goals'))).toContain('$200.00 more taken out than put in');
  });

  it('keeps a month already over as it was, with no plan to set', () => {
    month('2026-08');
    const goals = region('Goals');
    // September's plan starts in September: August had none.
    expect(text(goals)).toContain('Visa paid off$500.00No plan');
    expect(text(goals)).toContain('Trip$0.00Nothing moved in yet');
    expect(screen.queryByRole('button', { name: /^Set a plan/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Visa paid off' }));
    expect(screen.queryByLabelText('Plan each month')).toBeNull();
  });

  it('shows no goals when she has none', () => {
    state.goals = held([]);
    month();
    expect(screen.queryByRole('region', { name: 'Goals' })).toBeNull();
  });
});

describe('the categories', () => {
  beforeEach(() => {
    aMonth();
    state.categories = held([food, eating, pay, category('school', 'Education')]);
  });

  it('lists each kind, sinking one nothing was ever filed under to its foot', () => {
    show(() => <Categories userId={USER} />);
    const spending = region('Spending · 3');
    expect(
      within(spending)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Eating out$40.00 a month', 'Groceries$600.00 a month', 'EducationNo transactions']);
    expect(
      within(spending)
        .getByRole('link', { name: /^Education/ })
        .getAttribute('href'),
    ).toBe('#/category/school');
    expect(text(region('Income · 1'))).toContain('Paychecks');
    expect(text(region('Rules'))).toContain('None yet.');
  });

  it('says there are none, and that the budget offers a start', () => {
    state.categories = held([]);
    show(() => <Categories userId={USER} />);
    expect(text()).toContain('No categories yet.');
  });

  it('names a spending category with no budget, and counts the rules', () => {
    state.budgets = held([budget('food', '2026-01-01', 60_000)]);
    state.rules = held([rule('a', 'eat', '2026-09-01'), rule('b', 'food', '2026-06-01')]);
    show(() => <Categories userId={USER} />);
    expect(text(region('Spending · 3'))).toContain('Eating outNo budget');
    const rules = screen.getByRole('link', { name: /^2 rules/ });
    expect(rules.getAttribute('href')).toBe('#/rules');
    expect(text(rules)).toContain('1 made this month');
  });

  it('adds a category in a sheet', async () => {
    show(() => <Categories userId={USER} />);
    fireEvent.click(screen.getByRole('button', { name: 'New category' }));
    const sheet = picker('New category');
    fireEvent.change(sheet.getByLabelText('Name'), { target: { value: 'Rent' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Add category' }));
    await waitFor(() =>
      expect(addCategory).toHaveBeenCalledWith(USER, {
        name: 'Rent',
        kind: 'spend',
        guessesFrom: [],
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('the rules', () => {
  const many = () => [
    ...Array.from({ length: 22 }, (_, i) =>
      rule(
        `payee ${String(i).padStart(2, '0')}`,
        'eat',
        '2026-08-01',
        `2026-08-0${(i % 9) + 1}T00:00:00Z`,
      ),
    ),
    rule('café de flore', 'food', '2026-09-01', '2026-09-20T00:00:00Z'),
    rule('gone', 'removed', '2026-09-01', '2026-09-19T00:00:00Z'),
  ];

  beforeEach(() => {
    aMonth();
    state.rules = held(many());
  });

  const rules = (categoryId: string | null = null) =>
    show(() => <Rules categoryId={categoryId} userId={USER} />);

  it('lists the newest, and says how many more there are to find', () => {
    rules();
    expect(text()).toContain('24 rules · 2 made this month');
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(20);
    expect(items[0]?.textContent).toBe('“café de flore”Groceries');
    expect(items[1]?.textContent).toBe('“gone”A removed category');
    expect(text()).toContain('And 4 more: type to find one.');
  });

  it('finds a rule by payee, and by category', () => {
    rules();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a rule by payee' }), {
      target: { value: 'CAFE' },
    });
    expect(screen.getByRole('heading', { name: '1 rule' })).toBeDefined();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a rule by payee' }), {
      target: { value: 'nothing like it' },
    });
    expect(text()).toContain('No rule for a payee like that.');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a rule by payee' }), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), {
      target: { value: 'eat' },
    });
    expect(screen.getByRole('heading', { name: '22 rules' })).toBeDefined();
    expect(screen.getAllByRole('listitem')).toHaveLength(22);
  });

  it('opens on one category’s rules from its page', () => {
    rules('food');
    expect(screen.getByRole('heading', { name: '1 rule' })).toBeDefined();
  });

  it('changes where a rule files, from this month', async () => {
    rules();
    fireEvent.click(screen.getByRole('button', { name: '“café de flore”Groceries' }));
    const sheet = picker('“café de flore”');
    expect(text(screen.getByRole('dialog'))).toContain(
      'Files into Groceries since September 2026.',
    );
    expect(sheet.getByRole('link', { name: 'See its transactions' }).getAttribute('href')).toBe(
      '#/payee/caf%C3%A9%20de%20flore',
    );
    fireEvent.click(sheet.getByRole('button', { name: 'Change category' }));
    pickIn('“café de flore”', 'Spending', 'Eating out');
    await waitFor(() =>
      expect(addRule).toHaveBeenCalledWith(USER, 'café de flore', 'eat', '2026-09'),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stops a rule from this month, and says why when it was not saved', async () => {
    addRule.mockRejectedValueOnce(new WriteError('the rule was not saved', '42501'));
    rules();
    fireEvent.click(screen.getByRole('button', { name: '“gone”A removed category' }));
    expect(text(screen.getByRole('dialog'))).toContain('Files into a removed category');
    fireEvent.click(screen.getByRole('button', { name: 'Stop the rule for gone' }));
    expect(await screen.findByText(/code 42501/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Stop the rule for gone' }));
    await waitFor(() => expect(addRule).toHaveBeenLastCalledWith(USER, 'gone', null, '2026-09'));
  });

  it('says there are none yet', () => {
    state.rules = held([rule('x', 'eat', '2026-01-01'), rule('x', null, '2026-02-01')]);
    rules();
    expect(text()).toContain('0 rules · 0 made this month');
    expect(text()).toContain('None yet.');
  });
});

describe('categorizing', () => {
  beforeEach(() => {
    aMonth();
    uncategorizedToo();
  });

  const queue = (m: string | null = null) => show(() => <Categorize month={m} userId={USER} />);

  it('goes one at a time, and asks the rule question on each', async () => {
    const view = queue();
    let card = screen.getByRole('article', { name: 'Pay by Phone' });
    expect(text(card)).toContain('1 of 3');
    // The two clues to what it was: the bank's words, and what Monarch called it.
    expect(text(card)).toContain('“PAYBYPHONE 4411”');
    expect(text(card)).toContain('Monarch called it Parking.');
    // Her recent choice is a tap away, without opening the picker.
    fireEvent.click(within(card).getByRole('button', { name: 'Eating out' }));
    await waitFor(() =>
      expect(chooseCategory).toHaveBeenCalledWith(USER, 'park', 'eat', expect.anything()),
    );
    fireEvent.click(await within(card).findByRole('button', { name: 'Just this one' }));
    expect(addRule).not.toHaveBeenCalled();
    state.choices = held([CAFE_CHOICE, choiceOf('park', 'eat')]);
    view.again();

    card = screen.getByRole('article', { name: 'Square *Odd' });
    expect(text(card)).toContain('2 of 3');
    expect(screen.getByRole('status').textContent).toContain(
      'Pay by Phone is filed under Eating out.',
    );
    fireEvent.click(within(card).getByRole('button', { name: 'Eating out' }));
    fireEvent.click(await within(card).findByRole('button', { name: 'Make it a rule' }));
    await waitFor(() =>
      expect(addRule).toHaveBeenCalledWith(USER, 'square *odd', 'eat', '2026-09'),
    );
    // The rule files the other from Square *Odd, so the queue passes over it.
    state.choices = held([CAFE_CHOICE, choiceOf('park', 'eat'), choiceOf('odd2', 'eat')]);
    state.rules = held([rule('square *odd', 'eat', '2026-09-01')]);
    view.again();
    expect(
      await screen.findByText('Nothing is left to categorize in September 2026.'),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the budget' }));
    expect(window.location.hash).toBe('#/budget');
  });

  it('skips one to come back to, and goes back to the one before', () => {
    queue();
    const at = () => text(screen.getByRole('article'));
    expect(at()).toContain('1 of 3');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Back' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(at()).toContain('3 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(at()).toContain('1 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(at()).toContain('1 of 3');
  });

  it('opens the picker for a category not among the recent ones', async () => {
    queue();
    fireEvent.click(screen.getByRole('button', { name: 'Another category…' }));
    const sheet = picker('Category for Pay by Phone');
    fireEvent.change(sheet.getByRole('searchbox', { name: 'Find a category' }), {
      target: { value: 'PAY' },
    });
    expect(
      within(sheet.getByRole('list'))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Paychecks']);
    fireEvent.change(sheet.getByRole('searchbox', { name: 'Find a category' }), {
      target: { value: 'rent' },
    });
    expect(text(screen.getByRole('dialog'))).toContain('No category has “rent” in its name.');
    fireEvent.change(sheet.getByRole('searchbox', { name: 'Find a category' }), {
      target: { value: '' },
    });
    pickIn('Category for Pay by Phone', 'Spending', 'Groceries');
    await waitFor(() =>
      expect(chooseCategory).toHaveBeenCalledWith(USER, 'park', 'food', expect.anything()),
    );
    expect(await screen.findByRole('button', { name: 'Make it a rule' })).toBeDefined();
  });

  it('says categorizing waits for a signal', () => {
    state.online = false;
    queue();
    const card = screen.getByRole('article');
    expect(text(card)).toContain('Categorizing waits for a signal.');
    expect(
      within(card).getByRole<HTMLButtonElement>('button', { name: 'Eating out' }).disabled,
    ).toBe(true);
  });

  it('goes back to the month it came from', () => {
    queue('2026-08');
    expect(screen.getByRole('link', { name: '‹ Budget' }).getAttribute('href')).toBe(
      '#/budget/2026-08',
    );
  });
});

describe('readCategory and readBudget', () => {
  it('reads a name, and refuses none', () => {
    expect(readCategory({ name: ' Groceries ', kind: 'spend', guessesFrom: [] })).toEqual({
      ok: true,
      name: 'Groceries',
      kind: 'spend',
      guessesFrom: [],
    });
    expect(readCategory({ name: ' ', kind: 'spend', guessesFrom: [] })).toEqual({
      ok: false,
      problem: { field: 'name', message: 'Give the category a name.' },
    });
  });

  it('reads a budget, empty as none, and refuses what is not a number', () => {
    expect(readBudget('600')).toEqual({ ok: true, minor: 60_000 });
    expect(readBudget('  ')).toEqual({ ok: true, minor: null });
    expect(readBudget('lots')).toMatchObject({ ok: false, problem: { field: 'budget' } });
  });
});
