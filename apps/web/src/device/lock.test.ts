import { IDLE_MS } from '@dinora/core/lock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AuthListener = (event: string) => void;
const authListeners: AuthListener[] = [];
const registerPasskey = vi.fn();
const remembered: { id: string | null } = { id: 'u1' };

vi.mock('../supabase/client.ts', () => ({
  auth: {
    registerPasskey,
    onAuthStateChange: (listener: AuthListener) => {
      authListeners.push(listener);
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    },
  },
}));
vi.mock('../supabase/remembered.ts', () => ({
  readStoredSession: () => null,
  rememberedUser: () =>
    remembered.id === null ? null : { id: remembered.id, email: 'nora@example.test' },
}));

const { enrollLock, startLock, turnOnLock, unlockWithDevice } = await import('./lock.ts');

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

function become(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

const marked = (): boolean => document.documentElement.hasAttribute('data-locked');
const stored = (): unknown => JSON.parse(localStorage.getItem('dinora.lock') ?? 'null');

let stop: (() => void) | null = null;
beforeEach(() => {
  vi.useFakeTimers({ now: 1_790_000_000_000, toFake: ['Date'] });
  localStorage.clear();
  remembered.id = 'u1';
  authListeners.length = 0;
});
afterEach(() => {
  stop?.();
  stop = null;
  visibility = 'visible';
  vi.useRealTimers();
  document.documentElement.removeAttribute('data-locked');
});

describe('starting', () => {
  it('does nothing on a device where Face ID was never turned on', () => {
    stop = startLock();
    expect(marked()).toBe(false);
    expect(stored()).toBeNull();
  });

  it('starts locked when the app was last seen long ago', () => {
    localStorage.setItem(
      'dinora.lock',
      JSON.stringify({ owner: 'u1', locked: false, hiddenAt: Date.now() - IDLE_MS }),
    );
    stop = startLock();
    expect(marked()).toBe(true);
  });

  it('starts open after a reload a moment ago', () => {
    localStorage.setItem(
      'dinora.lock',
      JSON.stringify({ owner: 'u1', locked: false, hiddenAt: Date.now() - 1000 }),
    );
    stop = startLock();
    expect(marked()).toBe(false);
  });

  it('ignores another account’s record', () => {
    localStorage.setItem(
      'dinora.lock',
      JSON.stringify({ owner: 'u2', locked: true, hiddenAt: null }),
    );
    stop = startLock();
    expect(marked()).toBe(false);
  });
});

describe('going away', () => {
  beforeEach(() => {
    stop = startLock();
    enrollLock('u1');
  });

  it('stays open after a short absence', () => {
    become('hidden');
    vi.setSystemTime(Date.now() + IDLE_MS - 1);
    become('visible');
    expect(marked()).toBe(false);
  });

  it('locks after five minutes away', () => {
    become('hidden');
    vi.setSystemTime(Date.now() + IDLE_MS);
    become('visible');
    expect(marked()).toBe(true);
    expect(stored()).toMatchObject({ owner: 'u1', locked: true });
  });

  // A reload fires pagehide, which would otherwise count as a moment ago.
  it('stays locked through a reload', () => {
    become('hidden');
    vi.setSystemTime(Date.now() + IDLE_MS);
    become('visible');
    window.dispatchEvent(new Event('pagehide'));
    stop?.();
    stop = startLock();
    expect(marked()).toBe(true);
  });

  it('forgets the lock when the session ends', () => {
    for (const listener of authListeners) listener('SIGNED_OUT');
    expect(stored()).toBeNull();
    expect(marked()).toBe(false);
  });
});

describe('turning it on', () => {
  it('turns on after a new passkey', async () => {
    registerPasskey.mockResolvedValue({ data: { id: 'p' }, error: null });
    expect(await turnOnLock('u1')).toEqual({ ok: true });
    expect(stored()).toMatchObject({ owner: 'u1', locked: false });
  });

  it('turns on when this device already holds one', async () => {
    registerPasskey.mockResolvedValue({
      data: null,
      error: { code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' },
    });
    expect(await turnOnLock('u1')).toEqual({ ok: true });
  });

  it('stays off when the passkey was not made', async () => {
    registerPasskey.mockResolvedValue({ data: null, error: { code: 'ERROR_CEREMONY_ABORTED' } });
    expect((await turnOnLock('u1')).ok).toBe(false);
    expect(stored()).toBeNull();
  });
});

describe('unlocking', () => {
  // jsdom has no WebAuthn; these stand in for the two classes the answer is checked against.
  class FakeAssertion {
    constructor(readonly authenticatorData: ArrayBuffer) {}
  }
  class FakeCredential {
    constructor(readonly response: unknown) {}
  }
  const flags = (value: number): ArrayBuffer => {
    const bytes = new Uint8Array(37);
    bytes[32] = value;
    return bytes.buffer;
  };
  const get = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('PublicKeyCredential', FakeCredential);
    vi.stubGlobal('AuthenticatorAssertionResponse', FakeAssertion);
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get } });
    localStorage.setItem(
      'dinora.lock',
      JSON.stringify({ owner: 'u1', locked: true, hiddenAt: null }),
    );
    stop = startLock();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens when the device verified who is holding it', async () => {
    get.mockResolvedValue(new FakeCredential(new FakeAssertion(flags(0x05))));
    expect(await unlockWithDevice()).toEqual({ ok: true });
    expect(marked()).toBe(false);
    expect(get.mock.calls[0]?.[0]).toMatchObject({ publicKey: { userVerification: 'required' } });
  });

  it('stays locked when the device only saw that somebody was there', async () => {
    get.mockResolvedValue(new FakeCredential(new FakeAssertion(flags(0x01))));
    expect((await unlockWithDevice()).ok).toBe(false);
    expect(marked()).toBe(true);
  });

  it('stays locked when Face ID is cancelled', async () => {
    get.mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));
    expect((await unlockWithDevice()).ok).toBe(false);
    expect(marked()).toBe(true);
  });
});
