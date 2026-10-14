import { describe, expect, it } from 'vitest';

import { readAnswerSchema, readSource } from './reading.ts';

describe('readSource', () => {
  it('names the two aggregators, and nothing for Monarch or a stranger', () => {
    expect(readSource('simplefin')).toBe('simplefin');
    expect(readSource('plaid')).toBe('plaid');
    expect(readSource('monarch')).toBeNull();
    expect(readSource('')).toBeNull();
  });
});

describe('readAnswerSchema', () => {
  it('reads each answer and refuses one with no kind', () => {
    expect(readAnswerSchema.safeParse({ kind: 'read' }).success).toBe(true);
    expect(readAnswerSchema.safeParse({ kind: 'failed', reason: 'x' }).success).toBe(true);
    expect(readAnswerSchema.safeParse({ kind: 'failed' }).success).toBe(false);
    expect(readAnswerSchema.safeParse({ ok: true }).success).toBe(false);
  });
});
