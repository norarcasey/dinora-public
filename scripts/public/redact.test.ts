import { describe, expect, it } from 'vitest';

import { commentsOnly, parseRedactions, redact, secrets, survivors } from './redact.ts';

describe('parseRedactions', () => {
  it('reads one term a line, skipping blanks and comments, and allows an empty stand-in', () => {
    expect(parseRedactions('# lender\nAcme Lending => Harbor Mortgage\n\nAcme =>\n')).toEqual({
      ok: true,
      value: [
        { from: 'Acme Lending', to: 'Harbor Mortgage' },
        { from: 'Acme', to: '' },
      ],
    });
  });

  it('refuses a map it cannot trust, saying which line', () => {
    expect(parseRedactions('')).toEqual({ ok: false, reason: 'it lists no terms' });
    expect(parseRedactions('Acme Harbor')).toEqual({ ok: false, reason: 'line 1 has no "=>"' });
    expect(parseRedactions('=> Harbor')).toMatchObject({ ok: false, reason: /line 1/ });
    expect(parseRedactions('Acme => A\nAcme => B')).toMatchObject({ ok: false, reason: /line 2/ });
    expect(parseRedactions('Acme => Acme Two')).toMatchObject({
      ok: false,
      reason: /contains its own term/,
    });
  });
});

describe('redact', () => {
  it('replaces the longest term first, literally and in the case written', () => {
    const map = [
      { from: 'Acme', to: 'Harbor' },
      { from: 'Acme Lending', to: 'Lakeside Bank' },
    ];
    expect(redact('Acme Lending, then Acme, then acme.', map)).toBe(
      'Lakeside Bank, then Harbor, then acme.',
    );
  });
});

describe('survivors', () => {
  it('names a term left in any case, which is how a forgotten variant is found', () => {
    const map = [
      { from: 'Acme', to: 'Harbor' },
      { from: 'Zed', to: 'Y' },
    ];
    expect(survivors('the ACME loan', map)).toEqual(['Acme']);
    expect(survivors('the Harbor loan', map)).toEqual([]);
  });
});

describe('secrets', () => {
  it('passes the test hosts, the demo account and the comment describing the shape', () => {
    const text = [
      "SIMPLEFIN_ACCESS_URL: 'https://u:p@bridge.test/simplefin'",
      "access('https://a%40b:p%3Aw@x.test/simplefin/')",
      "'https://demo:demo@beta-bridge.simplefin.org/simplefin'",
      '`https://user:pass@host/simplefin`',
      'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500',
      "'access-production-2'",
    ].join('\n');
    expect(secrets(text)).toEqual([]);
  });

  // Each built at run time, because this file is exported too and its literals would be the
  // first thing the export refuses.
  it('names each shape a real credential has', () => {
    const jwt = `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.sig`;
    expect(secrets(jwt)).toEqual(['a JWT']);
    expect(secrets(`-----BEGIN RSA ${'PRIVATE'} KEY-----`)).toEqual(['a PEM private key']);
    expect(secrets(`sb_secret_${'x'.repeat(12)}`)).toEqual(['a Supabase secret key']);
    expect(secrets(`ghp_${'x'.repeat(36)}`)).toEqual(['a GitHub token']);
    expect(secrets(`https://8f2a:${'c0ffee'}@bridge.simplefin.org/simplefin`)).toEqual([
      'a credential in a URL',
    ]);
    expect(secrets(`access-production-${'0'.repeat(8)}-${'1'.repeat(12)}`)).toEqual([
      'a Plaid access token',
    ]);
  });
});

describe('commentsOnly', () => {
  const sql = '-- the Acme mortgage\ncreate table t (id int); -- for Acme\n';

  it('passes a migration whose comments alone changed', () => {
    expect(commentsOnly(sql, redact(sql, [{ from: 'Acme', to: 'Harbor' }]))).toEqual({
      ok: true,
      value: null,
    });
  });

  it('refuses one whose SQL would change, since the copy must make the same schema', () => {
    const data = "insert into t values ('Acme');\n";
    expect(commentsOnly(data, redact(data, [{ from: 'Acme', to: 'Harbor' }]))).toEqual({
      ok: false,
      reason: 'line 1 changed outside a comment',
    });
    expect(commentsOnly('a\nb', 'a')).toEqual({ ok: false, reason: 'its line count changed' });
  });
});
