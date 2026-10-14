import { describe, expect, it } from 'vitest';

import { migrationVersions, schemaVerdict, signupVerdict } from './verdicts.ts';

describe('migrationVersions', () => {
  it('reads the leading version of each .sql file, in order', () => {
    expect(
      migrationVersions([
        '20260924000100_things.sql',
        '00000000000100_foundation.sql',
        'README.md',
        'notes_without_version.sql',
      ]),
    ).toEqual(['00000000000100', '20260924000100']);
  });
});

describe('schemaVerdict', () => {
  const repo = ['00000000000100', '20260924000100', '20260925000100'];

  it('passes when production has the newest migration', () => {
    expect(schemaVerdict(repo, '20260925000100').ok).toBe(true);
  });

  it('passes when production is ahead, and says so', () => {
    const verdict = schemaVerdict(repo, '20261001000100');
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('ahead');
  });

  it('refuses when production is behind, naming each missing migration', () => {
    const verdict = schemaVerdict(repo, '20260924000100');
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('1 migration production does not have');
    expect(verdict.message).toContain('20260925000100');
    // The applied version is named once, as where production is — not again as pending.
    expect(verdict.message.split('20260924000100')).toHaveLength(2);
  });

  // Absence never reads as a pass: an empty repo, an empty ledger and an answer of the
  // wrong type are each a refusal.
  it('refuses when the repo has no migrations', () => {
    expect(schemaVerdict([], '20260924000100').ok).toBe(false);
  });

  it.each([null, '', 20260925000100, { version: '20260925000100' }])(
    'refuses an answer it does not recognise: %j',
    (applied) => {
      expect(schemaVerdict(repo, applied).ok).toBe(false);
    },
  );
});

describe('signupVerdict', () => {
  const closed = { disable_signup: true, external: { email: true } };

  it('passes when signup is closed and email sign-in is on', () => {
    expect(signupVerdict(closed).ok).toBe(true);
  });

  it('refuses when signup is open', () => {
    const verdict = signupVerdict({ ...closed, disable_signup: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('Signup is OPEN');
  });

  it('refuses when the setting is missing rather than reading it as closed', () => {
    expect(signupVerdict({ external: { email: true } }).ok).toBe(false);
  });

  // The lockout: the neighbouring switch turned off instead of, or as well as, signup.
  it('refuses when email sign-in is off, because nobody could sign in', () => {
    const verdict = signupVerdict({ disable_signup: true, external: { email: false } });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('EMAIL SIGN-IN IS ALSO OFF');
    expect(signupVerdict({ disable_signup: true }).ok).toBe(false);
  });

  it.each([null, [], 'closed'])('refuses a body that is not an object: %j', (body) => {
    expect(signupVerdict(body).ok).toBe(false);
  });
});
