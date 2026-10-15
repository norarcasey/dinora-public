import type { Total } from './balances.ts';
import type { Amount, Month, TransactionRow } from './budgets.ts';
import { dayOf, lastDayOf, monthOf, payeeName, payeeOf, shiftMonth } from './budgets.ts';
import { minorDigits, toMinor } from './money.ts';
import type { Conversion, RateRow } from './rates.ts';
import { NET_CURRENCY, sumIn } from './rates.ts';
import { daysBetween } from './terms.ts';

/**
 * Activity (ACCT-14): every transaction searched on the device, a payee's year, and the charges
 * that come back on a schedule.
 *
 * All of it over rows the device already holds (BUD-01 keeps every transaction there), so a
 * search asks the server nothing and works with no signal. 7,805 Monarch transactions and the
 * nightly ones on 26 Sep: small enough to scan whole on every keystroke. Measured 26 Sep on an
 * M3 Max under Node, over 8,500 made-up transactions of 600 payees: folding every row's text
 * 13ms, done once per change to the rows; a search over the folded text 0.2 to 1.3ms;
 * `findRecurring` 22ms. A phone is slower by some multiple that was not measured.
 */

/* ─── search ────────────────────────────────────────────────────────────────────────────── */

/**
 * Lower case, accents off, one space between words: `CAFÉ  Núñez` finds `cafe nunez`. Her
 * Castellana account (BANK-03) will send Spanish payees, and nobody types the accent on a phone.
 */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A transaction as a search reads it: its own words, and the words around it. */
export type Searchable = {
  readonly transaction: TransactionRow;
  readonly day: string;
  /** Its account's. */
  readonly currency: string;
  readonly accountName: string;
  /** Where it is filed; null when unsorted. */
  readonly categoryName: string | null;
};

type Word = {
  readonly text: string;
  /** What the word means as an amount, when it can be one. */
  readonly amount: { readonly whole: string; readonly fraction: string | null } | null;
};

export type Query = readonly Word[];

/**
 * Every word must be found, each anywhere: `coffee visa` is coffee on the Visa. A word that
 * reads as a number also matches an amount, whichever sign the bank gave it, so `12.50` finds
 * a charge of $12.50 and `12` finds every $12-and-change.
 */
export function parseQuery(text: string): Query {
  return fold(text)
    .split(' ')
    .filter((word) => word !== '')
    .map((word) => {
      const match = /^[$€£]?(\d+)(?:[.,](\d{1,2}))?$/.exec(word);
      const [, whole, fraction] = match ?? [];
      return {
        text: word,
        amount: whole === undefined ? null : { whole, fraction: fraction ?? null },
      };
    });
}

function amountMatches(word: Word, item: Searchable): boolean {
  if (word.amount === null) return false;
  const digits = minorDigits(item.currency) ?? 2;
  const minor = BigInt(Math.abs(item.transaction.amount_minor));
  const { whole, fraction } = word.amount;
  if (fraction === null) return minor / 10n ** BigInt(digits) === BigInt(whole);
  const wanted = toMinor(`${whole}.${fraction}`, digits);
  return wanted.ok && BigInt(wanted.minor) === minor;
}

/** The text a search looks through, folded once per row rather than once per keystroke. */
export function searchText(item: Searchable): string {
  const { transaction } = item;
  return fold(
    [
      transaction.payee ?? '',
      transaction.description,
      transaction.source_category ?? '',
      item.accountName,
      item.categoryName ?? '',
    ].join(' '),
  );
}

export function matches(query: Query, item: Searchable, text: string = searchText(item)): boolean {
  return query.every((word) => text.includes(word.text) || amountMatches(word, item));
}

export type Found = {
  /** The first `limit` found, in the order given. */
  readonly shown: readonly Searchable[];
  readonly count: number;
};

/** An empty query finds nothing: the page shows something else until she types. */
export function search(
  query: Query,
  items: readonly Searchable[],
  texts: readonly string[],
  limit: number,
): Found {
  if (query.length === 0) return { shown: [], count: 0 };
  const shown: Searchable[] = [];
  let count = 0;
  items.forEach((item, index) => {
    if (!matches(query, item, texts[index])) return;
    count += 1;
    if (shown.length < limit) shown.push(item);
  });
  return { shown, count };
}

/* ─── a payee's year ────────────────────────────────────────────────────────────────────── */

export type PayeeMonth = {
  readonly month: Month;
  /** As the bank signs it: money out is negative. */
  readonly net: Amount;
};

export type PayeeYear = {
  readonly key: string;
  /** Her words for it: the newest transaction's payee as the bank wrote it. */
  readonly name: string;
  /** Twelve months, the oldest first, ending with this one, still running. */
  readonly months: readonly PayeeMonth[];
  readonly net: Amount;
  /** Transactions in the twelve months. */
  readonly count: number;
  /** Every one of the payee's transactions, of any year, newest first. */
  readonly all: readonly { readonly transaction: TransactionRow; readonly day: string }[];
  /** Each currency converted, with the stored rate it used (invariant 3). */
  readonly conversions: readonly Conversion[];
};

/**
 * A payee's last twelve months, month by month, in `currency`. As a budget's month (BUD-01):
 * each month's total per currency converted once, at the month's last day's rate, or today's
 * for this one, so a past month reads the same next year.
 *
 * `currencies` maps each account to its currency; a transaction in an account not listed is
 * left out, as the budget leaves out an account it cannot place.
 */
export function payeeYear(
  key: string,
  transactions: readonly TransactionRow[],
  currencies: ReadonlyMap<string, string>,
  rates: readonly RateRow[],
  today: string,
  currency: string = NET_CURRENCY,
): PayeeYear | null {
  const current = monthOf(today);
  const first = shiftMonth(current, -11);
  const all: { transaction: TransactionRow; day: string }[] = [];
  const byMonth = new Map<Month, Map<string, bigint>>();
  let count = 0;
  for (const transaction of transactions) {
    const own = currencies.get(transaction.account_id);
    if (transaction.deleted_at !== null || own === undefined || payeeOf(transaction) !== key) {
      continue;
    }
    const day = dayOf(transaction, today);
    all.push({ transaction, day });
    const month = monthOf(day);
    if (month < first || month > current) continue;
    count += 1;
    const totals = byMonth.get(month) ?? new Map<string, bigint>();
    totals.set(own, (totals.get(own) ?? 0n) + BigInt(transaction.amount_minor));
    byMonth.set(month, totals);
  }
  all.sort(
    (a, b) => b.day.localeCompare(a.day) || b.transaction.id.localeCompare(a.transaction.id),
  );
  const newest = all[0];
  if (newest === undefined) return null;

  const conversions = new Map<string, Conversion>();
  const missing = new Set<string>();
  let net = 0n;
  const months: PayeeMonth[] = [];
  for (let month = first; month <= current; month = shiftMonth(month, 1)) {
    const totals: Total[] = [...(byMonth.get(month) ?? [])].map(([c, minor]) => ({
      currency: c,
      minor,
      accounts: 0,
    }));
    const last = lastDayOf(month);
    const sum = sumIn(totals, rates, currency, today < last ? today : last);
    if (sum.kind === 'unrated') {
      for (const m of sum.missing) missing.add(m);
      months.push({ month, net: sum });
      continue;
    }
    for (const c of sum.conversions) conversions.set(`${c.currency}:${c.rate.id}`, c);
    net += sum.minor;
    months.push({ month, net: { kind: 'summed', minor: sum.minor } });
  }

  return {
    key,
    name: payeeName(newest.transaction),
    months,
    net:
      missing.size > 0
        ? { kind: 'unrated', missing: [...missing] }
        : { kind: 'summed', minor: net },
    count,
    all,
    conversions: [...conversions.values()],
  };
}

/* ─── charges that come back ────────────────────────────────────────────────────────────── */

export const CADENCES = ['month', 'week', 'year'] as const;

export type Cadence = (typeof CADENCES)[number];

type Rhythm = {
  /** Days between two charges that still keep the rhythm. */
  readonly shortest: number;
  readonly longest: number;
  /** Charges in a row before it is called a rhythm and not a coincidence. */
  readonly fewest: number;
  /** How far any charge in the run may be from their median, in hundredths. */
  readonly spread: number;
  /** Days after the last charge that it is still thought to be running. */
  readonly lapsesAfter: number;
  readonly perYear: number;
};

/**
 * Written from what a charge does, not measured against her history, which had not been looked
 * at when this was (26 Sep): a month runs 28 to 31 days, and a bank that posts a day late or
 * early on a weekend moves it two more either way. Three monthly charges and not two, since two
 * a month apart at one shop is a coincidence; a yearly one needs only two, since a Monarch
 * history of about two years (ACCT-05) could never show three, and holds them to a tighter
 * amount for it. A charge more than half a period late is taken to have stopped.
 */
const RHYTHMS: Readonly<Record<Cadence, Rhythm>> = {
  month: { shortest: 26, longest: 35, fewest: 3, spread: 35, lapsesAfter: 46, perYear: 12 },
  week: { shortest: 6, longest: 8, fewest: 4, spread: 35, lapsesAfter: 11, perYear: 52 },
  year: { shortest: 350, longest: 380, fewest: 2, spread: 20, lapsesAfter: 400, perYear: 1 },
};

/** Two charges this close are one: a pending one and its posting, or a retry. */
const SAME_CHARGE_DAYS = 3;

/** A money-out transaction in an account that counts, as the budget reads one (BUD-01). */
export type Charge = {
  readonly transaction: TransactionRow;
  readonly day: string;
  readonly currency: string;
};

export type Recurrence = {
  /** The payee, normalised as a rule matches it (`payeeOf`). */
  readonly key: string;
  readonly name: string;
  readonly cadence: Cadence;
  readonly currency: string;
  /** The newest charge's amount, as the bank signs it: negative. */
  readonly amountMinor: number;
  /** About what a year of it costs, at the newest amount: positive. */
  readonly perYearMinor: number;
  /** Charges in the run that made it a rhythm. */
  readonly count: number;
  readonly last: string;
  /** When the next is expected. Before today when it is late and not yet thought stopped. */
  readonly next: string;
  readonly late: boolean;
  /** The newest charge, whose filing the page reads. */
  readonly latest: TransactionRow;
};

/**
 * One month after `day`, on the same day of the month, or the month's last when it is shorter:
 * a charge on 31 Jan is next expected on 28 Feb.
 */
export function addMonths(day: string, months: number): string {
  const month = shiftMonth(monthOf(day), months);
  const last = lastDayOf(month);
  const wanted = `${month}-${day.slice(8, 10)}`;
  return wanted > last ? last : wanted;
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function nextAfter(day: string, cadence: Cadence): string {
  if (cadence === 'week') return addDays(day, 7);
  return addMonths(day, cadence === 'month' ? 1 : 12);
}

function median(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)] ?? 0n;
}

/** Oldest first, with charges a few days apart kept as the later one. */
function occurrences(charges: readonly Charge[]): Charge[] {
  const sorted = [...charges].sort(
    (a, b) => a.day.localeCompare(b.day) || a.transaction.id.localeCompare(b.transaction.id),
  );
  const kept: Charge[] = [];
  for (const charge of sorted) {
    const previous = kept[kept.length - 1];
    if (previous !== undefined && daysBetween(previous.day, charge.day) <= SAME_CHARGE_DAYS) {
      kept[kept.length - 1] = charge;
    } else kept.push(charge);
  }
  return kept;
}

/**
 * The rhythm the newest charges keep, if any, counted back from the newest while each gap fits:
 * a subscription started in June is monthly by August, whatever the payee did before it.
 */
function rhythmOf(
  charges: readonly Charge[],
  today: string,
): { readonly cadence: Cadence; readonly run: readonly Charge[] } | null {
  const series = occurrences(charges);
  const newest = series[series.length - 1];
  if (newest === undefined) return null;
  for (const cadence of CADENCES) {
    const rhythm = RHYTHMS[cadence];
    if (daysBetween(newest.day, today) > rhythm.lapsesAfter) continue;
    let start = series.length - 1;
    while (start > 0) {
      const earlier = series[start - 1];
      const later = series[start];
      if (earlier === undefined || later === undefined) break;
      const gap = daysBetween(earlier.day, later.day);
      if (gap < rhythm.shortest || gap > rhythm.longest) break;
      start -= 1;
    }
    const run = series.slice(start);
    if (run.length < rhythm.fewest) continue;
    const amounts = run.map((c) => BigInt(-c.transaction.amount_minor));
    const middle = median(amounts);
    const steady = amounts.every(
      (a) => (a > middle ? a - middle : middle - a) * 100n <= middle * BigInt(rhythm.spread),
    );
    if (steady) return { cadence, run };
  }
  return null;
}

/**
 * A payee's charges split by amount, for a payee that bills two things on two rhythms: an
 * App Store's $2.99 and $10.99 each monthly read as a charge every fortnight together. A new
 * group starts where an amount is more than 40% above the smallest in the one before.
 */
function byAmount(charges: readonly Charge[]): Charge[][] {
  const sorted = [...charges].sort(
    (a, b) => b.transaction.amount_minor - a.transaction.amount_minor,
  );
  const groups: Charge[][] = [];
  let floor = 0;
  for (const charge of sorted) {
    const size = -charge.transaction.amount_minor;
    const group = groups[groups.length - 1];
    if (group === undefined || size * 100 > floor * 140) {
      groups.push([charge]);
      floor = size;
    } else group.push(charge);
  }
  return groups;
}

/**
 * The charges that come back on a schedule and have not stopped, the soonest expected first.
 * Grouped by payee and currency; a payee whose charges keep no rhythm together is tried again
 * split by amount (`byAmount`), so one payee can recur twice.
 */
export function findRecurring(charges: readonly Charge[], today: string): Recurrence[] {
  const byPayee = new Map<string, Charge[]>();
  for (const charge of charges) {
    const { transaction } = charge;
    if (transaction.deleted_at !== null || transaction.amount_minor >= 0) continue;
    const key = payeeOf(transaction);
    if (key === '') continue;
    const group = `${key}\u0000${charge.currency}`;
    const held = byPayee.get(group);
    if (held === undefined) byPayee.set(group, [charge]);
    else held.push(charge);
  }

  const found: Recurrence[] = [];
  for (const group of byPayee.values()) {
    const whole = rhythmOf(group, today);
    const rhythms =
      whole !== null
        ? [whole]
        : byAmount(group).flatMap((part) => {
            const rhythm = rhythmOf(part, today);
            return rhythm === null ? [] : [rhythm];
          });
    for (const { cadence, run } of rhythms) {
      const newest = run[run.length - 1];
      if (newest === undefined) continue;
      const next = nextAfter(newest.day, cadence);
      found.push({
        key: payeeOf(newest.transaction),
        name: payeeName(newest.transaction),
        cadence,
        currency: newest.currency,
        amountMinor: newest.transaction.amount_minor,
        perYearMinor: -newest.transaction.amount_minor * RHYTHMS[cadence].perYear,
        count: run.length,
        last: newest.day,
        next,
        late: next < today,
        latest: newest.transaction,
      });
    }
  }
  return found.sort((a, b) => a.next.localeCompare(b.next) || a.name.localeCompare(b.name));
}
