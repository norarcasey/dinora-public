import { describe, expect, it } from 'vitest';

import { isCronRequest } from './cron.ts';

const SECRET = 'a-secret-of-some-length';

function request(authorization?: string): Request {
  return new Request('https://example.test/api/cron/nightly', {
    headers: authorization === undefined ? {} : { authorization },
  });
}

describe('isCronRequest', () => {
  it('accepts the bearer Vercel sends', () => {
    expect(isCronRequest(request(`Bearer ${SECRET}`), SECRET)).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['the secret without the scheme', SECRET],
    ['a different secret of the same length', `Bearer ${'x'.repeat(SECRET.length)}`],
    ['a prefix of the secret', `Bearer ${SECRET.slice(0, -1)}`],
  ])('refuses %s', (_, header) => {
    expect(isCronRequest(request(header), SECRET)).toBe(false);
  });

  // An unset CRON_SECRET must not turn the check off.
  it('refuses everything when no secret is configured', () => {
    expect(isCronRequest(request('Bearer '), undefined)).toBe(false);
    expect(isCronRequest(request('Bearer undefined'), undefined)).toBe(false);
  });

  it('refuses a secret too short to be one', () => {
    expect(isCronRequest(request('Bearer short'), 'short')).toBe(false);
  });
});
