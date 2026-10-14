import { describe, expect, it } from 'vitest';

import { notDone, WriteError, writeFailed } from './writes.ts';

describe('why a write failed', () => {
  it('names the code when Dinora answered and refused', () => {
    const error = writeFailed('the asset was not saved', { code: '42501' }, 403);
    expect(error.code).toBe('42501');
    expect(error.message).toBe('the asset was not saved: 42501');
    expect(notDone(error, 'saved')).toBe('Not saved: Dinora refused it (code 42501).');
    expect(notDone(error, 'removed')).toBe('Not removed: Dinora refused it (code 42501).');
  });

  it('falls back to the HTTP status for an answer that is not PostgREST’s', () => {
    const error = writeFailed('the value was not saved', { code: '' }, 502);
    expect(notDone(error, 'saved')).toBe('Not saved: Dinora refused it (code HTTP 502).');
    expect(writeFailed('x', {}, 400).code).toBe('HTTP 400');
  });

  it('says it could not be reached when there was no answer at all', () => {
    const error = writeFailed('the value was not saved', { code: '' }, 0);
    expect(error.message).toBe('the value was not saved: no answer');
    expect(notDone(error, 'saved')).toBe('Not saved. Try again when Dinora can be reached.');
    expect(notDone(new TypeError('Failed to fetch'), 'removed')).toBe(
      'Not removed. Try again when Dinora can be reached.',
    );
  });

  it('keeps only the code, never what the server said about the row', () => {
    const error = writeFailed(
      'the asset was not saved',
      // PostgREST's own fields, which can quote a value; only `code` is read.
      { code: '23514', ...{ details: 'Failing row contains (secret payee)' } },
      400,
    );
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain('secret');
    expect(error).toBeInstanceOf(WriteError);
  });
});
