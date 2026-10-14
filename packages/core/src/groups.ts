import { z } from 'zod';

import type { AccountRow } from './balances.ts';

/**
 * Which of four groups an account belongs to (ACCT-04): cash, credit cards, loans or
 * investments.
 *
 * SimpleFIN sends no account type — protocol v2's account is a name, a currency and balances —
 * so the group is Nora's to say, kept in her own `account_groups` table. Until she has said,
 * Dinora guesses from the account's name and whether the Bridge lists holdings for it, and the
 * guess is shown as one. A guess is never stored: the rules can improve and every unset
 * account follows them, where a stored guess would look like her choice.
 *
 * The rules were written against the 18 accounts linked on 24 Sep (ACCT-03's local pull): BofA,
 * SUMMIT, Amex and Citi cards, PSCU checking, savings, an *Auto Loan* and a *Line of Credit*, and
 * a Fidelity 401(k) and a Contoso Capital Roth IRA with one holding each. The Fidelity account
 * is named after the employer (*GLOBEX CORP.*), which no name rule could read, so holdings
 * are the stronger signal and are read first.
 */

export const GROUPS = ['cash', 'card', 'loan', 'investment'] as const;

export type Group = (typeof GROUPS)[number];

export const groupSchema = z.enum(GROUPS);

/** Her choice, as PostgREST sends it. One live row per account (`account_groups`). */
export const groupRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  account_id: z.string(),
  kind: groupSchema,
});

export type GroupRow = z.output<typeof groupRowSchema>;

export function compareGroups(a: GroupRow, b: GroupRow): number {
  return a.account_id.localeCompare(b.account_id) || a.id.localeCompare(b.id);
}

export type Guess =
  /** One group's words and no other's. Shown as a guess until she sets it. */
  | { readonly kind: 'likely'; readonly group: Group }
  /**
   * Words for two groups, or a name that means either (*Line of Credit*: a revolving loan
   * or a card by another name). `group` is the leaning, `or` the other; neither is assumed.
   */
  | { readonly kind: 'unsure'; readonly group: Group; readonly or: Group }
  /** Nothing in the name to go on. */
  | { readonly kind: 'unknown' };

/**
 * Each group's words, matched whole on the name lowercased with every mark turned to a space
 * (`Citi® Diamond Preferred® Card-7174` is `citi diamond preferred card 7174`, and `401(k)`
 * is `401 k`). The last four digits most names carry are a word of their own, so they cannot
 * run into a number that means something, like 529.
 *
 * A bare `cash` is deliberately in no list: it names cards (*Customized Cash Rewards*,
 * *Preferred Cash Rewards Visa*, *Blue Cash*, *Double Cash*) as often as accounts. So is a
 * bare `credit`, which is in *Line of Credit* and *Credit Card* alike.
 */
const WORDS: Readonly<Record<Group, RegExp>> = {
  loan: /\b(loan|loans|mortgage|heloc|lease)\b/,
  card: /\b(card|visa|mastercard|master card|american express|amex|discover|rewards|signature|sapphire|freedom|skymiles|platinum|double cash|custom cash|blue cash)\b/,
  investment:
    /\b(ira|roth|401 ?k|403 ?b|457 ?b|529|brokerage|investment|investments|individual|retirement|pension|stock|stocks|portfolio)\b/,
  cash: /\b(checking|chequing|savings|saving|money market|mma|cd|certificate|share|shares|deposit|cash management|spending|current account|cuenta|ahorro)\b/,
};

/** *Line of Credit* and its spellings: debt, but a loan or a card is hers to say. */
const LINE_OF_CREDIT = /\b(line of credit|credit line|loc)\b/;

/** Which group an unsure guess leans to: debt first, since a debt missed flatters the net. */
const PRECEDENCE: readonly Group[] = ['loan', 'card', 'investment', 'cash'];

export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function guessGroup(name: string, holdings: number): Guess {
  const words = normaliseName(name);
  const named = PRECEDENCE.filter((group) => WORDS[group].test(words));
  const debtWords = named.filter((group) => group === 'loan' || group === 'card');

  // What the Bridge lists holdings for is invested, whatever it is called, unless its name
  // says it is a debt, which a brokerage never is and a card with points might claim to be.
  if (holdings > 0) {
    const [debt] = debtWords;
    return debt === undefined
      ? { kind: 'likely', group: 'investment' }
      : { kind: 'unsure', group: 'investment', or: debt };
  }

  if (LINE_OF_CREDIT.test(words)) {
    const [other] = named.filter((group) => group !== 'loan');
    return { kind: 'unsure', group: 'loan', or: other ?? 'card' };
  }

  const [first, second] = named;
  if (first === undefined) return { kind: 'unknown' };
  if (second === undefined) return { kind: 'likely', group: first };
  return { kind: 'unsure', group: first, or: second };
}

/* ─── where each account sits ───────────────────────────────────────────────────────────── */

export type Placement = { readonly kind: 'set'; readonly group: Group } | Guess;

export type Placed = { readonly account: AccountRow; readonly placement: Placement };

/** The group she set if there is a live one, the guess otherwise. */
export function placeAccounts(
  accounts: readonly AccountRow[],
  groups: readonly GroupRow[],
): Placed[] {
  const chosen = new Map<string, Group>();
  for (const row of groups) {
    if (row.deleted_at === null) chosen.set(row.account_id, row.kind);
  }
  return accounts
    .filter((account) => account.deleted_at === null)
    .map((account) => {
      const group = chosen.get(account.id);
      return {
        account,
        placement:
          group === undefined ? guessGroup(account.name, account.holdings) : { kind: 'set', group },
      };
    });
}

/* ─── cash and debt ─────────────────────────────────────────────────────────────────────── */

/**
 * `property` is never an account's: it is the assets Nora values herself (ACCT-06), which sit
 * beside the accounts in net worth and in the chart.
 */
export type Side = 'cash' | 'debt' | 'investments' | 'property';

const SIDE: Readonly<Record<Group, Exclude<Side, 'property'>>> = {
  cash: 'cash',
  card: 'debt',
  loan: 'debt',
  investment: 'investments',
};

/**
 * Which total an account counts toward. Debt is cards plus loans (decided 24 Sep), so a guess
 * torn between a loan and a card — *Line of Credit* — is still debt and counts: only the
 * group is in doubt, not the side. Torn across sides, or with no guess, it counts in none of
 * them until she says, and the screen says how many are left out.
 */
export function sideOf(placement: Placement): Side | null {
  switch (placement.kind) {
    case 'set':
    case 'likely':
      return SIDE[placement.group];
    case 'unsure':
      return SIDE[placement.group] === SIDE[placement.or] ? SIDE[placement.group] : null;
    case 'unknown':
      return null;
  }
}

/** The group an account is listed under, or null for the ones waiting on her. */
export function listedUnder(placement: Placement): Group | null {
  return placement.kind === 'set' || placement.kind === 'likely' ? placement.group : null;
}
