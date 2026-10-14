import { z } from 'zod';

import { parse } from './parse.ts';

/**
 * When the app asks for Face ID again (SEC-01).
 *
 * The lock is for a person holding an unlocked phone, not for code running in the page: code
 * could read the cached rows straight out of IndexedDB and never meet it. So it is decided and
 * checked on the device, and needs no server — offline, the rows are still there to protect,
 * and a lock that needed the network would lock Nora out of them (invariant 12).
 *
 * One record per device, naming the account it belongs to, like the row cache (invariant 11).
 * `locked` is kept rather than worked out afresh each time, so that reloading a locked app —
 * which fires `pagehide` and would otherwise count as a moment ago — does not open it.
 */
export const lockRecordSchema = z.object({
  owner: z.string().min(1),
  locked: z.boolean(),
  hiddenAt: z.number().nullable(),
});

export type LockRecord = z.output<typeof lockRecordSchema>;

/**
 * Five minutes away. Chosen 26 Sep 2026, not measured: long enough that answering a message
 * and coming back does not ask, short enough that a phone left on a table does. Monarch's
 * Face ID lock offers a choice; one person needs one number, and this is where it changes.
 */
export const IDLE_MS = 5 * 60 * 1000;

/** Face ID has just been used on this device — at sign-in, or on turning the lock on. */
export function enrolled(owner: string): LockRecord {
  return { owner, locked: false, hiddenAt: null };
}

/** Whatever is stored, if it is a record and it is this account's. */
export function readLock(stored: unknown, user: string | null): LockRecord | null {
  const result = parse(lockRecordSchema, stored);
  if (!result.ok || user === null || result.value.owner !== user) return null;
  return result.value;
}

/** The app went out of sight. A locked app keeps no clock: it is locked however long. */
export function hidden(record: LockRecord, now: number): LockRecord {
  return record.locked ? record : { ...record, hiddenAt: now };
}

/**
 * The app is being looked at again, or has just started. Locked when it was already, when it
 * has been away `IDLE_MS` or longer, and when there is no time to go on: a start with nothing
 * recorded, or a clock that now reads earlier than it did — a time that cannot be trusted is
 * not evidence that little of it passed.
 */
export function shown(record: LockRecord, now: number, idleMs: number = IDLE_MS): LockRecord {
  if (record.locked) return record;
  const away = record.hiddenAt === null ? null : now - record.hiddenAt;
  const locked = away === null || away < 0 || away >= idleMs;
  return locked ? { ...record, locked: true } : record;
}

export function unlocked(record: LockRecord): LockRecord {
  return { ...record, locked: false, hiddenAt: null };
}

/**
 * Whether the authenticator says it checked who was holding the device — Face ID, Touch ID or
 * the passcode — rather than only that somebody was present. The UV bit, 0x04 of the flags
 * byte that follows the 32-byte RP ID hash (WebAuthn §6.1). Asking for `userVerification:
 * 'required'` is a request; this is the answer, read rather than assumed.
 */
export function userVerified(authenticatorData: Uint8Array): boolean {
  const flags = authenticatorData[32];
  return flags !== undefined && (flags & 0x04) !== 0;
}
