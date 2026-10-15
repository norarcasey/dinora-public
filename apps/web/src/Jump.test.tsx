import type { AccountRow } from '@dinora/core/balances';
import type { TransactionRow } from '@dinora/core/budgets';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncedRows } from './queries/synced.ts';

// Noon UTC, so her local day is 25 Sep wherever the tests run.
const NOW = Date.parse('2026-09-25T12:00:00Z');
const AT = '2026-09-25T09:00:00+00:00';

const state: {
  accounts: SyncedRows<AccountRow>;
  transactions: SyncedRows<TransactionRow>;
} = { accounts: { status: 'waiting' }, transactions: { status: 'waiting' } };

vi.mock('./queries/synced.ts', () => ({
  useSynced: (table: { name: string }) => {
    switch (table.name) {
      case 'accounts':
        return state.accounts;
      case 'transactions':
        return state.transactions;
      default:
        return { status: 'waiting' };
    }
  },
  defineSynced: (spec: { name: string }) => ({ ...spec, queryKey: ['synced', spec.name] }),
}));
vi.mock('./queries/balances.ts', () => ({ ACCOUNTS: { name: 'accounts' } }));
vi.mock('./queries/budgets.ts', () => ({ TRANSACTIONS: { name: 'transactions' } }));
vi.mock('./queries/goals.ts', () => ({ GOALS: { name: 'goals' } }));
vi.mock('./queries/assets.ts', () => ({ ASSETS: { name: 'assets' } }));

const { JumpTo } = await import('./Jump.tsx');

function held<Row>(rows: Row[]): SyncedRows<Row> {
  return { status: 'held', rows, asOf: NOW, refreshing: false, stale: false };
}

function account(id: string, name: string): AccountRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    institution: 'Chase',
    name,
    currency: 'USD',
    balance_minor: 0,
    balance_at: AT,
    holdings: 0,
    source: 'simplefin',
  };
}

function txn(id: string, on: string, payee: string): TransactionRow {
  return {
    id,
    updated_at: AT,
    deleted_at: null,
    account_id: 'visa',
    posted_at: `${on}T12:00:00+00:00`,
    transacted_at: null,
    amount_minor: -1000,
    payee,
    description: '',
    source_category: null,
    pending: false,
  };
}

function press(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(window, { key, ...init });
}

function box(): HTMLInputElement {
  const input = screen.getByRole('combobox', { name: 'Jump to' });
  if (!(input instanceof HTMLInputElement)) throw new Error('not an input');
  return input;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  window.location.hash = '';
  state.accounts = held([account('visa', 'Visa Signature')]);
  state.transactions = held([
    txn('t1', '2026-08-03', 'Netflix'),
    txn('t2', '2026-09-03', 'Netflix'),
    txn('t3', '2026-09-10', 'Advisor Fee'),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('⌘K', () => {
  it('opens on ⌘K and on Ctrl+K, and closes on it again', () => {
    render(<JumpTo />);
    expect(screen.queryByRole('combobox')).toBeNull();
    press('k', { metaKey: true });
    expect(box()).toBeTruthy();
    press('k', { metaKey: true });
    expect(screen.queryByRole('combobox')).toBeNull();
    press('K', { ctrlKey: true });
    expect(box()).toBeTruthy();
  });

  it('leaves K alone, and ⌘ with another key', () => {
    render(<JumpTo />);
    press('k');
    press('k', { metaKey: true, shiftKey: true });
    press('j', { metaKey: true });
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('opens from its button too, with the box ready to type in', () => {
    render(<JumpTo />);
    fireEvent.click(screen.getByRole('button', { name: /Jump to/ }));
    expect(document.activeElement).toBe(box());
  });

  it('does not open over another sheet', () => {
    render(
      <>
        <dialog open>A half-made change</dialog>
        <JumpTo />
      </>,
    );
    press('k', { metaKey: true });
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('lists places by name, and always a search of the transactions last', () => {
    render(<JumpTo />);
    press('k', { metaKey: true });
    fireEvent.change(box(), { target: { value: 'vis' } });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Visa SignatureChase',
      'Advisor FeePayee, once',
      'Search transactions for “vis”Activity',
    ]);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('goes to the chosen one on Return, moved with the arrows, and closes', () => {
    render(<JumpTo />);
    press('k', { metaKey: true });
    fireEvent.change(box(), { target: { value: 'vis' } });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(window.location.hash).toBe('#/payee/advisor%20fee');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('wraps from the first to the last going up', () => {
    render(<JumpTo />);
    press('k', { metaKey: true });
    fireEvent.change(box(), { target: { value: 'netflix' } });
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(window.location.hash).toBe('#/activity?q=netflix');
  });

  it('goes to a month’s budget, and to one clicked', () => {
    render(<JumpTo />);
    press('k', { metaKey: true });
    fireEvent.change(box(), { target: { value: 'aug' } });
    fireEvent.click(screen.getByRole('option', { name: /August 2026/ }));
    expect(window.location.hash).toBe('#/budget/2026-08');
  });

  it('says how to use it until something is typed, and finds with nothing on the device', () => {
    state.accounts = { status: 'waiting' };
    state.transactions = { status: 'failed' };
    render(<JumpTo />);
    press('k', { metaKey: true });
    expect(screen.getByText(/Return to go/)).toBeTruthy();
    expect(screen.queryAllByRole('option')).toEqual([]);
    fireEvent.change(box(), { target: { value: 'sep' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'September 2026Budget',
      'Search transactions for “sep”Activity',
    ]);
  });

  it('closes when the page moves, by the back gesture or anything else', () => {
    render(<JumpTo />);
    press('k', { metaKey: true });
    window.location.hash = '#/budget';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
