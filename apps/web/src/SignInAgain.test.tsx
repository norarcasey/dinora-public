import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOSTED = 'https://secure.plaid.com/hl/abc';

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

const { SignInAgain } = await import('./SignInAgain.tsx');

type Asked = { readonly step: unknown; readonly authorization: string | null };

/** The function, answering each step as told, and what the page asked it. */
function server(answers: Record<string, () => Response>) {
  const asked: Asked[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    expect(input).toBe('/api/plaid/relink');
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const step = typeof body === 'object' && body !== null && 'step' in body ? body.step : null;
    asked.push({ step, authorization: new Headers(init?.headers).get('authorization') });
    const answer = typeof step === 'string' ? answers[step] : undefined;
    return Promise.resolve(answer?.() ?? new Response('{}', { status: 599 }));
  });
  return asked;
}

function show(online = true) {
  const client = new QueryClient();
  const invalidated = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <SignInAgain online={online} />
    </QueryClientProvider>,
  );
  return invalidated;
}

function visible(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  session.token = 'user-jwt';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SignInAgain', () => {
  it("asks the server as her session, then offers Plaid's page as a link she taps", async () => {
    const asked = server({
      start: () => Response.json({ kind: 'open', bank: 'Harbor Mortgage', url: HOSTED }),
    });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    const link = await screen.findByRole('link', { name: 'Sign in to Harbor Mortgage with Plaid' });
    expect(link.getAttribute('href')).toBe(HOSTED);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(asked).toEqual([{ step: 'start', authorization: 'Bearer user-jwt' }]);
  });

  it('reads Plaid again on coming back from its page, and refreshes the reads', async () => {
    const asked = server({
      start: () => Response.json({ kind: 'open', bank: 'Harbor Mortgage', url: HOSTED }),
      read: () => Response.json({ kind: 'read' }),
    });
    const invalidated = show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    const link = await screen.findByRole('link');
    // Seen again before going to Plaid is not coming back from it.
    act(() => visible('visible'));
    expect(asked).toHaveLength(1);

    fireEvent.click(link);
    act(() => visible('hidden'));
    act(() => visible('visible'));
    await screen.findByRole('button', { name: 'Sign in again' });
    expect(asked.map((a) => a.step)).toEqual(['start', 'read']);
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['synced', 'bank_pulls'] });
    expect(invalidated).toHaveBeenCalledWith({ queryKey: ['synced', 'accounts'] });
  });

  it('offers to read again by hand once she has gone to Plaid', async () => {
    const asked = server({
      start: () => Response.json({ kind: 'open', bank: 'Harbor Mortgage', url: HOSTED }),
      read: () => Response.json({ kind: 'read' }),
    });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(screen.queryByRole('button', { name: 'Read Harbor Mortgage again' })).toBeNull();
    fireEvent.click(await screen.findByRole('link'));
    fireEvent.click(screen.getByRole('button', { name: 'Read Harbor Mortgage again' }));
    await screen.findByRole('button', { name: 'Sign in again' });
    expect(asked.map((a) => a.step)).toEqual(['start', 'read']);
  });

  it('reads straight away when Plaid says no bank wants signing in', async () => {
    const asked = server({
      start: () => Response.json({ kind: 'none' }),
      read: () => Response.json({ kind: 'read' }),
    });
    const invalidated = show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    await vi.waitFor(() => expect(asked.map((a) => a.step)).toEqual(['start', 'read']));
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalled());
  });

  it('says so when Plaid still refuses', async () => {
    server({
      start: () => Response.json({ kind: 'none' }),
      read: () =>
        Response.json({ kind: 'failed', reason: 'Harbor Mortgage needs signing in again' }),
    });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Plaid still refuses: Harbor Mortgage needs signing in again.',
    );
  });

  it('says why the server refused', async () => {
    server({
      start: () => Response.json({ kind: 'refused', reason: 'not signed in' }, { status: 401 }),
    });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Not signed in again: not signed in.',
    );
  });

  it('names a non-answer by its status', async () => {
    server({ start: () => new Response('<html>', { status: 504 }) });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Not signed in again: it answered HTTP 504.',
    );
  });

  it('asks nothing without a session', async () => {
    session.token = null;
    const asked = server({});
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Not signed in again: not signed in.',
    );
    expect(asked).toHaveLength(0);
  });

  it('says when Dinora cannot be reached', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Load failed')));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Not signed in again: Dinora could not be reached.',
    );
  });

  it('offers nothing offline', () => {
    show(false);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Signing in again needs a connection.')).toBeTruthy();
  });
});
