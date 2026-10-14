import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session: { token: string | null } = { token: 'user-jwt' };

vi.mock('./supabase/client.ts', () => ({
  auth: {
    getSession: () =>
      Promise.resolve({
        data: { session: session.token === null ? null : { access_token: session.token } },
      }),
  },
}));
vi.mock('./queries/balances.ts', () => ({
  ACCOUNTS: { queryKey: ['synced', 'accounts'] },
  BANK_PULLS: { queryKey: ['synced', 'bank_pulls'] },
}));

const { ReadAgain } = await import('./ReadAgain.tsx');

type Asked = { readonly body: unknown; readonly authorization: string | null };

/** The function, answering as told, and what the page asked it. */
function server(answer: () => Response) {
  const asked: Asked[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBe('/api/bank/read');
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    asked.push({ body, authorization: new Headers(init?.headers).get('authorization') });
    return Promise.resolve(answer());
  });
  return asked;
}

function show(source: 'simplefin' | 'plaid' = 'simplefin', online = true, still = 'them') {
  const client = new QueryClient();
  const invalidated = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <ReadAgain source={source} still={still} online={online} />
    </QueryClientProvider>,
  );
  return invalidated;
}

beforeEach(() => {
  session.token = 'user-jwt';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReadAgain', () => {
  it('asks the server for the source as her session, then refreshes the reads and the balances', async () => {
    const asked = server(() => Response.json({ kind: 'read' }));
    const invalidated = show();
    fireEvent.click(screen.getByRole('button', { name: 'Read SimpleFIN again' }));
    expect(screen.getByRole('status').textContent).toBe('Reading SimpleFIN again…');
    await screen.findByRole('button', { name: 'Read SimpleFIN again' });
    expect(asked).toEqual([{ body: { source: 'simplefin' }, authorization: 'Bearer user-jwt' }]);
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['synced', 'bank_pulls'] });
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['synced', 'accounts'] });
  });

  it('says, while it is still shown after a read, that the read changed nothing and where to look', async () => {
    server(() => Response.json({ kind: 'read' }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Read SimpleFIN again' }));
    await screen.findByText(/was read just now/);
    expect(screen.getByText(/was read just now/).textContent).toBe(
      'SimpleFIN was read just now and still has them as they were. SimpleFIN asks each bank on its own, about once a day. If this keeps up, check the connection at SimpleFIN.',
    );
    const bridge = screen.getByRole('link', { name: 'SimpleFIN' });
    expect(bridge.getAttribute('href')).toBe('https://beta-bridge.simplefin.org/');
    expect(bridge.getAttribute('target')).toBe('_blank');
    expect(bridge.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('reads Plaid by name, and points at its sign-in rather than the Bridge', async () => {
    const asked = server(() => Response.json({ kind: 'read' }));
    show('plaid', true, 'it');
    fireEvent.click(screen.getByRole('button', { name: 'Read Plaid again' }));
    await screen.findByText(/was read just now/);
    expect(screen.getByText(/was read just now/).textContent).toBe(
      'Plaid was read just now and still has it as it was. Plaid asks the bank on its own. If it needs signing in again, Plaid will say so here.',
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(asked[0]?.body).toEqual({ source: 'plaid' });
  });

  it("says why the read failed, in the night's words", async () => {
    server(() =>
      Response.json({ kind: 'failed', reason: 'the Bridge answered HTTP 500: "Server Error"' }),
    );
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Read SimpleFIN again' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The SimpleFIN read failed: the Bridge answered HTTP 500: "Server Error".',
    );
  });

  it('says why the server refused, and names a non-answer by its status', async () => {
    server(() => Response.json({ kind: 'refused', reason: 'not signed in' }, { status: 401 }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Read SimpleFIN again' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Not read: not signed in.');
    vi.unstubAllGlobals();
    server(() => new Response('<html>', { status: 504 }));
    fireEvent.click(screen.getByRole('button', { name: 'Read SimpleFIN again' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Not read: it answered HTTP 504.'),
    );
  });

  it('asks nothing without a session, and says when Dinora cannot be reached', async () => {
    session.token = null;
    const asked = server(() => Response.json({ kind: 'read' }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Read SimpleFIN again' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Not read: not signed in.');
    expect(asked).toHaveLength(0);
    session.token = 'user-jwt';
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Load failed')));
    fireEvent.click(screen.getByRole('button', { name: 'Read SimpleFIN again' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Not read: Dinora could not be reached.'),
    );
  });

  it('offers nothing offline', () => {
    show('simplefin', false);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Reading again needs a connection.')).toBeTruthy();
  });
});
