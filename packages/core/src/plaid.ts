/**
 * Plaid, for the accounts SimpleFIN does not reach (BANK-06): what may be asked for, and what
 * its answers mean. Talking to Plaid is `api/_lib/plaid.ts`.
 *
 * Shapes are from Plaid's API reference (read 25 Sep 2026), not yet from a real answer: the
 * spike is what measures them. Only what the spike reports is described; Zod drops the rest.
 */
import { z } from 'zod';

import { accountDigits } from './doubles.ts';
import { minorDigits, toMinor } from './money.ts';
import { parse } from './parse.ts';
import { signingIn } from './signing-in.ts';
import type { AccountRow, Rows, Skip, TransactionRow } from './simplefin.ts';
import { accountLabel } from './simplefin.ts';

/**
 * The only products Dinora asks Plaid for, all of them reads. Auth (account and routing
 * numbers), Transfer, Payment Initiation and Signal are what a link needs to move money or
 * to vouch for moving it, so none is here, and a link token cannot be made for one
 * (invariant 5).
 */
export const READ_PRODUCTS = ['liabilities', 'investments', 'transactions'] as const;
export type ReadProduct = (typeof READ_PRODUCTS)[number];

export function readProduct(name: string): ReadProduct | null {
  return READ_PRODUCTS.find((p) => p === name) ?? null;
}

export function linkTokenRequest(product: ReadProduct, clientUserId: string) {
  return {
    client_name: 'Dinora',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: clientUserId },
    products: [product],
  };
}

/**
 * Link's update mode (BANK-11): the item's own access token and no `products`, so it signs an
 * item in again rather than making a second one, and it cannot add a product to the item, a
 * money-moving one included (invariant 5). The item keeps its access token: nothing is
 * exchanged and nothing kept changes.
 */
export function updateTokenRequest(accessToken: string, clientUserId: string) {
  return {
    client_name: 'Dinora',
    language: 'en',
    country_codes: ['US'],
    user: { client_user_id: clientUserId },
    access_token: accessToken,
  };
}

/**
 * Update mode asking her to consent to one more read (BANK-14), for an item linked before it
 * was wanted: Lakeside Bank was linked for `liabilities`, and its charges need
 * `transactions`. Typed to `ReadProduct`, so the one product update mode can add is a read
 * (invariant 5). Consent alone bills nothing; the nightly's first `/transactions/sync` adds
 * the product (`transactionsItem`).
 */
export function consentRequest(accessToken: string, clientUserId: string, product: ReadProduct) {
  return {
    ...updateTokenRequest(accessToken, clientUserId),
    additional_consented_products: [product],
  };
}

/**
 * The same, as Hosted Link (BANK-12): Plaid answers with an address of its own to open,
 * rather than a token for its script to open in Dinora's page. Measured 26 Sep 2026 against
 * production on the Trial plan: it answers, with a `hosted_link_url` on secure.plaid.com.
 */
export function hostedUpdateRequest(accessToken: string, clientUserId: string) {
  return { ...updateTokenRequest(accessToken, clientUserId), hosted_link: {} };
}

const institutionSchema = z.object({
  institution_id: z.string(),
  name: z.string(),
  products: z.array(z.string()),
  oauth: z.boolean().optional(),
});

const institutionsSchema = z.object({ institutions: z.array(institutionSchema) });

export type Institution = {
  readonly id: string;
  readonly name: string;
  /** Of `READ_PRODUCTS`, those the institution supports. */
  readonly reads: readonly ReadProduct[];
  readonly oauth: boolean;
};

export function parseInstitutions(input: unknown) {
  const parsed = parse(institutionsSchema, input);
  if (!parsed.ok) return parsed;
  const value: Institution[] = parsed.value.institutions.map((i) => ({
    id: i.institution_id,
    name: i.name,
    reads: READ_PRODUCTS.filter((p) => i.products.includes(p)),
    oauth: i.oauth ?? false,
  }));
  return { ok: true as const, value };
}

const balancesSchema = z.object({
  current: z.number().nullable(),
  available: z.number().nullable(),
  iso_currency_code: z.string().nullable(),
  unofficial_currency_code: z.string().nullable().optional(),
  last_updated_datetime: z.string().nullable().optional(),
});

const accountSchema = z.object({
  account_id: z.string().min(1),
  type: z.string(),
  subtype: z.string().nullable(),
  balances: balancesSchema,
});

const accountsSchema = z.object({
  accounts: z.array(accountSchema),
  item: z.object({ institution_id: z.string().nullable().optional() }),
});

const liabilitiesSchema = z.object({
  liabilities: z.object({
    mortgage: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  }),
});

const holdingsSchema = z.object({
  holdings: z.array(
    z.object({ account_id: z.string(), cost_basis: z.number().nullable().optional() }),
  ),
});

export type Answers = {
  readonly accounts: unknown;
  /** Null when not asked, as for an item linked for investments. */
  readonly liabilities: unknown;
  readonly holdings: unknown;
};

type Sign = 'negative' | 'zero' | 'positive' | 'absent';

function sign(n: number | null): Sign {
  if (n === null) return 'absent';
  return n < 0 ? 'negative' : n > 0 ? 'positive' : 'zero';
}

export type AccountShape = {
  readonly type: string;
  readonly subtype: string;
  readonly currency: string;
  readonly current: Sign;
  readonly available: Sign;
  /** Whether Plaid says when the balance was read, which the dashboard's age needs. */
  readonly dated: boolean;
  readonly holdings: number;
  readonly withCost: number;
  /** The names of the mortgage's fields, sorted: which of them Plaid fills is the question. */
  readonly mortgage: string;
};

/**
 * What the spike prints for each account: types, signs, counts and field names — never an
 * amount, even a rate or a payment (invariant 4).
 */
export function shape(answers: Answers) {
  const accounts = parse(accountsSchema, answers.accounts);
  if (!accounts.ok) return { ok: false as const, issues: accounts.issues.length };
  const liabilities =
    answers.liabilities === null ? null : parse(liabilitiesSchema, answers.liabilities);
  if (liabilities !== null && !liabilities.ok) {
    return { ok: false as const, issues: liabilities.issues.length };
  }
  const holdings = answers.holdings === null ? null : parse(holdingsSchema, answers.holdings);
  if (holdings !== null && !holdings.ok) {
    return { ok: false as const, issues: holdings.issues.length };
  }

  const mortgages = liabilities?.value.liabilities.mortgage ?? [];
  const held = holdings?.value.holdings ?? [];
  const value: AccountShape[] = accounts.value.accounts.map((a) => {
    const mine = held.filter((h) => h.account_id === a.account_id);
    const mortgage = mortgages.find((m) => m['account_id'] === a.account_id);
    return {
      type: a.type,
      subtype: a.subtype ?? '',
      currency: a.balances.iso_currency_code ?? a.balances.unofficial_currency_code ?? '',
      current: sign(a.balances.current),
      available: sign(a.balances.available),
      dated: (a.balances.last_updated_datetime ?? null) !== null,
      holdings: mine.length,
      withCost: mine.filter((h) => (h.cost_basis ?? null) !== null).length,
      mortgage:
        mortgage === undefined
          ? ''
          : Object.keys(mortgage)
              .filter((k) => mortgage[k] !== null)
              .sort()
              .join(' '),
    };
  });
  return { ok: true as const, value };
}

/* ─── an item's accounts into rows (BANK-07) ────────────────────────────────────────────── */

const itemSchema = z.object({
  item: z.object({ institution_name: z.string().nullable().optional() }),
});

const rowAccountsSchema = z.object({
  accounts: z.array(
    accountSchema.extend({ name: z.string(), mask: z.string().nullable().optional() }),
  ),
});

/**
 * Plaid's name with the account's last digits after it, as the Bridge writes them —
 * `Gemini Credit Card (4821)` — so a Plaid account can be told to be the one Monarch had
 * (BANK-15, `doubledAccounts`). Plaid keeps them apart, in `mask`; a name whose number is
 * already them is left alone.
 */
export function withMask(name: string, mask: string | null | undefined): string {
  const digits = mask?.trim() ?? '';
  if (digits === '' || accountDigits(name) === accountDigits(digits)) return name;
  return name.trim() === '' ? `(${digits})` : `${name.trimEnd()} (${digits})`;
}

/**
 * One linked item as the nightly reads it: `/item/get` and `/accounts/get`. `place` is its
 * position in `PLAID_ACCESS_TOKENS`, kept because an item skipped for wanting signing in
 * (BANK-10) would otherwise shift every later item's number in a failure's words.
 */
export type ItemAnswers = {
  readonly place: number;
  readonly item: unknown;
  readonly accounts: unknown;
};

/**
 * A loan or a card is the lender's figure, positive when owed (measured 25 Sep, sandbox and
 * Harbor's production answer). Every other row Dinora keeps is the cardholder's, a debt
 * negative (BANK-01), so these two flip and nothing downstream has to know which
 * aggregator an account came from.
 */
function owed(type: string): boolean {
  return type === 'loan' || type === 'credit';
}

/**
 * Plaid's balance is a JSON number. Its shortest decimal text is exactly what the lender
 * sent for any amount in cents, so the cents come from that text through `toMinor` and are
 * refused, not rounded, if it holds more digits than the currency has (invariant 1).
 */
function minorOf(n: number, digits: number) {
  return toMinor(String(n), digits);
}

/**
 * Every item's accounts into the rows `bank_store` takes, and the transactions of those that
 * were synced (BANK-14), keyed by the item's `place`. `pulledAt` stands for `balance_at`
 * because Plaid dated no balance, in sandbox or in production (BANK-06): the age shown is
 * the pull's, and a lender slow to refresh looks fresher than it is.
 *
 * An account whose balance or currency cannot be read exactly is skipped whole, as
 * SimpleFIN's are, with its transactions. An item that does not parse fails the lot, so a
 * night stores all of Plaid or none of it. `warnings` are the banks the pull left out because
 * they want signing in again (BANK-10), carried as `errors` so the stored detail says so, as
 * SimpleFIN's does.
 *
 * `removed` and `cursors` ride beside the rows, and `bank_store` writes them in the same
 * transaction: a cursor saved without its rows would skip them for good.
 */
export function plaidRows(
  items: readonly ItemAnswers[],
  pulledAt: string,
  warnings: readonly string[],
  synced: ReadonlyMap<number, Synced> = new Map(),
) {
  const accounts: AccountRow[] = [];
  const transactions: TransactionRow[] = [];
  const skipped: Skip[] = [];
  const partial = new Set<string>();
  const removed: string[] = [];
  const cursors: { item: string; cursor: string }[] = [];
  for (const answers of items) {
    const item = parse(itemSchema, answers.item);
    const listed = parse(rowAccountsSchema, answers.accounts);
    if (!item.ok || !listed.ok) {
      return { ok: false as const, reason: `item ${answers.place + 1}'s answer did not parse` };
    }
    for (const a of listed.value.accounts) {
      const institution = item.value.item.institution_name ?? '';
      const about = {
        kind: 'account' as const,
        account: a.account_id,
        label: accountLabel(institution, a.name, a.account_id),
      };
      const currency = a.balances.iso_currency_code ?? '';
      const digits = minorDigits(currency);
      if (digits === null) {
        skipped.push({ ...about, why: 'its currency is not an ISO 4217 code' });
        continue;
      }
      if (a.balances.current === null) {
        skipped.push({ ...about, why: 'it has no current balance' });
        continue;
      }
      const balance = minorOf(a.balances.current, digits);
      if (!balance.ok) {
        skipped.push({ ...about, why: `its balance is not an exact ${currency} amount` });
        continue;
      }
      const flip = owed(a.type) ? -1 : 1;
      // Only a deposit's available balance is money on hand; a card's is credit left.
      const availableRead =
        a.type === 'depository' && a.balances.available !== null
          ? minorOf(a.balances.available, digits)
          : null;
      accounts.push({
        source_id: a.account_id,
        institution,
        name: withMask(a.name, a.mask),
        currency,
        balance_minor: flip * balance.minor || 0,
        available_minor: availableRead?.ok === true ? availableRead.minor : null,
        balance_at: pulledAt,
        holdings: 0,
      });
    }

    const sync = synced.get(answers.place);
    if (sync === undefined) continue;
    const kept = new Map(accounts.map((a) => [a.source_id, a]));
    let unread = false;
    for (const t of sync.transactions) {
      const account = kept.get(t.account_id);
      if (account === undefined) {
        unread = true;
        continue;
      }
      const row = transactionRow(t);
      if (row === null) {
        skipped.push({
          kind: 'transaction',
          transaction: t.transaction_id,
          account: account.source_id,
          label: accountLabel(account.institution, account.name, account.source_id),
          why: 'its amount or currency could not be read',
        });
        partial.add(account.source_id);
        unread = true;
        continue;
      }
      transactions.push(row);
    }
    removed.push(...sync.removed);
    // A transaction skipped here, alone or with its account, is never offered again once the
    // cursor passes it, where the Bridge's is re-read for 90 days. So the cursor waits, and
    // each night asks again.
    if (sync.cursor !== '' && !unread) cursors.push({ item: sync.item, cursor: sync.cursor });
  }
  const rows: Rows = {
    accounts,
    transactions,
    skipped,
    errors: [...warnings],
    partial: [...partial],
  };
  return { ok: true as const, rows, removed, cursors };
}

/* ─── new transactions, through /transactions/sync (BANK-14) ───────────────────────────── */

const itemProductsSchema = z.object({
  item: z.object({
    item_id: z.string().min(1),
    products: z.array(z.string()).optional(),
    billed_products: z.array(z.string()).optional(),
    consented_products: z.array(z.string()).optional(),
  }),
});

/**
 * The item's id when it reads transactions, or null. Consented counts as well as billed:
 * Plaid adds Transactions to an item on its first `/transactions/sync`, so an item she
 * consented for in Link (`plaid:relink <bank> --add transactions`) has not been billed for
 * it until the nightly asks. An item linked for something else is never asked, because
 * asking is what adds the product and its charge.
 */
export function transactionsItem(item: unknown): string | null {
  const parsed = parse(itemProductsSchema, item);
  if (!parsed.ok) return null;
  const {
    item_id,
    products = [],
    billed_products = [],
    consented_products = [],
  } = parsed.value.item;
  const all = [...products, ...billed_products, ...consented_products];
  return all.includes('transactions') ? item_id : null;
}

const isoDate = z.iso.date();

const syncTransactionSchema = z.object({
  transaction_id: z.string().min(1),
  account_id: z.string().min(1),
  /** Positive is money out of the account, the reverse of every other row Dinora keeps. */
  amount: z.number(),
  iso_currency_code: z.string().nullable(),
  /** Posted, or for a pending one the day it happened. */
  date: isoDate,
  authorized_date: isoDate.nullable().optional(),
  name: z.string(),
  merchant_name: z.string().nullable().optional(),
  pending: z.boolean(),
});

export type PlaidTransaction = z.output<typeof syncTransactionSchema>;

const syncPageSchema = z.object({
  added: z.array(syncTransactionSchema),
  modified: z.array(syncTransactionSchema),
  removed: z.array(z.object({ transaction_id: z.string().min(1) })),
  next_cursor: z.string(),
  has_more: z.boolean(),
});

export type SyncPage = z.output<typeof syncPageSchema>;

export function parseSyncPage(input: unknown) {
  return parse(syncPageSchema, input);
}

/** One item's pages, folded: what to store, what to mark dropped, and where to ask from next. */
export type Synced = {
  readonly item: string;
  readonly cursor: string;
  readonly transactions: readonly PlaidTransaction[];
  readonly removed: readonly string[];
};

/**
 * Pages in the order Plaid sent them, into one change. A transaction added on one page and
 * modified or removed on a later one is kept as it last stood; the cursor is the last page's.
 */
export function mergeSync(item: string, pages: readonly SyncPage[]): Synced {
  const current = new Map<string, PlaidTransaction>();
  const removed = new Set<string>();
  let cursor = '';
  for (const page of pages) {
    for (const t of [...page.added, ...page.modified]) {
      current.set(t.transaction_id, t);
      removed.delete(t.transaction_id);
    }
    for (const r of page.removed) {
      current.delete(r.transaction_id);
      removed.add(r.transaction_id);
    }
    cursor = page.next_cursor;
  }
  return { item, cursor, transactions: [...current.values()], removed: [...removed] };
}

/**
 * Plaid dates a transaction by day, not by moment. Noon UTC keeps that day the same one in
 * San Diego and in Spain, where midnight would move it to the day before in San Diego; Monarch's
 * rows are placed the same way (`monarch_store`).
 */
function midday(date: string): string {
  return `${date}T12:00:00.000Z`;
}

/**
 * One of Plaid's transactions as a row, or null when its amount cannot be read exactly in its
 * currency. The sign flips, so a charge is negative and a refund positive, as SimpleFIN's are
 * and as `bank_store`'s rebuilt days need. A pending one has no posted date, as the Bridge's
 * have none; the posted transaction that replaces it arrives with its own id, and Plaid lists
 * the pending one in `removed`.
 */
function transactionRow(t: PlaidTransaction): TransactionRow | null {
  const digits = minorDigits(t.iso_currency_code ?? '');
  if (digits === null) return null;
  const amount = minorOf(t.amount, digits);
  if (!amount.ok) return null;
  const authorized = t.authorized_date ?? null;
  return {
    account_source_id: t.account_id,
    source_id: t.transaction_id,
    posted_at: t.pending ? null : midday(t.date),
    transacted_at: authorized !== null ? midday(authorized) : t.pending ? midday(t.date) : null,
    amount_minor: -amount.minor || 0,
    description: t.name,
    payee: t.merchant_name ?? null,
    memo: null,
    pending: t.pending,
  };
}

const errorSchema = z.object({
  error_type: z.string(),
  error_code: z.string(),
  error_message: z.string().optional(),
});

/**
 * Plaid's error by its codes, and its message only for `INVALID_REQUEST`, which is about the
 * request Dinora wrote, never an account. Every other message is left out, because nothing
 * promises it never quotes one. Without the message the first refusal (25 Sep, `INVALID_FIELD`
 * from `/institutions/search`) could not say which field.
 */
export function errorCode(input: unknown): string | null {
  const parsed = parse(errorSchema, input);
  if (!parsed.ok) return null;
  const { error_type, error_code, error_message } = parsed.value;
  const said =
    error_type === 'INVALID_REQUEST' && error_message !== undefined ? ` (${error_message})` : '';
  return `${error_type}/${error_code}${said}`;
}

/** Plaid's error code alone, for the few a person can act on; null for anything else. */
export function plaidCode(input: unknown): string | null {
  const parsed = parse(errorSchema, input);
  return parsed.ok ? parsed.value.error_code : null;
}

/**
 * `ITEM_LOGIN_REQUIRED` in words (UI-09). The code alone was shown on the home screen, where
 * it says what broke but not what to do; the bank's name comes from `/item/get`, which still
 * answers when `/accounts/get` refuses. A bank's name is neither an amount nor a payee
 * (invariant 4): BANK-09 already shows the Bridge's own *PSCU needs signing in again*.
 */
export function signInAgain(item: unknown, n: number): string {
  return signingIn(bankName(item, n));
}

/** The bank as the home screen names it: its name, or the item by its place. */
export function bankName(item: unknown, n: number): string {
  return institutionName(item) ?? `item ${n + 1}'s bank`;
}

const itemErrorSchema = z.object({
  item: z.object({ error: z.object({ error_code: z.string() }).nullable().optional() }),
});

/**
 * Whether `/item/get` says the item wants signing in. Plaid keeps an item's error on the item
 * once a read has met it, so this asks nothing of the bank; `/accounts/get` would ask again.
 */
export function loginRequired(item: unknown): boolean {
  const parsed = parse(itemErrorSchema, item);
  return parsed.ok && parsed.value.item.error?.error_code === 'ITEM_LOGIN_REQUIRED';
}

/**
 * What `/api/plaid/relink` answers, which the page reads (BANK-12). `open` is Plaid's Hosted
 * Link for the bank: Plaid's own page on Plaid's own origin, so no script of Plaid's runs
 * beside the rows Dinora keeps on the device. `none` is Plaid saying no bank wants signing in,
 * which happens when it was done elsewhere, and is answered by reading again. `read` and
 * `failed` are that reading: the Plaid pull run there and then, stored like a night's.
 */
export const relinkAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open'), bank: z.string(), url: z.url({ protocol: /^https$/ }) }),
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('read') }),
  z.object({ kind: z.literal('failed'), reason: z.string() }),
  z.object({ kind: z.literal('refused'), reason: z.string() }),
]);
export type RelinkAnswer = z.infer<typeof relinkAnswerSchema>;

export const relinkStepSchema = z.object({ step: z.enum(['start', 'read']) });

const hostedSchema = z.object({ hosted_link_url: z.url({ protocol: /^https$/ }) });

/** Hosted Link's address from `/link/token/create`, or null when it gave none. */
export function hostedUrl(answer: unknown): string | null {
  const parsed = parse(hostedSchema, answer);
  return parsed.ok ? parsed.value.hosted_link_url : null;
}

/** The bank's name from `/item/get`, or null when Plaid gave none. */
export function institutionName(item: unknown): string | null {
  const parsed = parse(itemSchema, item);
  const name = parsed.ok ? (parsed.value.item.institution_name ?? '') : '';
  return name === '' ? null : name;
}

/**
 * Which item `pnpm plaid:relink` means: the bank as the home screen names it, or the item by
 * its place, since that is what the home screen says when Plaid gave no name (UI-09). A name
 * must pick exactly one item: signing the wrong one in again is harmless, but it leaves the
 * broken one broken while saying it worked.
 */
export function whichItem(
  wanted: string,
  names: readonly (string | null)[],
): { ok: true; index: number } | { ok: false; reason: string } {
  const said = wanted.trim();
  const place = /^\d+$/.test(said) ? Number(said) : 0;
  if (place >= 1 && place <= names.length) return { ok: true, index: place - 1 };
  const lower = said.toLowerCase();
  const found = [...names.entries()].filter(([, n]) => n?.toLowerCase() === lower);
  const [only] = found;
  if (only !== undefined && found.length === 1) return { ok: true, index: only[0] };
  const known = names.map((n, i) => `${i + 1} ${n ?? '(no name)'}`).join(', ');
  const why = found.length > 1 ? `${found.length} items are` : 'no item is';
  return { ok: false, reason: `${why} "${said}"; say one of: ${known}` };
}
