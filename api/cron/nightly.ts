/**
 * The nightly run, as Vercel Cron calls it (`crons` in vercel.json): the SimpleFIN pull, the
 * Plaid pull (BANK-07), the exchange rates, the weekly market estimates (ACCT-11), the metal
 * prices (ACCT-12) and the crypto closes (ACCT-21), side by side. Everything they do is
 * `api/_lib/nightly.ts`, `api/_lib/rates.ts`, `api/_lib/estimates.ts`, `api/_lib/metals.ts` and
 * `api/_lib/crypto.ts`; this is the door and the log lines.
 *
 * Side by side because none needs another: the rates finish in a fraction of what the
 * Bridge can take (BANK-02), so reading them costs the run no time, and a failure of any
 * one leaves the others' rows stored.
 */
import { isCronRequest } from '../_lib/cron.ts';
import { coins } from '../_lib/crypto.ts';
import { estimates } from '../_lib/estimates.ts';
import { metals } from '../_lib/metals.ts';
import { nightly, plaidNightly } from '../_lib/nightly.ts';
import { rates } from '../_lib/rates.ts';

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request, process.env.CRON_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const now = new Date();
  const [pull, plaid, rated, estimated, metalled, coined] = await Promise.all([
    nightly(process.env, fetch, now),
    plaidNightly(process.env, fetch, now),
    rates(process.env, fetch, now),
    estimates(process.env, fetch, now),
    metals(process.env, fetch, now),
    coins(process.env, fetch, now),
  ]);
  // Counts, dates and reasons only, which is all any outcome carries (invariant 4).
  console.log(`nightly pull: ${JSON.stringify(pull)}`);
  console.log(`nightly plaid: ${JSON.stringify(plaid)}`);
  console.log(`nightly rates: ${JSON.stringify(rated)}`);
  console.log(`nightly estimates: ${JSON.stringify(estimated)}`);
  console.log(`nightly metals: ${JSON.stringify(metalled)}`);
  console.log(`nightly crypto: ${JSON.stringify(coined)}`);
  const ok = pull.ok && plaid.ok && rated.ok && estimated.ok && metalled.ok && coined.ok;
  return Response.json(
    { pull, plaid, rates: rated, estimates: estimated, metals: metalled, crypto: coined },
    { status: ok ? 200 : 500 },
  );
}
