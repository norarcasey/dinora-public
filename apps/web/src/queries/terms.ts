import { compareTerms, termRowSchema } from '@dinora/core/terms';

import { supabase } from '../supabase/client.ts';
import { defineSynced } from './synced.ts';
import { writeFailed } from './writes.ts';

/**
 * A card's limits and rates as Nora entered them (ACCT-10), kept on the device like the
 * accounts, so an account's details read the same with no signal. A few rows per card.
 */
export const ACCOUNT_TERMS = defineSynced({
  name: 'account_terms',
  columns: 'id,updated_at,deleted_at,account_id,kind,effective_on,amount_minor,rate_bp,ends_on',
  schema: termRowSchema,
  compare: compareTerms,
});

export type NewTerm =
  | {
      readonly kind: 'credit_limit' | 'cash_advance_limit';
      readonly effectiveOn: string;
      readonly amountMinor: number;
    }
  | { readonly kind: 'purchase_apr'; readonly effectiveOn: string; readonly rateBp: number }
  | {
      readonly kind: 'promo_apr';
      readonly effectiveOn: string;
      readonly rateBp: number;
      readonly endsOn: string;
    };

function columns(term: NewTerm) {
  switch (term.kind) {
    case 'credit_limit':
    case 'cash_advance_limit':
      return { amount_minor: term.amountMinor, rate_bp: null, ends_on: null };
    case 'purchase_apr':
      return { amount_minor: null, rate_bp: term.rateBp, ends_on: null };
    case 'promo_apr':
      return { amount_minor: null, rate_bp: term.rateBp, ends_on: term.endsOn };
  }
}

/**
 * Adds a figure. Never an upsert: a new value is a new row and the old one stays as history,
 * which the table enforces by granting UPDATE on `deleted_at` alone. Online only (PLAT-02),
 * and the error carries PostgREST's code and nothing of the row, so it can be shown as it is.
 */
export async function addTerm(userId: string, accountId: string, term: NewTerm): Promise<void> {
  const { error, status } = await supabase.from('account_terms').insert({
    user_id: userId,
    account_id: accountId,
    kind: term.kind,
    effective_on: term.effectiveOn,
    ...columns(term),
  });
  if (error !== null) throw writeFailed('the figure was not saved', error, status);
}

/** Takes back a figure entered by mistake. Removed, not deleted (invariant 2). */
export async function removeTerm(id: string): Promise<void> {
  const { error, status } = await supabase
    .from('account_terms')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error !== null) throw writeFailed('the figure was not removed', error, status);
}
