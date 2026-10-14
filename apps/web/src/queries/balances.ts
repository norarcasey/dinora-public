import { accountRowSchema, compareAccounts, pullRowSchema } from '@dinora/core/balances';
import { compareRates, rateRowSchema } from '@dinora/core/rates';

import { defineSynced } from './synced.ts';

/**
 * What the balances screen reads (ACCT-01). Both are small and both are kept on the device, so
 * a cold open with no signal still shows every balance and when it was read.
 *
 * `available_minor` is left out: BofA sends 0 for it, which is not a card's available credit
 * (BANK-01), and a column never read cannot be shown by mistake. Neither table has the
 * `(user_id, updated_at)` index the changed-since read wants; at 8 accounts and two pulls a
 * night (production, 24 Sep), a scan costs nothing a person could notice, and an index is a
 * migration to push by hand. `transactions`, at 528 rows after one night, will want it.
 *
 * `bank_pulls.source` is read since Plaid became a second source (BANK-07), so each source's
 * last read and failure are its own.
 *
 * `holdings` is how many the Bridge lists (ACCT-03), read for the group guess (ACCT-04). The
 * select list is the cache's fingerprint, so adding it makes each device read its accounts
 * whole once.
 *
 * `source` since BANK-15, so an account Monarch had and a bank now reads can be found as the
 * same account counted twice (`doubledAccounts`).
 */
export const ACCOUNTS = defineSynced({
  name: 'accounts',
  columns:
    'id,updated_at,deleted_at,institution,name,currency,balance_minor,balance_at,holdings,source',
  schema: accountRowSchema,
  compare: compareAccounts,
});

export const BANK_PULLS = defineSynced({
  name: 'bank_pulls',
  columns: 'id,updated_at,deleted_at,source,outcome,finished_at,detail',
  schema: pullRowSchema,
});

/**
 * The ECB's rates, kept on the device like the balances so an offline total still converts
 * — at the rate it names. `rate::text` because PostgREST sends a bare numeric as a JSON
 * number, which would be a float by the time it was parsed. About 255 rows a year.
 */
export const FX_RATES = defineSynced({
  name: 'fx_rates',
  columns: 'id,updated_at,deleted_at,source,base,quote,rate_date,rate::text',
  schema: rateRowSchema,
  compare: compareRates,
});
