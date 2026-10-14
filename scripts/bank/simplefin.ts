/**
 * The pure half of `pnpm bank:claim` and `pnpm bank:pull`: the setup token, and the SQL that
 * stores a pull. `cli.ts` is the half that talks to the Bridge and to Docker.
 *
 * Here rather than in packages/core because it is about this machine's scripts, not the
 * domain: base64 through Buffer, SQL for psql. Reading the Bridge is `api/_lib/simplefin.ts`,
 * shared with the nightly cron; what its answer means is `packages/core/src/simplefin.ts`.
 */
import { Buffer } from 'node:buffer';

import type { Rows } from '../../packages/core/src/simplefin.ts';

/** A setup token is a base64 claim URL. Null unless it decodes to https. */
export function claimUrl(token: string): URL | null {
  const trimmed = token.trim();
  if (!/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) return null;
  try {
    const url = new URL(Buffer.from(trimmed, 'base64').toString('utf8'));
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A dollar-quote tag none of `texts` contains, so nothing in them can end the literal. */
function tagFor(texts: readonly string[]): string {
  for (let i = 0; ; i++) {
    const tag = `$p${i}$`;
    if (!texts.some((t) => t.includes(tag))) return tag;
  }
}

export type Run = {
  readonly startedAt: string;
  readonly requests: number;
  /** From `dropsFrom`: null marks nothing dropped. */
  readonly dropsFrom: string | null;
  /** From `historyFrom`: null rebuilds each account only from its earliest transaction. */
  readonly historyFrom: string | null;
  readonly detail: string;
};

/**
 * One call to `public.bank_store` as service_role — the same function the nightly cron
 * calls, so a pull from here reconciles, marks drops and records itself exactly as a night
 * does (BANK-02). Upsert on the aggregator's ids; nothing is ever deleted.
 *
 * Every value reaches Postgres inside a dollar-quoted literal, so none is spliced into the
 * SQL text — a payee with a quote in it is only a payee.
 */
export function storeSql(
  userId: string,
  rows: Rows,
  run: Run,
  source: 'simplefin' | 'plaid' = 'simplefin',
): string {
  if (!UUID.test(userId)) throw new Error('storeSql: userId is not a uuid');
  const payload = JSON.stringify({
    accounts: rows.accounts,
    transactions: rows.transactions,
    history_from: run.historyFrom,
  });
  const args = JSON.stringify(run);
  const tag = tagFor([payload, args]);
  const r = `(${tag}${args}${tag}::jsonb)`;

  return `\\set ON_ERROR_STOP on
begin;
set local role service_role;

select 'stored ' || s.accounts || ' account(s), ' || s.transactions || ' transaction(s): '
       || s.added || ' new, ' || s.dropped || ' marked dropped, ' || s.restored || ' restored; '
       || s.kept || ' balance(s) kept, ' || s.rebuilt || ' day(s) rebuilt'
       || case when s.drops_from is null then ' (drops not checked)' else '' end
from public.bank_store(
  '${userId}'::uuid,
  '${source}',
  ${tag}${payload}${tag}::jsonb,
  (${r} ->> 'startedAt')::timestamptz,
  (${r} ->> 'requests')::integer,
  (${r} ->> 'dropsFrom')::timestamptz,
  ${r} ->> 'detail'
) as s;
commit;
`;
}
