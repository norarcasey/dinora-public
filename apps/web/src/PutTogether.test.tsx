import type { AccountRow } from '@dinora/core/balances';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./supabase/client.ts', () => ({
  auth: {
    getSession: () => Promise.resolve({ data: { session: { access_token: 'user-jwt' } } }),
  },
}));
vi.mock('./queries/balances.ts', () => ({ ACCOUNTS: { queryKey: ['synced', 'accounts'] } }));
vi.mock('./queries/budgets.ts', () => ({ TRANSACTIONS: { queryKey: ['synced', 'transactions'] } }));
vi.mock('./queries/history.ts', () => ({
  BALANCE_SNAPSHOTS: { queryKey: ['synced', 'balance_snapshots'] },
}));

const { PutTogether } = await import('./PutTogether.tsx');

function account(over: Partial<AccountRow>): AccountRow {
  return {
    id: 'x',
    updated_at: '2026-09-26T00:00:00+00:00',
    deleted_at: null,
    source: 'simplefin',
    institution: 'Vanguard',
    name: 'MERIDIAN 401(K) - 550717',
    currency: 'USD',
    balance_minor: 0,
    balance_at: '2026-09-26T00:00:00+00:00',
    holdings: 0,
    ...over,
  };
}

const PAIR = {
  monarch: account({
    id: 'm',
    source: 'monarch',
    institution: 'Monarch',
    name: 'MERIDIAN (...0717)',
  }),
  bank: account({ id: 'b' }),
};

/** The function, answering as told, and what the page sent it. */
function server(answer: () => Response) {
  const asked: { body: unknown; authorization: string | null }[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBe('/api/monarch/join');
    asked.push({
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return Promise.resolve(answer());
  });
  return asked;
}

function show(goals: readonly string[] = [], online = true) {
  const client = new QueryClient();
  const invalidated = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <PutTogether pair={PAIR} goals={goals} online={online} />
    </QueryClientProvider>,
  );
  return invalidated;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PutTogether (BANK-17)', () => {
  it('says what will happen, naming both, before anything is sent', () => {
    const asked = server(() => new Response('{}', { status: 599 }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Put these together' }));
    expect(
      screen.getByText(/Monarch’s history of MERIDIAN \(\.\.\.0717\) moves onto MERIDIAN/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep both' }));
    expect(screen.getByRole('button', { name: 'Put these together' })).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it('warns of a goal that counts the Monarch copy', () => {
    server(() => new Response('{}', { status: 599 }));
    show(['Retirement']);
    fireEvent.click(screen.getByRole('button', { name: 'Put these together' }));
    expect(screen.getByText(/Retirement counts the Monarch copy: add MERIDIAN/)).toBeTruthy();
  });

  it('asks as her session with the two ids, then reads the moved rows again', async () => {
    const asked = server(() =>
      Response.json({
        kind: 'joined',
        days_moved: 815,
        days_left: 1,
        transactions_moved: 40,
        transactions_left: 0,
      }),
    );
    const invalidated = show();
    fireEvent.click(screen.getByRole('button', { name: 'Put these together' }));
    fireEvent.click(screen.getByRole('button', { name: /^Yes, put/ }));
    await waitFor(() => expect(invalidated).toHaveBeenCalledTimes(3));
    expect(asked).toEqual([
      { body: { monarch: 'm', bank: 'b' }, authorization: 'Bearer user-jwt' },
    ]);
    expect(invalidated.mock.calls.map(([f]) => f?.queryKey)).toEqual([
      ['synced', 'accounts'],
      ['synced', 'balance_snapshots'],
      ['synced', 'transactions'],
    ]);
  });

  it('says why, when refused, and reads nothing again', async () => {
    server(() =>
      Response.json(
        { kind: 'refused', reason: 'these two are already put together' },
        { status: 409 },
      ),
    );
    const invalidated = show();
    fireEvent.click(screen.getByRole('button', { name: 'Put these together' }));
    fireEvent.click(screen.getByRole('button', { name: /^Yes, put/ }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Not put together: these two are already put together.',
    );
    expect(invalidated).not.toHaveBeenCalled();
  });

  it('is off with no connection', () => {
    show([], false);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Putting them together needs a connection.')).toBeTruthy();
  });
});
