import { describe, expect, it } from 'vitest';

import type { LockRecord } from './lock.ts';
import { enrolled, hidden, IDLE_MS, readLock, shown, unlocked, userVerified } from './lock.ts';

const T = 1_790_000_000_000;

describe('reading the record', () => {
  it('is this account’s record or nothing', () => {
    const record = enrolled('u1');
    expect(readLock(record, 'u1')).toEqual(record);
    expect(readLock(record, 'u2')).toBeNull();
    expect(readLock(record, null)).toBeNull();
  });

  it('refuses what is not a record', () => {
    expect(readLock(null, 'u1')).toBeNull();
    expect(readLock('{"owner":"u1"}', 'u1')).toBeNull();
    expect(readLock({ owner: 'u1', locked: 'no', hiddenAt: null }, 'u1')).toBeNull();
    expect(readLock({ owner: '', locked: false, hiddenAt: null }, '')).toBeNull();
  });
});

describe('going away and coming back', () => {
  const away = (ms: number): LockRecord => shown(hidden(enrolled('u'), T), T + ms);

  it('stays open after a short absence', () => {
    expect(away(0).locked).toBe(false);
    expect(away(IDLE_MS - 1).locked).toBe(false);
  });

  it('locks at the idle time and after it', () => {
    expect(away(IDLE_MS).locked).toBe(true);
    expect(away(60 * 60 * 1000).locked).toBe(true);
  });

  it('locks when the clock went backwards', () => {
    expect(away(-1).locked).toBe(true);
  });

  it('locks a start with no time recorded', () => {
    expect(shown(enrolled('u'), T).locked).toBe(true);
    expect(shown(unlocked({ owner: 'u', locked: true, hiddenAt: T }), T).locked).toBe(true);
  });

  it('honours a different idle time', () => {
    expect(shown(hidden(enrolled('u'), T), T + 1000, 500).locked).toBe(true);
  });
});

describe('a locked app', () => {
  const locked: LockRecord = { owner: 'u', locked: true, hiddenAt: T };

  // A reload fires pagehide, which would otherwise count as a moment ago.
  it('keeps no clock while locked, so a reload does not open it', () => {
    const reloaded = shown(hidden(locked, T + IDLE_MS * 10), T + IDLE_MS * 10 + 1);
    expect(reloaded).toEqual(locked);
  });

  it('opens only when unlocked, and forgets the time it went away', () => {
    expect(unlocked(locked)).toEqual({ owner: 'u', locked: false, hiddenAt: null });
  });
});

describe('user verification', () => {
  const data = (flags: number): Uint8Array => {
    const bytes = new Uint8Array(37);
    bytes[32] = flags;
    return bytes;
  };

  it('reads the UV bit, not the UP bit', () => {
    expect(userVerified(data(0x05))).toBe(true);
    expect(userVerified(data(0x04))).toBe(true);
    expect(userVerified(data(0x01))).toBe(false);
    expect(userVerified(data(0x00))).toBe(false);
  });

  it('is false for data too short to carry flags', () => {
    expect(userVerified(new Uint8Array(32))).toBe(false);
  });
});
