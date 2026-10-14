import { compareSnapshots, snapshotRowSchema } from '@dinora/core/history';

import { defineSynced } from './synced.ts';

/**
 * Every account's balance by day (ACCT-03), for the dashboard's chart (ACCT-04). Kept on the
 * device, so the chart draws with no signal. About 2,900 rows a year at 8 accounts, read
 * whole once and by `updated_at` after, which is why the table has that index.
 */
export const BALANCE_SNAPSHOTS = defineSynced({
  name: 'balance_snapshots',
  columns: 'id,updated_at,deleted_at,account_id,on_date,kind,currency,balance_minor,as_of',
  schema: snapshotRowSchema,
  compare: compareSnapshots,
});
