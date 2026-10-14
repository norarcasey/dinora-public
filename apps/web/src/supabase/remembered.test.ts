import { AuthApiError, AuthRetryableFetchError } from '@supabase/auth-js';
import { describe, expect, it } from 'vitest';

import { SESSION_STORAGE_KEY, judge, readStoredSession, rememberedUser } from './remembered.ts';

// The local seed's first user. Not an RFC-variant UUID, which is the point: see `z.guid()`.
const USER_ID = '11111111-1111-1111-1111-111111111111';

/** What auth-js writes, with an access token an hour past its expiry. */
function stored(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: 'eyJ.expired.token',
    refresh_token: 'refresh-token',
    expires_at: Math.floor(Date.now() / 1000) - 3_600,
    token_type: 'bearer',
    user: { id: USER_ID, email: 'one@example.test' },
    ...overrides,
  });
}

describe('rememberedUser', () => {
  it('remembers a session whose access token has expired', () => {
    expect(rememberedUser(stored())).toEqual({ id: USER_ID, email: 'one@example.test' });
  });

  it('reads a missing email as empty rather than refusing the session', () => {
    expect(rememberedUser(stored({ user: { id: USER_ID } }))?.email).toBe('');
  });

  it('remembers nothing when nothing usable is stored, and never throws', () => {
    expect(rememberedUser(null)).toBeNull();
    expect(rememberedUser('')).toBeNull();
    expect(rememberedUser('{not json')).toBeNull();
    expect(rememberedUser('"a string"')).toBeNull();
    expect(rememberedUser(stored({ refresh_token: '' }))).toBeNull();
    expect(rememberedUser(stored({ user: { id: 'not-an-id' } }))).toBeNull();
  });
});

describe('readStoredSession', () => {
  it('reads the key the client writes', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'x');
    expect(readStoredSession()).toBe('x');
    localStorage.removeItem(SESSION_STORAGE_KEY);
    expect(readStoredSession()).toBeNull();
  });

  it('answers null when storage refuses', () => {
    const refusing = {
      getItem: (): string | null => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    expect(readStoredSession(refusing)).toBeNull();
  });
});

describe('judge', () => {
  const user = { id: USER_ID, email: 'one@example.test' };

  it('a session is a session', () => {
    expect(judge({ session: { user }, error: null })).toEqual({ kind: 'signed-in', user });
  });

  it('nothing stored and nothing wrong is signed out', () => {
    expect(judge({ session: null, error: null })).toEqual({ kind: 'signed-out' });
  });

  it('a refresh that could not reach the server is no answer at all', () => {
    const error = new AuthRetryableFetchError('Failed to fetch', 0);
    expect(judge({ session: null, error })).toEqual({ kind: 'unreachable' });
  });

  it('a server that refuses the refresh token has signed you out', () => {
    const error = new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found');
    expect(judge({ session: null, error })).toEqual({ kind: 'signed-out' });
  });

  it('an error that is not an auth error is not mistaken for offline', () => {
    expect(judge({ session: null, error: new Error('Failed to fetch') })).toEqual({
      kind: 'signed-out',
    });
  });
});
