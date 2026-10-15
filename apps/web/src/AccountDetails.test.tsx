import type { AccountRow } from '@dinora/core/balances';
import type { CategoryRow, TransactionRow } from '@dinora/core/budgets';
import type { Group, GroupRow } from '@dinora/core/groups';
import type { TermRow } from '@dinora/core/terms';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NewTerm } from './queries/terms.ts';
import type { SyncedRows } from './queries/synced.ts';

// Noon UTC, so her local day is 25 Sep wherever the tests run.
const NOW = Date.parse('2026-09-25T12:00:00Z');
const USER = '11111111-1111-1111-1111-111111111111';

const state: {
  accounts: SyncedRows<AccountRow>;
  groups: SyncedRows<GroupRow>;
  terms: SyncedRows<TermRow>;
  transactions: SyncedRows<TransactionRow>;
  categories: SyncedRows<CategoryRow>;
  online: boolean;
} = {
  accounts: { status: 'waiting' },
  groups: { status: 'waiting' },
  terms: { status: 'waiting' },
  transactions: { status: 'waiting' },
  categories: { status: 'waiting' },
  online: true,
};

const setAccountGroup = vi.fn<(user: string, account: string, group: Group) => Promise<void>>();
const addTerm = vi.fn<(user: string, account: string, term: NewTerm) => Promise<void>>();
const removeTerm = vi.fn<(id: string) => Promise<void>>();

vi.mock('./queries/synced.ts', () => ({
  useSynced: (table: { name: string }) => {
    switch (table.name) {
      case 'accounts':
        return state.accounts;
      case 'account_groups':
        return state.groups;
      case 'account_terms':
        return state.terms;
      case 'transactions':
        return state.transactions;
      case 'categories':
        return state.categories;
      default:
        return { status: 'waiting' };
    }
  },
  defineSynced: (spec: { name: string }) => ({ ...spec, queryKey: ['synced', spec.name] }),
}));
vi.mock('./queries/groups.ts', () => ({
  ACCOUNT_GROUPS: { name: 'account_groups', queryKey: ['synced', 'account_groups'] },
  setAccountGroup,
}));
vi.mock('./queries/terms.ts', () => ({
  ACCOUNT_TERMS: { name: 'account_terms', queryKey: ['synced', 'account_terms'] },
  addTerm,
  removeTerm,
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
  addRule: vi.fn(),
  chooseCategory: vi.fn(),
}));
vi.mock('./queries/goals.ts', () => ({
  GOALS: { name: 'goals', queryKey: ['synced', 'goals'] },
  GOAL_ACCOUNTS: { name: 'goal_accounts', queryKey: ['synced', 'goal_accounts'] },
  GOAL_PLANS: { name: 'goal_plans', queryKey: ['synced', 'goal_plans'] },
}));
vi.mock('./queries/assets.ts', () => ({
  ASSETS: { name: 'assets', queryKey: ['synced', 'assets'] },
  ASSET_VALUES: { name: 'asset_values', queryKey: ['synced', 'asset_values'] },
}));
vi.mock('./device/useOnline.ts', () => ({ useOnline: () => state.online }));
vi.mock('./supabase/client.ts', () => ({
  auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
}));

const { AccountDetails } = await import('./AccountDetails.tsx');

const CARD: AccountRow = {
  id: 'card',
  updated_at: '2026-09-25T09:00:00+00:00',
  deleted_at: null,
  institution: 'Bank of America',
  name: 'Customized Cash Rewards Visa Signature',
  currency: 'USD',
  balance_minor: -234_000,
  balance_at: '2026-09-25T09:00:00+00:00',
  holdings: 0,
  source: 'simplefin',
};

const CHECKING: AccountRow = {
  ...CARD,
  id: 'checking',
  institution: 'PSCU',
  name: 'Member Advantage Checking',
  balance_minor: 500_000,
};

const base = { updated_at: '2026-09-25T10:00:00+00:00', deleted_at: null, account_id: 'card' };

const TERMS: TermRow[] = [
  {
    ...base,
    id: 'limit',
    kind: 'credit_limit',
    effective_on: '2026-03-01',
    amount_minor: 1_000_000,
    rate_bp: null,
    ends_on: null,
  },
  {
    ...base,
    id: 'raise',
    kind: 'credit_limit',
    effective_on: '2026-11-01',
    amount_minor: 1_500_000,
    rate_bp: null,
    ends_on: null,
  },
  {
    ...base,
    id: 'cash',
    kind: 'cash_advance_limit',
    effective_on: '2026-03-01',
    amount_minor: 300_000,
    rate_bp: null,
    ends_on: null,
  },
  {
    ...base,
    id: 'apr',
    kind: 'purchase_apr',
    effective_on: '2026-03-01',
    amount_minor: null,
    rate_bp: 2499,
    ends_on: null,
  },
  {
    ...base,
    id: 'promo',
    kind: 'promo_apr',
    effective_on: '2026-03-01',
    amount_minor: null,
    rate_bp: 0,
    ends_on: '2026-10-15',
  },
];

function held<Row>(rows: Row[]): SyncedRows<Row> {
  return { status: 'held', rows, asOf: NOW, refreshing: false, stale: false };
}

function txn(
  id: string,
  accountId: string,
  on: string,
  minor: number,
  payee: string,
): TransactionRow {
  return {
    id,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    account_id: accountId,
    posted_at: `${on}T12:00:00+00:00`,
    transacted_at: null,
    amount_minor: minor,
    payee,
    description: '',
    source_category: null,
    pending: false,
  };
}

function show(accountId = 'card') {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const page = () => (
    <QueryClientProvider client={client}>
      <AccountDetails accountId={accountId} userId={USER} />
    </QueryClientProvider>
  );
  const { rerender } = render(page());
  return { invalidate, again: () => rerender(page()) };
}

/** Text as a person reads it: Intl's no-break spaces are spaces. */
function text(element: Element = document.body): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ');
}

function figure(name: string): string {
  const term = screen.getByText(name, { selector: 'dt' });
  return text(term.parentElement ?? term);
}

/** A sheet (UI-03), opened by the button on the page that opens it. */
function open(button: string, title: string) {
  fireEvent.click(screen.getByRole('button', { name: button }));
  return within(screen.getByRole('dialog', { name: title }));
}

const adding = () => open('Add a figure', 'Add a figure');
const entered = () => open('Remove one', 'Entered figures');

function fill(sheet: ReturnType<typeof within>, label: string, value: string) {
  fireEvent.change(sheet.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.accounts = held([CARD, CHECKING]);
  state.groups = held([]);
  state.terms = held([]);
  state.transactions = { status: 'waiting' };
  state.categories = { status: 'waiting' };
  state.online = true;
  setAccountGroup.mockReset();
  addTerm.mockReset();
  removeTerm.mockReset();
});

describe('the account', () => {
  it('shows its balance, its bank and a way back', () => {
    show();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(CARD.name);
    expect(text()).toContain('-$2,340.00');
    expect(text()).toContain('Bank of America');
    expect(screen.getByRole('link', { name: '← Overview' }).getAttribute('href')).toBe('#/');
  });

  it('says so when the account is not there', () => {
    show('nobody');
    expect(text()).toContain('This account is not in Dinora.');
  });

  it('keeps limits and rates to cards', () => {
    show('checking');
    expect(screen.queryByRole('heading', { name: 'Limits and rates' })).toBeNull();
    expect(text()).toContain("Set this account's group to Credit card");
  });

  it('offers to read its source again once its balance has missed a night', () => {
    state.accounts = held([{ ...CARD, balance_at: '2026-09-23T09:00:00+00:00' }]);
    show();
    expect(text()).toContain('Not updated since 2 days ago');
    expect(screen.getByRole('button', { name: 'Read SimpleFIN again' })).toBeTruthy();
  });

  it('offers no read while the balance is fresh, or for an account nothing reads', () => {
    show();
    expect(screen.queryByRole('button', { name: /Read .* again/ })).toBeNull();
    state.accounts = held([
      { ...CARD, source: 'monarch', balance_at: '2026-09-23T09:00:00+00:00' },
    ]);
    show();
    expect(screen.queryByRole('button', { name: /Read .* again/ })).toBeNull();
  });
});

describe('its transactions', () => {
  const hold = (rows: TransactionRow[]) => {
    state.transactions = held(rows);
    state.categories = held([]);
  };

  it('lists only this account’s, newest first, without naming the account on each', () => {
    hold([
      txn('old', 'card', '2026-08-03', -1599, 'Netflix'),
      txn('new', 'card', '2026-09-20', -4250, 'Whole Foods'),
      txn('elsewhere', 'checking', '2026-09-21', -50_000, 'Card Autopay'),
    ]);
    show();
    const section = screen.getByRole('region', { name: /^Transactions/ });
    expect(text(section)).toContain('2 in all');
    const rows = within(section)
      .getAllByRole('listitem')
      .map((li) => text(li));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Whole Foods');
    expect(rows[1]).toContain('Netflix');
    expect(text(section)).not.toContain('Card Autopay');
    expect(text(section)).not.toContain(CARD.name);
    // A payee opens its own page, as it does from Activity.
    expect(within(section).getByRole('link', { name: 'Whole Foods' })).toBeDefined();
  });

  it('says so when the account has none yet', () => {
    hold([txn('elsewhere', 'checking', '2026-09-21', -50_000, 'Card Autopay')]);
    show();
    expect(text()).toContain('No transaction in this account has been read yet.');
  });

  it('lists fifty at first, and the rest on asking', () => {
    hold(
      Array.from({ length: 60 }, (_, i) =>
        txn(`t${i}`, 'card', `2026-07-${String((i % 28) + 1).padStart(2, '0')}`, -100, `Shop ${i}`),
      ),
    );
    show();
    const section = screen.getByRole('region', { name: /^Transactions/ });
    expect(within(section).getAllByRole('listitem')).toHaveLength(50);
    fireEvent.click(within(section).getByRole('button', { name: 'Show all 60' }));
    expect(within(section).getAllByRole('listitem')).toHaveLength(60);
  });
});

describe('its group', () => {
  it('offers the guess as the empty choice, never as if she had made it', () => {
    show();
    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: `Group for ${CARD.name}`,
    });
    expect(select.value).toBe('');
    expect(text(select)).toContain('Guess: credit card');
  });

  it('shows the group she set', () => {
    state.groups = held([
      {
        id: 'g-checking',
        updated_at: '2026-09-25T10:00:00+00:00',
        deleted_at: null,
        account_id: 'checking',
        kind: 'cash',
      },
    ]);
    show('checking');
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: /^Group for/ });
    expect(select.value).toBe('cash');
  });

  it('saves her choice, confirming a guess included, and reads the groups again', async () => {
    setAccountGroup.mockResolvedValue(undefined);
    const { invalidate } = show();
    fireEvent.change(screen.getByRole('combobox', { name: `Group for ${CARD.name}` }), {
      target: { value: 'card' },
    });
    await waitFor(() => expect(setAccountGroup).toHaveBeenCalledWith(USER, 'card', 'card'));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['synced', 'account_groups'] }),
    );
    // A choice that saves as it is made says so (UI-02); it used to say nothing.
    expect((await screen.findByRole('status')).textContent).toBe('Saved');
  });

  it('says when a choice was not saved', async () => {
    setAccountGroup.mockRejectedValue(new Error('the group was not saved: 42501'));
    show();
    fireEvent.change(screen.getByRole('combobox', { name: `Group for ${CARD.name}` }), {
      target: { value: 'loan' },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Not saved');
  });

  it('switches off with no signal', () => {
    state.online = false;
    show();
    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: `Group for ${CARD.name}`,
    });
    expect(select.disabled).toBe(true);
  });
});

describe('limits and rates', () => {
  it('says each is not entered until it is', () => {
    show();
    expect(figure('Credit limit')).toContain('Not entered');
    expect(figure('Purchase APR')).toContain('Not entered');
    expect(screen.queryByRole('heading', { name: 'Entered' })).toBeNull();
  });

  it('shows what is in force, what the limit leaves, and a change still to come', () => {
    state.terms = held(TERMS);
    show();
    const limit = figure('Credit limit');
    expect(limit).toContain('$10,000.00');
    expect(limit).toContain('$7,660.00 available · 23.4% used');
    expect(limit).toContain('$15,000.00 from');
    // The cash line is the smaller of its own limit and what the card has left.
    expect(figure('Cash advance limit')).toContain('At most $3,000.00 available now');
    expect(figure('Purchase APR')).toContain('24.99%');
  });

  it('counts down a promo, in the warning colour in its last month', () => {
    state.terms = held(TERMS);
    show();
    expect(figure('Promo APR')).toContain('0%');
    const left = screen.getByText(/20 days left/);
    expect(left.className).toContain('error');
  });

  it('lists every figure entered, newest first', () => {
    state.terms = held(TERMS);
    show();
    const rows = screen.getAllByRole('listitem').map((li) => text(li));
    expect(rows[0]).toContain('Credit limit $15,000.00');
    expect(rows).toHaveLength(5);
    // To read: taking one back is in the sheet.
    expect(screen.queryByRole('button', { name: /^Remove Purchase APR/ })).toBeNull();
  });
});

describe('adding a figure', () => {
  it('saves a limit as she typed it, dated today, and reads the terms again', async () => {
    addTerm.mockResolvedValue(undefined);
    const { invalidate } = show();
    const sheet = adding();
    fill(sheet, 'Credit limit', '$12,500');
    fireEvent.click(sheet.getByRole('button', { name: 'Add credit limit' }));
    await waitFor(() =>
      expect(addTerm).toHaveBeenCalledWith(USER, 'card', {
        kind: 'credit_limit',
        effectiveOn: '2026-09-25',
        amountMinor: 1_250_000,
      }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['synced', 'account_terms'] }),
    );
    // Saved, the sheet closes over the page that shows it.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on Cancel, adding nothing', () => {
    show();
    const sheet = adding();
    fill(sheet, 'Credit limit', '5000');
    fireEvent.click(sheet.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(addTerm).not.toHaveBeenCalled();
  });

  it('shows the unit inside the field, not in its name', () => {
    show();
    const sheet = adding();
    const limit = sheet.getByLabelText('Credit limit');
    expect(
      text(document.getElementById(limit.getAttribute('aria-describedby') ?? '') ?? document.body),
    ).toBe('$');
    fireEvent.click(sheet.getByRole('radio', { name: 'APR' }));
    const rate = sheet.getByLabelText('Purchase APR');
    expect(
      text(document.getElementById(rate.getAttribute('aria-describedby') ?? '') ?? document.body),
    ).toBe('%');
  });

  it('saves a rate in hundredths of a percent', async () => {
    addTerm.mockResolvedValue(undefined);
    show();
    const sheet = adding();
    fireEvent.click(sheet.getByRole('radio', { name: 'APR' }));
    fill(sheet, 'Purchase APR', '27.24%');
    fill(sheet, 'Takes effect', '2026-09-01');
    fireEvent.click(sheet.getByRole('button', { name: 'Add purchase APR' }));
    await waitFor(() =>
      expect(addTerm).toHaveBeenCalledWith(USER, 'card', {
        kind: 'purchase_apr',
        effectiveOn: '2026-09-01',
        rateBp: 2724,
      }),
    );
  });

  it('asks for a promo’s end, after its start, on the field itself', async () => {
    addTerm.mockResolvedValue(undefined);
    show();
    const sheet = adding();
    fireEvent.click(sheet.getByRole('radio', { name: 'Promo' }));
    fill(sheet, 'Promo APR', '0');
    fireEvent.click(sheet.getByRole('button', { name: 'Add promo APR' }));
    expect(sheet.getByRole('alert').textContent).toContain('the day the promo ends');
    const ends = sheet.getByLabelText('Ends');
    expect(ends.getAttribute('aria-invalid')).toBe('true');
    expect(ends.getAttribute('aria-describedby')).toBe(sheet.getByRole('alert').id);

    fill(sheet, 'Ends', '2027-04-01');
    // Answering the problem takes it away.
    expect(sheet.queryByRole('alert')).toBeNull();
    fireEvent.click(sheet.getByRole('button', { name: 'Add promo APR' }));
    await waitFor(() =>
      expect(addTerm).toHaveBeenCalledWith(USER, 'card', {
        kind: 'promo_apr',
        effectiveOn: '2026-09-25',
        rateBp: 0,
        endsOn: '2027-04-01',
      }),
    );
  });

  it('says what is wrong with a figure it cannot read, and saves nothing', () => {
    show();
    const sheet = adding();
    fill(sheet, 'Credit limit', 'twelve grand');
    fireEvent.click(sheet.getByRole('button', { name: 'Add credit limit' }));
    expect(sheet.getByRole('alert').textContent).toContain('like 12,500');
    expect(sheet.getByLabelText('Credit limit').getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(sheet.getByRole('radio', { name: 'APR' }));
    fill(sheet, 'Purchase APR', '24.999');
    fireEvent.click(sheet.getByRole('button', { name: 'Add purchase APR' }));
    expect(sheet.getByRole('alert').textContent).toContain('like 24.99');
    expect(addTerm).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Add a figure' })).toBeDefined();
  });

  it('says when it was not saved, under the button rather than on a field', async () => {
    addTerm.mockRejectedValue(new Error('the figure was not saved: 42501'));
    show();
    const sheet = adding();
    fill(sheet, 'Credit limit', '5000');
    fireEvent.click(sheet.getByRole('button', { name: 'Add credit limit' }));
    await waitFor(() => expect(sheet.getByRole('alert').textContent).toContain('Not saved.'));
    expect(sheet.getByRole('alert').className).toContain('form-error');
    expect(sheet.getByLabelText('Credit limit').getAttribute('aria-invalid')).toBeNull();
  });

  it('switches off with no signal, and still shows what was entered', () => {
    state.online = false;
    state.terms = held(TERMS);
    show();
    expect(screen.getByRole('button', { name: 'Add a figure' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Remove one' })).toHaveProperty('disabled', true);
    expect(text()).toContain('Figures can be added when this device is back online.');
    expect(figure('Purchase APR')).toContain('24.99%');
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('switches off a sheet already open when the signal goes', () => {
    const { again } = show();
    const sheet = adding();
    state.online = false;
    again();
    expect(sheet.getByRole('button', { name: 'Add credit limit' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(sheet.getByLabelText('Credit limit')).toHaveProperty('disabled', true);
  });
});

describe('removing a figure', () => {
  it('asks once more, then removes it and reads the terms again', async () => {
    removeTerm.mockResolvedValue(undefined);
    state.terms = held(TERMS);
    const { invalidate } = show();
    const sheet = entered();
    fireEvent.click(sheet.getByRole('button', { name: 'Remove Purchase APR 24.99%' }));
    expect(removeTerm).not.toHaveBeenCalled();
    fireEvent.click(sheet.getByRole('button', { name: 'Yes, remove Purchase APR 24.99%' }));
    await waitFor(() => expect(removeTerm).toHaveBeenCalledWith('apr'));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['synced', 'account_terms'] }),
    );
  });

  it('keeps it when she changes her mind', () => {
    state.terms = held(TERMS);
    show();
    const sheet = entered();
    fireEvent.click(sheet.getByRole('button', { name: 'Remove Purchase APR 24.99%' }));
    fireEvent.click(sheet.getByRole('button', { name: 'Keep' }));
    expect(sheet.getByRole('button', { name: 'Remove Purchase APR 24.99%' })).toBeTruthy();
    expect(removeTerm).not.toHaveBeenCalled();
  });

  it('says when it was not removed', async () => {
    removeTerm.mockRejectedValue(new Error('the figure was not removed: 42501'));
    state.terms = held(TERMS);
    show();
    const sheet = entered();
    fireEvent.click(sheet.getByRole('button', { name: 'Remove Purchase APR 24.99%' }));
    fireEvent.click(sheet.getByRole('button', { name: 'Yes, remove Purchase APR 24.99%' }));
    await waitFor(() => expect(sheet.getByRole('alert').textContent).toContain('Not removed.'));
  });
});
