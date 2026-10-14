import type { LockRecord } from '@dinora/core/lock';
import { enrolled, hidden, readLock, shown, unlocked, userVerified } from '@dinora/core/lock';
import { useSyncExternalStore } from 'react';

import { auth } from '../supabase/client.ts';
import { readStoredSession, rememberedUser } from '../supabase/remembered.ts';

/**
 * Face ID, on this device: the lock after idle (SEC-01) and the switch that turns it on. The
 * rule for when it locks is `packages/core/src/lock.ts`; this is where it meets the page.
 *
 * Locking marks `<html>` in the same event that noticed the time away, and `shell.css` hides
 * everything in `#root` but the lock screen from that moment — the veil lifts on the same
 * event, and React renders the lock screen a moment later, so without the mark the app would
 * show for a frame first.
 */

const KEY = 'dinora.lock';
const ATTRIBUTE = 'data-locked';

export type LockState = { readonly locked: boolean; readonly owner: string | null };

let state: LockState = { locked: false, owner: null };
const listeners = new Set<() => void>();

function read(user: string | null): LockRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    return readLock(raw === null ? null : JSON.parse(raw), user);
  } catch {
    return null;
  }
}

function settle(record: LockRecord | null): void {
  try {
    if (record === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Storage refused. The state below still holds for as long as the page is open.
  }
  const root = document.documentElement;
  if (record?.locked === true) root.setAttribute(ATTRIBUTE, '');
  else root.removeAttribute(ATTRIBUTE);
  state = { locked: record?.locked ?? false, owner: record?.owner ?? null };
  for (const listener of listeners) listener();
}

const currentUser = (): string | null => rememberedUser(readStoredSession())?.id ?? null;

/** Called once from main.tsx, before React mounts, so a locked app never renders open. */
export function startLock(doc: Document = document, win: Window = window): () => void {
  const now = (): number => Date.now();
  const record = read(currentUser());
  settle(record === null ? null : shown(record, now()));

  const away = (): void => {
    const current = read(state.owner);
    if (current !== null) settle(hidden(current, now()));
  };
  const back = (): void => {
    if (doc.visibilityState !== 'visible') return;
    const current = read(state.owner);
    if (current !== null) settle(shown(current, now()));
  };
  const onVisibility = (): void => (doc.visibilityState === 'visible' ? back() : away());

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', away);
  win.addEventListener('pageshow', back);
  // A server that ends the session ends the lock with it; the next account starts without one.
  const { data } = auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') settle(null);
  });

  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', away);
    win.removeEventListener('pageshow', back);
    data.subscription.unsubscribe();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLock(): LockState {
  return useSyncExternalStore(subscribe, () => state);
}

/**
 * Whether this device can do Face ID (or Touch ID, or its passcode) for a web page at all.
 * The Mac app's web view answers no without an entitlement it does not have, so the switch is
 * simply not offered there — nothing in Swift decides it (invariant 13).
 */
export async function deviceCanVerify(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined') return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Face ID was just used here, for this account: at a passkey sign-in, or turning it on. */
export function enrollLock(user: string): void {
  settle(enrolled(user));
}

export function turnOffLock(): void {
  settle(null);
}

export type Outcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Turns Face ID on for this account on this device: a passkey on the server, so it can sign in,
 * and the lock here. A passkey this device already holds is refused by the device as a
 * duplicate, which is the answer wanted — it can already do both.
 */
export async function turnOnLock(user: string): Promise<Outcome> {
  const { error } = await auth.registerPasskey();
  if (error !== null && error.code !== 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
    return { ok: false, message: 'Face ID was not set up. Try again.' };
  }
  enrollLock(user);
  return { ok: true };
}

/**
 * Asks the device to check who is holding it, and opens the app if it did. No server: the
 * challenge is ours and nothing is sent anywhere, so this works with no signal. What is
 * checked is the authenticator's own flag saying it verified the user (see `userVerified`).
 */
export async function unlockWithDevice(): Promise<Outcome> {
  const failed = { ok: false, message: 'That did not unlock. Try again.' } as const;
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        userVerification: 'required',
        timeout: 60_000,
      },
    });
    if (
      !(credential instanceof PublicKeyCredential) ||
      !(credential.response instanceof AuthenticatorAssertionResponse) ||
      !userVerified(new Uint8Array(credential.response.authenticatorData))
    ) {
      return failed;
    }
  } catch {
    return failed;
  }
  const current = read(state.owner);
  if (current !== null) settle(unlocked(current));
  return { ok: true };
}
