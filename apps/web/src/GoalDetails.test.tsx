import type { AccountRow } from '@dinora/core/balances';
import type { GoalAccountRow, GoalKind, GoalRow, Progress } from '@dinora/core/goals';
import type { GroupRow } from '@dinora/core/groups';
import type { SnapshotRow } from '@dinora/core/history';
import type { RateRow } from '@dinora/core/rates';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GoalDetails as Details } from './queries/goals.ts';
import type { SyncedRows } from './queries/synced.ts';
import { WriteError } from './queries/writes.ts';

// Noon UTC, so her local day is 25 Sep wherever the tests run.
const NOW = Date.parse('2026-09-25T12:00:00Z');
const TODAY = '2026-09-25';
const USER = '11111111-1111-1111-1111-111111111111';

const state: {
  goals: SyncedRows<GoalRow>;
  links: SyncedRows<GoalAccountRow>;
  accounts: SyncedRows<AccountRow>;
  groups: SyncedRows<GroupRow>;
  snapshots: SyncedRows<SnapshotRow>;
  rates: SyncedRows<RateRow>;
  online: boolean;
} = {
  goals: { status: 'waiting' },
  links: { status: 'waiting' },
  accounts: { status: 'waiting' },
  groups: { status: 'waiting' },
  snapshots: { status: 'waiting' },
  rates: { status: 'waiting' },
  online: true,
};

const addGoal =
  vi.fn<
    (
      user: string,
      kind: GoalKind,
      currency: string,
      details: Details,
      accountIds: readonly string[],
    ) => Promise<string>
  >();
const updateGoal = vi.fn<(id: string, details: Details) => Promise<void>>();
const setAccounts =
  vi.fn<
    (
      user: string,
      goal: string,
      links: readonly GoalAccountRow[],
      wanted: readonly string[],
    ) => Promise<void>
  >();
const removeGoal = vi.fn<(id: string) => Promise<void>>();

vi.mock('./queries/synced.ts', () => ({
  useSynced: (table: { name: string }) => {
    switch (table.name) {
      case 'goals':
        return state.goals;
      case 'goal_accounts':
        return state.links;
      case 'accounts':
        return state.accounts;
      case 'account_groups':
        return state.groups;
      case 'balance_snapshots':
        return state.snapshots;
      case 'fx_rates':
        return state.rates;
      default:
        return { status: 'waiting' };
    }
  },
  defineSynced: (spec: { name: string }) => ({ ...spec, queryKey: ['synced', spec.name] }),
}));
vi.mock('./queries/goals.ts', () => ({
  GOALS: { name: 'goals', queryKey: ['synced', 'goals'] },
  GOAL_ACCOUNTS: { name: 'goal_accounts', queryKey: ['synced', 'goal_accounts'] },
  addGoal,
  updateGoal,
  setAccounts,
  removeGoal,
}));
vi.mock('./queries/balances.ts', () => ({
  ACCOUNTS: { name: 'accounts', queryKey: ['synced', 'accounts'] },
  FX_RATES: { name: 'fx_rates', queryKey: ['synced', 'fx_rates'] },
}));
vi.mock('./queries/history.ts', () => ({
  BALANCE_SNAPSHOTS: { name: 'balance_snapshots', queryKey: ['synced', 'balance_snapshots'] },
}));
vi.mock('./queries/groups.ts', () => ({
  ACCOUNT_GROUPS: { name: 'account_groups', queryKey: ['synced', 'account_groups'] },
}));
vi.mock('./device/useOnline.ts', () => ({ useOnline: () => state.online }));

const { currencyFor, describeAway, GoalDetails, NewGoal, readGoal, shortLine } =
  await import('./GoalDetails.tsx');

function account(id: string, name: string, minor: number, extra: Partial<AccountRow> = {}) {
  return {
    id,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    institution: 'PSCU',
    name,
    currency: 'USD',
    balance_minor: minor,
    balance_at: '2026-09-25T09:00:00+00:00',
    holdings: 0,
    source: 'simplefin',
    ...extra,
  } satisfies AccountRow;
}

const SAVINGS = account('sav', 'High Yield Savings', 1_500_000);
const LOAN = account('auto', 'Auto Loan', -1_500_000);

function snap(accountId: string, onDate: string, minor: number, kind: SnapshotRow['kind']) {
  return {
    id: `${accountId}-${onDate}`,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    account_id: accountId,
    on_date: onDate,
    kind,
    currency: 'USD',
    balance_minor: minor,
    as_of: `${onDate}T09:00:00+00:00`,
  } satisfies SnapshotRow;
}

const FUND: GoalRow = {
  id: 'fund',
  updated_at: '2026-09-25T09:00:00+00:00',
  deleted_at: null,
  name: 'Emergency fund',
  kind: 'save',
  currency: 'USD',
  target_minor: 2_000_000,
  starts_on: '2026-01-01',
  target_on: '2027-01-01',
  created_at: '2026-09-25T09:00:00+00:00',
};

const CAR: GoalRow = {
  ...FUND,
  id: 'car',
  name: 'Civic paid off',
  kind: 'payoff',
  target_minor: null,
  starts_on: '2024-01-01',
  target_on: null,
};

function counts(goalId: string, accountId: string): GoalAccountRow {
  return {
    id: `${goalId}-${accountId}`,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    goal_id: goalId,
    account_id: accountId,
  };
}

function held<Row>(rows: Row[]): SyncedRows<Row> {
  return { status: 'held', rows, asOf: NOW, refreshing: false, stale: false };
}

function show(which: 'goal' | 'new' = 'goal', goalId = 'fund') {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const page = () => (
    <QueryClientProvider client={client}>
      {which === 'goal' ? <GoalDetails goalId={goalId} userId={USER} /> : <NewGoal userId={USER} />}
    </QueryClientProvider>
  );
  const { rerender } = render(page());
  return { invalidate, again: () => rerender(page()) };
}

/** The edit sheet (UI-03), opened from the page. */
function openEdit(name = 'Emergency fund') {
  fireEvent.click(screen.getByRole('button', { name: 'Edit goal' }));
  return within(screen.getByRole('dialog', { name: `Edit ${name}` }));
}

function text(element: Element = document.body): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ');
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.goals = held([FUND, CAR]);
  state.links = held([counts('fund', 'sav'), counts('car', 'auto')]);
  state.accounts = held([SAVINGS, LOAN]);
  state.groups = held([]);
  // $12,000 saved 90 days back; the loan owed $30,000 on Monarch's first day, $18,000 then.
  state.snapshots = held([
    snap('sav', '2026-06-27', 1_200_000, 'read'),
    snap('auto', '2024-04-16', -3_000_000, 'monarch'),
    snap('auto', '2026-06-27', -1_800_000, 'read'),
  ]);
  state.rates = held([]);
  state.online = true;
  for (const mock of [addGoal, updateGoal, setAccounts, removeGoal]) mock.mockReset();
  window.location.hash = '';
});

describe('a goal', () => {
  it('waits for the disk', () => {
    state.goals = { status: 'waiting' };
    show();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('is not found when removed or unknown, and says when nothing was saved', () => {
    state.goals = held([{ ...FUND, deleted_at: '2026-09-24T00:00:00+00:00' }]);
    show();
    expect(text()).toContain('This goal is not in Dinora.');
  });

  it('says when the server cannot be reached and nothing was saved', () => {
    state.goals = { status: 'failed' };
    show();
    expect(text()).toContain('Dinora could not be reached');
  });

  it('shows a saving against its target, its pace, and that it is behind its date', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Emergency fund' })).toBeDefined();
    expect(text()).toContain('Savings goal');
    expect(text()).toContain('$15,000.00of $20,000.00');
    expect(text()).toContain('75% there, $5,000.00 to go.');
    expect(screen.getByRole('progressbar', { name: 'Emergency fund, saved' })).toBeDefined();
    expect(text()).toContain('At the pace of the last 90 days, about $1,013.88 a month');
    expect(text()).toContain('it gets there on');
    expect(text()).toContain('3 months away.');
    expect(text()).toContain('Making it would take about $1,551.87 a month from now.');
    expect(text()).toContain('Behind for');
    // The account it counts, with its balance.
    expect(
      text(
        screen.getByRole('heading', { name: 'The account it counts' }).parentElement ??
          document.body,
      ),
    ).toContain('High Yield Savings');
  });

  it('draws where a saving has been and where its pace takes it, against its target', () => {
    show();
    const chart = screen.getByRole('img', { name: /^Emergency fund, saved since its start/ });
    expect(chart.getAttribute('aria-label')).toContain('and at its pace reached on');
    expect(text(chart)).toContain('Target $20,000');
    expect(text(chart)).toContain('Reach it by');
    expect(text()).toContain('The broken line goes on at that pace until it meets the target');
    // Month-ends back from today to its start, which moved to the account's first row.
    const table = chart.closest('figure')?.querySelector('table');
    expect(text(table ?? document.body)).toContain('Sat, Jun 27, 2026');
    expect(text(table ?? document.body)).toContain('Projected');
  });

  it('draws a payoff as what is owed, with no target across it', () => {
    show('goal', 'car');
    const chart = screen.getByRole('img', { name: /^Civic paid off, owed since its start/ });
    expect(text(chart)).not.toContain('Target');
    expect(text()).toContain('until nothing is owed');
  });

  it('draws no finish while the pace cannot be told', () => {
    state.snapshots = held([snap('sav', '2026-09-01', 1_500_000, 'read')]);
    show();
    const chart = screen.getByRole('img', { name: /^Emergency fund, saved since its start/ });
    expect(chart.getAttribute('aria-label')).not.toContain('at its pace');
    expect(text()).not.toContain('The broken line');
  });

  it('shows a payoff from Monarch’s first day, and says the start moved', () => {
    show('goal', 'car');
    expect(text()).toContain('Loan payoff');
    expect(text()).toContain('$15,000.00owed');
    expect(text()).toContain('50% paid off: $15,000.00 since');
    expect(text()).toContain('when it owed $30,000.00 (Monarch’s balance).');
    expect(text()).toContain('Dinora’s history starts on');
    expect(screen.getByRole('progressbar', { name: 'Civic paid off, paid off' })).toBeDefined();
  });

  it('says a loan owes more than at its start', () => {
    state.accounts = held([SAVINGS, { ...LOAN, balance_minor: -3_100_000 }]);
    show('goal', 'car');
    expect(text()).toContain('0% paid off: it owes $1,000.00 more than on');
    expect(text()).toContain('It has not moved toward the goal the last 90 days');
  });

  it('says so once reached', () => {
    state.accounts = held([
      { ...SAVINGS, balance_minor: 2_000_000 },
      { ...LOAN, balance_minor: 0 },
    ]);
    show();
    expect(text()).toContain('Reached: 100% of the target.');
    expect(text()).not.toContain('Behind for');
  });

  it('says a payoff is paid off', () => {
    state.accounts = held([SAVINGS, { ...LOAN, balance_minor: 0 }]);
    show('goal', 'car');
    expect(text()).toContain('Paid off.');
  });

  it('has no share when nothing was owed on the start', () => {
    state.snapshots = held([snap('auto', '2024-01-01', 0, 'read')]);
    show('goal', 'car');
    expect(text()).toContain('It owed nothing on');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('has no start before the loan has history', () => {
    state.snapshots = held([]);
    show('goal', 'car');
    expect(text()).toContain('Dinora has no balance for it yet to measure from.');
    expect(text()).toContain('No pace: there is no balance to measure it from.');
  });

  it('says a date has passed', () => {
    state.goals = held([{ ...FUND, starts_on: '2026-01-01', target_on: '2026-09-01' }]);
    show();
    expect(text()).toContain('It was due on');
  });

  it('says it is on pace for a date the pace makes, with no pace when it cannot be told', () => {
    state.goals = held([{ ...FUND, target_on: '2027-06-01' }]);
    show();
    expect(text()).toContain('On pace for');
  });

  it('says due, not on pace or behind, while the pace cannot be told', () => {
    state.goals = held([{ ...FUND, starts_on: '2026-09-10', target_on: '2027-06-01' }]);
    show();
    expect(text()).toContain('Too soon to tell a pace: 15 days of history, and a pace needs 30.');
    expect(text()).toMatch(/Due .*months away\./);
  });

  it('says when it counts nothing, or a currency has no rate', () => {
    state.links = held([]);
    show();
    expect(text()).toContain('It counts no accounts yet.');
  });

  it('says when an account it counts has no rate', () => {
    state.accounts = held([{ ...SAVINGS, currency: 'EUR' }, LOAN]);
    show();
    expect(text()).toContain('no rate into USD yet');
  });

  it('saves what she changes, and the accounts it counts', async () => {
    updateGoal.mockResolvedValue();
    setAccounts.mockResolvedValue();
    const { invalidate } = show();
    const sheet = openEdit();
    fireEvent.change(sheet.getByLabelText('Name'), { target: { value: 'Rainy day' } });
    fireEvent.change(sheet.getByLabelText('Target'), { target: { value: '25,000' } });
    fireEvent.change(sheet.getByLabelText('Reach it by'), {
      target: { value: '' },
    });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    // Saved, the sheet closes and the page shows the goal as it now stands.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(updateGoal).toHaveBeenCalledWith('fund', {
      name: 'Rainy day',
      targetMinor: 2_500_000,
      startsOn: '2026-01-01',
      targetOn: null,
    });
    expect(setAccounts).toHaveBeenCalledWith(
      USER,
      'fund',
      [counts('fund', 'sav'), counts('car', 'auto')],
      ['sav'],
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['synced', 'goals'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['synced', 'goal_accounts'] });
  });

  it('offers only what a saving can count, and keeps what it counts', () => {
    show();
    const accounts = openEdit().getByRole('group', { name: 'Accounts it counts' });
    expect(within(accounts).getByRole('checkbox', { name: /High Yield Savings/ })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(accounts).queryByRole('checkbox', { name: /Auto Loan/ })).toBeNull();
  });

  it('says what is wrong rather than saving it', () => {
    show();
    const sheet = openEdit();
    fireEvent.change(sheet.getByLabelText('Name'), { target: { value: ' ' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    expect(sheet.getByRole('alert').textContent).toBe('Give the goal a name.');
    expect(updateGoal).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit Emergency fund' })).toBeDefined();
  });

  it('closes the sheet on Cancel, saving nothing', () => {
    show();
    const sheet = openEdit();
    fireEvent.change(sheet.getByLabelText('Name'), { target: { value: 'Rainy day' } });
    fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(updateGoal).not.toHaveBeenCalled();
    expect(setAccounts).not.toHaveBeenCalled();
    // Opened again, it starts from the goal as saved, not the draft left behind.
    expect(openEdit().getByLabelText('Name')).toHaveProperty('value', 'Emergency fund');
  });

  it('says why a save failed', async () => {
    updateGoal.mockRejectedValue(new WriteError('the goal was not saved', '42501'));
    show();
    const sheet = openEdit();
    fireEvent.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sheet.getByRole('alert').textContent).toBe(
        'Not saved: Dinora refused it (code 42501).',
      ),
    );
  });

  it('is off with no signal', () => {
    state.online = false;
    show();
    expect(text()).toContain('It can be changed when this device is back online.');
    expect(screen.getByRole('button', { name: 'Edit goal' })).toHaveProperty('disabled', true);
  });

  it('switches off a sheet already open when the signal goes', () => {
    const { again } = show();
    const sheet = openEdit();
    state.online = false;
    again();
    expect(sheet.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(sheet.getByRole('button', { name: 'Remove Emergency fund' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('is removed in two steps, and goes back to the dashboard', async () => {
    removeGoal.mockResolvedValue();
    show();
    const sheet = openEdit();
    fireEvent.click(sheet.getByRole('button', { name: 'Remove Emergency fund' }));
    expect(text()).toContain('It leaves the dashboard. Its accounts stay as they are.');
    fireEvent.click(sheet.getByRole('button', { name: 'Keep' }));
    expect(removeGoal).not.toHaveBeenCalled();
    fireEvent.click(sheet.getByRole('button', { name: 'Remove Emergency fund' }));
    fireEvent.click(sheet.getByRole('button', { name: 'Yes, remove Emergency fund' }));
    await waitFor(() => expect(window.location.hash).toBe('#/'));
    expect(removeGoal).toHaveBeenCalledWith('fund');
  });

  it('says why a removal failed', async () => {
    removeGoal.mockRejectedValue(new TypeError('Failed to fetch'));
    show();
    const sheet = openEdit();
    fireEvent.click(sheet.getByRole('button', { name: 'Remove Emergency fund' }));
    fireEvent.click(sheet.getByRole('button', { name: 'Yes, remove Emergency fund' }));
    await waitFor(() =>
      expect(sheet.getByRole('alert').textContent).toBe(
        'Not removed. Try again when Dinora can be reached.',
      ),
    );
  });
});

describe('a new goal', () => {
  it('adds a saving over the accounts she picks, and opens it', async () => {
    addGoal.mockResolvedValue('new-id');
    const { invalidate } = show('new');
    expect(screen.getByRole('heading', { name: 'A goal' })).toBeDefined();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Emergency fund' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /High Yield Savings/ }));
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: '$20,000' } });
    // The start follows the accounts chosen: the oldest day they have.
    expect(screen.getByLabelText('Measure its pace from')).toHaveProperty('value', '2026-06-27');
    fireEvent.change(screen.getByLabelText('Reach it by'), {
      target: { value: '2027-01-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));
    await waitFor(() => expect(window.location.hash).toBe('#/goal/new-id'));
    expect(addGoal).toHaveBeenCalledWith(
      USER,
      'save',
      'USD',
      {
        name: 'Emergency fund',
        targetMinor: 2_000_000,
        startsOn: '2026-06-27',
        targetOn: '2027-01-01',
      },
      ['sav'],
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['synced', 'goals'] });
  });

  it('adds a payoff from the loan’s oldest day, with no target', async () => {
    addGoal.mockResolvedValue('new-id');
    show('new');
    fireEvent.click(screen.getByRole('radio', { name: 'Pay off a loan' }));
    expect(screen.queryByLabelText('Target')).toBeNull();
    const loans = screen.getByRole('group', { name: 'Loans it pays off' });
    expect(within(loans).queryByRole('checkbox', { name: /High Yield Savings/ })).toBeNull();
    fireEvent.click(within(loans).getByRole('checkbox', { name: /Auto Loan/ }));
    expect(screen.getByLabelText('Measure from')).toHaveProperty('value', '2024-04-16');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Civic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));
    await waitFor(() => expect(addGoal).toHaveBeenCalled());
    expect(addGoal).toHaveBeenCalledWith(
      USER,
      'payoff',
      'USD',
      { name: 'Civic', targetMinor: null, startsOn: '2024-04-16', targetOn: null },
      ['auto'],
    );
  });

  it('keeps a start she sets, and takes an account back out', () => {
    show('new');
    const savings = screen.getByRole('checkbox', { name: /High Yield Savings/ });
    fireEvent.click(savings);
    fireEvent.change(screen.getByLabelText('Measure its pace from'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.click(savings);
    expect(savings).toHaveProperty('checked', false);
    expect(screen.getByLabelText('Measure its pace from')).toHaveProperty('value', '2026-08-01');
  });

  it('says there is no loan to choose, and switching kind drops what was chosen', () => {
    state.accounts = held([SAVINGS]);
    show('new');
    fireEvent.click(screen.getByRole('checkbox', { name: /High Yield Savings/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Pay off a loan' }));
    expect(text()).toContain('No loans or cards are linked.');
    fireEvent.click(screen.getByRole('radio', { name: 'Save toward a target' }));
    expect(screen.getByRole('checkbox', { name: /High Yield Savings/ })).toHaveProperty(
      'checked',
      false,
    );
  });

  it('says there is no saving account to choose', () => {
    state.accounts = held([LOAN]);
    show('new');
    expect(text()).toContain('No cash or investment accounts are linked.');
  });

  it('says why an add failed, and is off with no signal', async () => {
    addGoal.mockRejectedValue(new TypeError('Failed to fetch'));
    show('new');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fund' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /High Yield Savings/ }));
    fireEvent.change(screen.getByLabelText('Target'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Not saved. Try again when Dinora can be reached.',
      ),
    );
  });

  it('is off with no signal', () => {
    state.online = false;
    show('new');
    expect(text()).toContain('It can be added when this device is back online.');
    expect(screen.getByRole('button', { name: 'Add goal' })).toHaveProperty('disabled', true);
  });

  it('says what is wrong with the form rather than adding it', () => {
    show('new');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fund' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add goal' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'Choose at least one account for it to count.',
    );
    expect(addGoal).not.toHaveBeenCalled();
  });
});

describe('reading the form', () => {
  const draft = {
    name: 'Fund',
    target: '20,000',
    startsOn: null,
    targetOn: '',
    accountIds: ['sav'],
  };

  it('takes a saving with a target, and a payoff without one', () => {
    expect(readGoal(draft, 'save', 'USD', '2026-06-01', TODAY)).toEqual({
      ok: true,
      details: { name: 'Fund', targetMinor: 2_000_000, startsOn: '2026-06-01', targetOn: null },
      accountIds: ['sav'],
    });
    expect(readGoal({ ...draft, target: '' }, 'payoff', 'USD', '2026-06-01', TODAY)).toMatchObject({
      ok: true,
      details: { targetMinor: null },
    });
  });

  it('refuses what the table would, in words she can act on', () => {
    const problem = (read: ReturnType<typeof readGoal>) => (read.ok ? null : read.problem.message);
    expect(
      problem(readGoal({ ...draft, name: 'x'.repeat(201) }, 'save', 'USD', TODAY, TODAY)),
    ).toBe('Give the goal a name.');
    expect(problem(readGoal({ ...draft, target: '0' }, 'save', 'USD', TODAY, TODAY))).toBe(
      'Enter the target as a number, like 20,000.',
    );
    expect(problem(readGoal({ ...draft, target: 'lots' }, 'save', 'USD', TODAY, TODAY))).toBe(
      'Enter the target as a number, like 20,000.',
    );
    expect(problem(readGoal(draft, 'save', 'USD', '', TODAY))).toBe(
      'Say the day to measure from, today or before.',
    );
    expect(problem(readGoal(draft, 'save', 'USD', '2026-09-26', TODAY))).toBe(
      'Say the day to measure from, today or before.',
    );
    expect(
      problem(readGoal({ ...draft, targetOn: '2026-06-01' }, 'save', 'USD', '2026-06-01', TODAY)),
    ).toBe('The day to reach it has to be after the day it starts.');
  });

  // UI-02: each problem names the field it is about, so the form marks that field.
  it('says which field each problem is about', () => {
    const field = (read: ReturnType<typeof readGoal>) => (read.ok ? null : read.problem.field);
    expect(field(readGoal({ ...draft, name: '' }, 'save', 'USD', TODAY, TODAY))).toBe('name');
    expect(field(readGoal({ ...draft, accountIds: [] }, 'save', 'USD', TODAY, TODAY))).toBe(
      'accounts',
    );
    expect(field(readGoal({ ...draft, target: 'lots' }, 'save', 'USD', TODAY, TODAY))).toBe(
      'target',
    );
    expect(field(readGoal(draft, 'save', 'USD', '', TODAY))).toBe('startsOn');
    expect(
      field(readGoal({ ...draft, targetOn: '2026-06-01' }, 'save', 'USD', '2026-06-01', TODAY)),
    ).toBe('targetOn');
  });

  it('is in the one currency its accounts share, and dollars when they are mixed', () => {
    const euro = { ...SAVINGS, currency: 'EUR' };
    expect(currencyFor([euro])).toBe('EUR');
    expect(currencyFor([euro, LOAN])).toBe('USD');
    expect(currencyFor([])).toBe('USD');
  });
});

describe('how far off a date is', () => {
  it('is days for two months, then months for two years, then years', () => {
    expect(describeAway(1)).toBe('1 day away');
    expect(describeAway(59)).toBe('59 days away');
    expect(describeAway(60)).toBe('1 month away');
    expect(describeAway(213)).toBe('7 months away');
    expect(describeAway(729)).toBe('23 months away');
    expect(describeAway(730)).toBe('2 years away');
    expect(describeAway(4846)).toBe('13 years away');
  });
});

describe('the dashboard’s line', () => {
  const pace = { kind: 'too-early', days: 3 } as const;
  const save = (extra: Partial<Extract<Progress, { kind: 'save' }>>): Progress => ({
    kind: 'save',
    balanceMinor: 0n,
    targetMinor: 1n,
    tenths: 425,
    reached: false,
    gapMinor: 1n,
    pace,
    deadline: null,
    ...extra,
  });
  const deadline = { on: '2027-01-01', daysLeft: 98, perMonthNeededMinor: 1n, onPace: true };

  it('says the share, and when it gets there if that can be told', () => {
    expect(shortLine({ kind: 'no-accounts' })).toBe('Counts no accounts yet');
    expect(shortLine({ kind: 'unrated' })).toBe('Not worked out yet');
    expect(shortLine(save({}))).toBe('42.5%');
    expect(shortLine(save({ reached: true }))).toBe('Reached');
    expect(shortLine(save({ deadline }))).toMatch(/^42\.5% · on pace for Jan 2027$/);
    expect(shortLine(save({ deadline: { ...deadline, onPace: false } }))).toMatch(
      /behind for Jan 2027/,
    );
    expect(shortLine(save({ deadline: { ...deadline, daysLeft: 0 } }))).toMatch(/was due Jan 2027/);
    expect(shortLine(save({ pace: { kind: 'stalled', from: TODAY, movedMinor: 0n } }))).toBe(
      '42.5% · not moving',
    );
    expect(
      shortLine(
        save({
          pace: { kind: 'moving', from: TODAY, movedMinor: 1n, perMonthMinor: 1n, finishOn: null },
        }),
      ),
    ).toBe('42.5%');
  });

  it('says a payoff is paid off, and has no share without a start', () => {
    const payoff: Progress = {
      kind: 'payoff',
      owedMinor: 0n,
      start: { kind: 'unknown' },
      paidMinor: null,
      tenths: null,
      reached: false,
      gapMinor: 1n,
      pace,
      deadline: null,
    };
    expect(shortLine(payoff)).toBe('');
    expect(shortLine({ ...payoff, tenths: 500 })).toBe('50% paid off');
    expect(shortLine({ ...payoff, reached: true })).toBe('Paid off');
  });
});
