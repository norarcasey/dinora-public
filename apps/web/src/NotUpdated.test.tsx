import type { AccountRow, PullRow } from '@dinora/core/balances';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncedRows } from './queries/synced.ts';

const NOW = Date.parse('2026-09-24T12:00:00Z');

const state: {
  accounts: SyncedRows<AccountRow>;
  pulls: SyncedRows<PullRow>;
  online: boolean;
} = { accounts: { status: 'waiting' }, pulls: { status: 'waiting' }, online: true };

vi.mock('./queries/synced.ts', () => ({
  useSynced: (table: { name: string }) =>
    table.name === 'accounts' ? state.accounts : state.pulls,
  defineSynced: (spec: { name: string }) => ({ ...spec, queryKey: ['synced', spec.name] }),
}));
vi.mock('./device/useOnline.ts', () => ({ useOnline: () => state.online }));
vi.mock('./supabase/client.ts', () => ({
  auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
}));

const { NotUpdated } = await import('./NotUpdated.tsx');

const OLD = '2026-09-21T19:05:00+00:00';

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

function held<Row>(rows: Row[]): SyncedRows<Row> {
  return { status: 'held', rows, asOf: NOW, refreshing: false, stale: false };
}

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotUpdated />
    </QueryClientProvider>,
  );
}

/** Text as a person reads it: Intl's no-break spaces are spaces. */
function text(element: Element = document.body): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ');
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.accounts = held([]);
  state.pulls = held([pull('ok', '2026-09-24T11:00:00+00:00')]);
  state.online = true;
  window.location.hash = '';
});

describe('the mark in the header (BANK-18)', () => {
  it('is not there while every balance is fresh, or before the accounts are held', () => {
    state.accounts = held([account({ institution: 'PSCU', name: 'Member Savings' })]);
    show();
    expect(screen.queryByRole('button')).toBeNull();
    state.accounts = { status: 'waiting' };
    show();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('counts the banks that have missed a night, and says so for a screen reader', () => {
    state.accounts = held([
      account({ id: 'u1', institution: 'SUMMIT', name: 'SUMMIT Savings', balance_at: OLD }),
      account({ id: 'u2', institution: 'SUMMIT', name: 'Rewards Visa', balance_at: OLD }),
      account({ id: 'v', institution: 'Northwind', name: 'Retirement', balance_at: OLD }),
      account({ id: 'b', institution: 'PSCU', name: 'Member Savings' }),
    ]);
    show();
    const mark = screen.getByRole('button', { name: '2 banks not updated in over a day' });
    expect(mark.textContent).toBe('2');
    // Nothing of it on the page until it is opened.
    expect(text()).not.toContain('SUMMIT');
  });

  it('leaves a bank a warning names to the warning, so it is asked about in one place', () => {
    state.accounts = held([
      account({ id: 'v', institution: 'Northwind', name: 'Retirement Savings', balance_at: OLD }),
    ]);
    state.pulls = held([
      pull('ok', '2026-09-24T11:00:00+00:00', 'Northwind needs signing in again'),
    ]);
    show();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('the drawer', () => {
  beforeEach(() => {
    state.accounts = held([
      account({ id: 'u1', institution: 'SUMMIT', name: 'SUMMIT Savings', balance_at: OLD }),
      account({ id: 'u2', institution: 'SUMMIT', name: 'Rewards Visa', balance_at: OLD }),
      account({
        id: 'g',
        institution: 'Harbor Mortgage',
        name: 'Loan',
        balance_at: OLD,
        source: 'plaid',
      }),
    ]);
  });

  it('opens from the mark, names each bank under its source with its accounts, and offers a read per source', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /not updated/ }));
    const drawer = screen.getByRole('dialog', { name: 'Not updated' });
    expect(text(drawer)).toContain('SimpleFIN has not updated a bank in over a day.');
    expect(text(drawer)).toContain('SUMMIT, not updated since 2 days ago');
    expect(text(drawer)).toContain('Plaid has not updated a bank in over a day.');
    expect(screen.getByRole('link', { name: 'SUMMIT Savings' }).getAttribute('href')).toBe(
      '#/account/u1',
    );
    expect(screen.getByRole('link', { name: 'Rewards Visa' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Loan' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read SimpleFIN again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Read Plaid again' })).toBeTruthy();
  });

  it('closes on going anywhere, so an account link lands on its page', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: /not updated/ }));
    expect(screen.getByRole('dialog', { name: 'Not updated' })).toBeTruthy();
    act(() => {
      window.location.hash = '#/account/u1';
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(screen.queryByRole('dialog', { name: 'Not updated' })).toBeNull();
  });

  it('says a read needs a connection when offline', () => {
    state.online = false;
    show();
    fireEvent.click(screen.getByRole('button', { name: /not updated/ }));
    expect(text()).toContain('Reading again needs a connection.');
    expect(screen.queryByRole('button', { name: /Read .* again/ })).toBeNull();
  });
});
