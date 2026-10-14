import { z } from 'zod';

import { parse } from './parse.ts';

/**
 * Reading a source again from the app (BANK-18): what the page asks `/api/bank/read` for, and
 * what it answers. A read is a night's, run now and stored like one, so `read` is the whole
 * of a good answer: the rows it wrote reach the page the way they do every morning. `failed`
 * is the read's own reason, in the words the home screen shows for a night that failed;
 * `refused` is the function not doing it at all: no session, not the owner, not configured.
 */
export const readSourceSchema = z.enum(['simplefin', 'plaid']);
export type ReadSource = z.infer<typeof readSourceSchema>;

export const readRequestSchema = z.object({ source: readSourceSchema });

export const readAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read') }),
  z.object({ kind: z.literal('failed'), reason: z.string() }),
  z.object({ kind: z.literal('refused'), reason: z.string() }),
]);
export type ReadAnswer = z.infer<typeof readAnswerSchema>;

/** The source that reads an account again, or null for one nothing reads (Monarch's). */
export function readSource(source: string): ReadSource | null {
  const parsed = parse(readSourceSchema, source);
  return parsed.ok ? parsed.value : null;
}
