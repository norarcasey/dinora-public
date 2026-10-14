import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionState } from './supabase/useSession.ts';

const state: { session: SessionState } = { session: { status: 'loading' } };
const signOut = vi.fn();

vi.mock('./supabase/useSession.ts', () => ({ useSession: () => state.session }));
vi.mock('./supabase/client.ts', () => ({
  auth: { signOut, signInWithOtp: vi.fn(), verifyOtp: vi.fn() },
}));

const lock: { locked: boolean; owner: string | null; canVerify: boolean } = {
  locked: false,
  owner: null,
  canVerify: false,
};
const unlockWithDevice = vi.fn();
const turnOnLock = vi.fn();
const turnOffLock = vi.fn();
vi.mock('./device/lock.ts', () => ({
  useLock: () => ({ locked: lock.locked, owner: lock.owner }),
  deviceCanVerify: () => Promise.resolve(lock.canVerify),
  unlockWithDevice,
  turnOnLock,
  turnOffLock,
}));

// The dashboard has its own tests (Dashboard.test.tsx) and needs a query client.
vi.mock('./Dashboard.tsx', () => ({ Dashboard: () => <p>the dashboard</p> }));
// So does the header's mark for banks that stopped updating (NotUpdated.test.tsx).
vi.mock('./NotUpdated.tsx', () => ({ NotUpdated: () => null }));
vi.mock('./AccountDetails.tsx', () => ({
  AccountDetails: ({ accountId }: { accountId: string }) => <p>account {accountId}</p>,
}));
vi.mock('./Payee.tsx', () => ({ Payee: ({ payee }: { payee: string }) => <p>payee {payee}</p> }));
// jsdom has no layout, and says so on every call.
window.scrollTo = vi.fn();

const { App } = await import('./App.tsx');

beforeEach(() => {
  signOut.mockReset();
  window.location.hash = '';
  Object.assign(lock, { locked: false, owner: null, canVerify: false });
});

// A smoke test first, and the cheapest one there is: an app that throws on first render ships
// a white page, and this catches it without a browser.
it('renders without throwing', () => {
  state.session = { status: 'signed-in', user: { id: 'u', email: 'nora@example.test' } };
  render(<App />);
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Dinora');
});

describe('who is here', () => {
  it('shows nothing to act on while the first answer is pending', () => {
    state.session = { status: 'loading' };
    render(<App />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('asks a signed-out visitor for an email', () => {
    state.session = { status: 'signed-out' };
    render(<App />);
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.queryByText('Sign out')).toBeNull();
  });

  // Behind one button (UI-04): the email and Sign out took the top of every screen.
  it('shows the signed-in account and a way out, under Account', () => {
    state.session = { status: 'signed-in', user: { id: 'u', email: 'nora@example.test' } };
    render(<App />);
    expect(screen.queryByText('nora@example.test')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByText('nora@example.test')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});

describe('signing out', () => {
  beforeEach(() => {
    state.session = { status: 'signed-in', user: { id: 'u', email: 'nora@example.test' } };
  });

  it('signs out everywhere when the server answers', async () => {
    signOut.mockResolvedValue({ error: null });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(signOut).toHaveBeenCalledWith();
  });

  // Offline, auth-js keeps the session when the global sign-out fails. Signing out on a
  // train still has to leave the device signed out, with its cached rows gone.
  it('falls back to this device alone when the server cannot be reached', async () => {
    signOut.mockResolvedValueOnce({ error: new Error('fetch failed') });
    signOut.mockResolvedValueOnce({ error: null });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(2));
    expect(signOut).toHaveBeenLastCalledWith({ scope: 'local' });
  });
});

describe('which screen', () => {
  it("opens an account's details from the hash, and goes back to the dashboard (ACCT-10)", async () => {
    state.session = { status: 'signed-in', user: { id: 'u', email: 'nora@example.test' } };
    window.location.hash = '#/account/card-1';
    render(<App />);
    expect(screen.getByText('account card-1')).toBeTruthy();

    window.location.hash = '#/';
    await waitFor(() => expect(screen.getByText('the dashboard')).toBeTruthy());
  });
});

describe('the tabs (UI-04)', () => {
  beforeEach(() => {
    state.session = { status: 'signed-in', user: { id: 'u', email: 'nora@example.test' } };
  });

  const tab = (name: string) =>
    within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name });

  it('goes to the overview and to the budget', () => {
    render(<App />);
    expect(tab('Overview').getAttribute('href')).toBe('#/');
    expect(tab('Budget').getAttribute('href')).toBe('#/budget');
    expect(tab('Activity').getAttribute('href')).toBe('#/activity');
    expect(tab('Overview').getAttribute('aria-current')).toBe('page');
    expect(tab('Budget').getAttribute('aria-current')).toBeNull();
  });

  // An account is opened from the overview, so the overview is where she still is.
  it("keeps the overview's tab lit on an account", () => {
    window.location.hash = '#/account/card-1';
    render(<App />);
    expect(tab('Overview').getAttribute('aria-current')).toBe('page');
  });

  // A payee is opened from activity (ACCT-14), so activity is where she still is.
  it("keeps activity's tab lit on a payee", () => {
    window.location.hash = '#/payee/netflix';
    render(<App />);
    expect(tab('Activity').getAttribute('aria-current')).toBe('page');
    expect(tab('Overview').getAttribute('aria-current')).toBeNull();
  });
});

describe('Face ID (SEC-01)', () => {
  beforeEach(() => {
    state.session = { status: 'signed-in', user: { id: 'u', email: 'nora@example.test' } };
    unlockWithDevice.mockReset();
    turnOnLock.mockReset();
  });

  it('shows nothing of the accounts while locked, only a way in and a way out', () => {
    Object.assign(lock, { locked: true, owner: 'u' });
    render(<App />);
    expect(screen.queryByText('the dashboard')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('button', { name: 'Unlock with Face ID' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('says so when the unlock did not work', async () => {
    Object.assign(lock, { locked: true, owner: 'u' });
    unlockWithDevice.mockResolvedValue({ ok: false, message: 'That did not unlock. Try again.' });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock with Face ID' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That did not unlock. Try again.');
  });

  it("is not held by another account's lock", () => {
    Object.assign(lock, { locked: true, owner: 'someone-else' });
    render(<App />);
    expect(screen.getByText('the dashboard')).toBeTruthy();
  });

  it('is offered under Account where the device can do it', async () => {
    lock.canVerify = true;
    turnOnLock.mockResolvedValue({ ok: true });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use Face ID' }));
    await waitFor(() => expect(turnOnLock).toHaveBeenCalledWith('u'));
  });

  // The Mac app's web view cannot use a passkey, so it is never offered there.
  it('is not offered where the device cannot', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    await Promise.resolve();
    expect(screen.queryByRole('button', { name: 'Use Face ID' })).toBeNull();
  });
});
