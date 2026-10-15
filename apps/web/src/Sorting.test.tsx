import type { AccountRow } from '@dinora/core/balances';
import type { CategoryRow, ChoiceRow, Month, RuleRow, TransactionRow } from '@dinora/core/budgets';
import { entriesIn, makeFiler, summarise } from '@dinora/core/budgets';
import { pairTransfers } from '@dinora/core/transfers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BudgetMonth } from './Budget.tsx';
import { WriteError } from './queries/writes.ts';

/*
 * The filing pieces on their own, over a month built as the budget page builds one. The pages'
 * tests (Budget, Activity) drive the common path through them; these are the turns those never
 * take: a rule that fails to save, a pick that needs no rule question, a card gone back to, and
 * the queue ending on one already filed. Measured 14 Oct 2026 against the web project's
 * coverage of this file: those were the lines nothing reached.
 */

const USER = '11111111-1111-1111-1111-111111111111';
const AT = '2026-09-25T09:00:00+00:00';
const TODAY = '2026-09-25';
const SEPTEMBER: Month = '2026-09';

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

vi.mock('./queries/budgets.ts', () => ({
  TRANSACTION_CATEGORIES: {
    name: 'transaction_categories',
    queryKey: ['synced', 'transaction_categories'],
  },
  CATEGORY_RULES: { name: 'category_rules', queryKey: ['synced', 'category_rules'] },
  chooseCategory,
  addRule,
}));

const { CategorizeQueue, FilingRow, accountMeta, usePicker } = await import('./Sorting.tsx');

function account(id: string, name: string): AccountRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    institution: 'Bank of America',
    name,
    currency: 'USD',
    balance_minor: 0,
    balance_at: AT,
    holdings: 0,
    source: 'simplefin',
  };
}

function category(id: string, name: string): CategoryRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    name,
    kind: 'spend',
    guesses_from: [],
    created_at: AT,
  };
}

function txn(id: string, on: string, overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    account_id: 'card',
    posted_at: `${on}T12:00:00+00:00`,
    transacted_at: null,
    amount_minor: -1_000,
    payee: 'Corner Cafe',
    description: '',
    source_category: null,
    pending: false,
    ...overrides,
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

function rule(payee: string, categoryId: string, startsOn: string): RuleRow {
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

const eating = category('eat', 'Eating out');
const food = category('food', 'Groceries');

/** September as `useBudgetMonth` reads it, from rows rather than from the synced tables. */
function monthOf(
  transactions: readonly TransactionRow[],
  {
    choices = [],
    rules = [],
    accounts = [account('card', 'Visa Signature')],
  }: {
    readonly choices?: readonly ChoiceRow[];
    readonly rules?: readonly RuleRow[];
    readonly accounts?: readonly AccountRow[];
  } = {},
): BudgetMonth {
  const categories = [eating, food];
  const currencies = new Map(accounts.map((a) => [a.id, a.currency]));
  const pairs = pairTransfers(transactions, currencies, TODAY);
  const file = makeFiler(categories, choices, rules, TODAY, pairs);
  const entries = entriesIn(SEPTEMBER, transactions, currencies, file, TODAY);
  return {
    month: SEPTEMBER,
    summary: summarise(SEPTEMBER, entries, categories, [], [], TODAY),
    entries,
    categories,
    budgets: [],
    choices,
    rules,
    transactions,
    accounts: new Map(accounts.map((a) => [a.id, a])),
    file,
    pairs,
    history: {
      transactions,
      counted: currencies,
      file,
      categories,
      budgets: [],
      rates: [],
      today: TODAY,
    },
  };
}

function show(ui: () => ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => <QueryClientProvider client={client}>{ui()}</QueryClientProvider>;
  const { rerender } = render(tree());
  return { again: () => rerender(tree()) };
}

function text(element: Element = document.body): string {
  return element.textContent ?? '';
}

/** A month's list as a page shows one: a row per transaction, and the page's one picker. */
function List({ data }: { readonly data: BudgetMonth }) {
  const { open, sheet } = usePicker(data);
  return (
    <>
      <ul>
        {data.entries.map((entry) => (
          <FilingRow
            key={entry.transaction.id}
            entry={entry}
            meta={accountMeta(data.accounts.get(entry.transaction.account_id), entry.transaction)}
            data={data}
            current={SEPTEMBER}
            userId={USER}
            online
            onOpen={open}
          />
        ))}
      </ul>
      {sheet}
    </>
  );
}

function pick(payee: string, name: string) {
  fireEvent.click(
    screen.getByRole('button', { name: (label) => label.startsWith(`Category for ${payee}:`) }),
  );
  fireEvent.click(
    within(screen.getByRole('dialog', { name: `Category for ${payee}` })).getByRole('button', {
      name,
    }),
  );
}

beforeEach(() => {
  chooseCategory.mockReset();
  addRule.mockReset();
  chooseCategory.mockResolvedValue();
  addRule.mockResolvedValue();
});

describe('a transaction in a list', () => {
  it('keeps the rule question when the rule was not saved, and says why', async () => {
    addRule.mockRejectedValueOnce(new WriteError('the rule was not saved', '42501'));
    show(() => <List data={monthOf([txn('cafe', '2026-09-17')])} />);
    pick('Corner Cafe', 'Eating out');
    await waitFor(() =>
      expect(chooseCategory).toHaveBeenCalledWith(USER, 'cafe', 'eat', expect.anything()),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Make it a rule' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Not saved: Dinora refused it (code 42501).',
    );
    // Asked again, so a refusal costs one tap and not the whole choice over.
    fireEvent.click(screen.getByRole('button', { name: 'Make it a rule' }));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Every “Corner Cafe” from September 2026 on is filed by the rule.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(addRule).toHaveBeenLastCalledWith(USER, 'corner cafe', 'eat', SEPTEMBER);
  });

  it('asks nothing when the payee’s rule already files it there', async () => {
    const data = monthOf([txn('cafe', '2026-09-17')], {
      choices: [choiceOf('cafe', 'food')],
      rules: [rule('corner cafe', 'eat', '2026-01-01')],
    });
    show(() => <List data={data} />);
    pick('Corner Cafe', 'Eating out');
    await waitFor(() =>
      expect(chooseCategory).toHaveBeenCalledWith(USER, 'cafe', 'eat', expect.anything()),
    );
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', {
          name: (label) => label.startsWith('Category for Corner Cafe:'),
        }).disabled,
      ).toBe(false),
    );
    expect(screen.queryByRole('button', { name: 'Make it a rule' })).toBeNull();
  });

  it('says beneath a payee which account, unnamed or not, and whether it is pending', () => {
    show(() => (
      <List
        data={monthOf(
          [
            txn('cafe', '2026-09-17'),
            txn('kiosk', '2026-09-18', { account_id: 'cash', payee: null, pending: true }),
          ],
          { accounts: [account('card', 'Visa Signature'), account('cash', '')] },
        )}
      />
    ));
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => text(row.querySelector('.account') ?? row))).toEqual([
      'No payeeUnnamed account · pending',
      'Corner CafeVisa Signature',
    ]);
    // A payee with no name has no page of its own to link to.
    expect(screen.queryByRole('link', { name: 'No payee' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Corner Cafe' }).getAttribute('href')).toBe(
      '#/payee/corner%20cafe',
    );
  });
});

describe('the Categorize queue', () => {
  const queue = (data: () => BudgetMonth, recent: readonly CategoryRow[] = [eating]) => {
    const onDone = vi.fn<() => void>();
    const view = show(() => (
      <CategorizeQueue
        data={data()}
        recent={recent}
        current={SEPTEMBER}
        userId={USER}
        online
        onDone={onDone}
      />
    ));
    return { ...view, onDone };
  };

  it('files a pick with no rule to offer and moves straight on', async () => {
    let choices: ChoiceRow[] = [];
    const rows = [
      txn('kiosk', '2026-09-18', { payee: null, description: '  ' }),
      txn('cafe', '2026-09-17'),
    ];
    const view = queue(() => monthOf(rows, { choices }));
    const card = screen.getByRole('article', { name: 'No payee' });
    expect(within(card).queryByRole('link')).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: 'Eating out' }));
    // A payee with no name cannot have a rule, so there is no question to wait on.
    await waitFor(() =>
      expect(chooseCategory).toHaveBeenCalledWith(USER, 'kiosk', 'eat', expect.anything()),
    );
    choices = [choiceOf('kiosk', 'eat')];
    view.again();
    expect(text(await screen.findByRole('article', { name: 'Corner Cafe' }))).toContain('2 of 2');
    expect(screen.getByRole('status').textContent).toBe('No payee is filed under Eating out.');
    expect(screen.queryByRole('button', { name: 'Make it a rule' })).toBeNull();
  });

  it('stays on the card and says why when a pick was not saved', async () => {
    chooseCategory.mockRejectedValueOnce(new WriteError('the category was not saved', '23514'));
    queue(() => monthOf([txn('cafe', '2026-09-17')]));
    fireEvent.click(screen.getByRole('button', { name: 'Eating out' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Not saved: Dinora refused it (code 23514).',
    );
    expect(text(screen.getByRole('article', { name: 'Corner Cafe' }))).toContain('1 of 1');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers the whole list when she has no recent choices', () => {
    queue(
      () =>
        monthOf([txn('cafe', '2026-09-17', { account_id: 'cash', pending: true })], {
          accounts: [account('cash', '')],
        }),
      [],
    );
    const card = screen.getByRole('article', { name: 'Corner Cafe' });
    expect(text(card)).toContain('Unnamed account · pending');
    expect(
      within(card)
        .getAllByRole('button', { name: /category/ })
        .map((b) => b.textContent),
    ).toEqual(['Choose a category…']);
  });

  it('shows one gone back to as filed, and ends from it once the rest were filed elsewhere', async () => {
    let choices: ChoiceRow[] = [];
    const rows = [txn('cafe', '2026-09-17'), txn('wf', '2026-09-16', { payee: 'Whole Foods' })];
    const view = queue(() => monthOf(rows, { choices }));

    fireEvent.click(screen.getByRole('button', { name: 'Eating out' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Just this one' }));
    choices = [choiceOf('cafe', 'eat')];
    view.again();
    expect(screen.getByRole('article', { name: 'Whole Foods' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    const card = screen.getByRole('article', { name: 'Corner Cafe' });
    expect(text(card)).toContain('Eating out, yours.');
    expect(
      within(card).getByRole('button', { name: 'Eating out' }).getAttribute('aria-pressed'),
    ).toBe('true');

    // Whole Foods filed on another device while she looked back: nothing is left after this one.
    choices = [choiceOf('cafe', 'eat'), choiceOf('wf', 'food')];
    view.again();
    fireEvent.click(within(card).getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Nothing is left to categorize in September 2026.')).toBeDefined();
  });
});
