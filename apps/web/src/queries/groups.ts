import type { Group } from '@dinora/core/groups';
import { compareGroups, groupRowSchema } from '@dinora/core/groups';

import { supabase } from '../supabase/client.ts';
import { defineSynced } from './synced.ts';
import { writeFailed } from './writes.ts';

/**
 * The group Nora set for each account (ACCT-04), kept on the device like the accounts, so the
 * dashboard groups them the same way with no signal. About one row per account.
 */
export const ACCOUNT_GROUPS = defineSynced({
  name: 'account_groups',
  columns: 'id,updated_at,deleted_at,account_id,kind',
  schema: groupRowSchema,
  compare: compareGroups,
});

/**
 * Sets the group, or changes it: one row per account, so an upsert on the pair replaces what
 * was there. Online only (PLAT-02): the caller switches the control off without a network,
 * and a failure here is reported rather than queued. The error carries PostgREST's code and
 * nothing of the row, so it can be shown as it is.
 */
export async function setAccountGroup(
  userId: string,
  accountId: string,
  group: Group,
): Promise<void> {
  const { error, status } = await supabase
    .from('account_groups')
    .upsert(
      { user_id: userId, account_id: accountId, kind: group, deleted_at: null },
      { onConflict: 'user_id,account_id' },
    );
  if (error !== null) throw writeFailed('the group was not saved', error, status);
}
