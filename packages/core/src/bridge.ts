import type { PropertyRow } from './assets.ts';
import type { Total } from './balances.ts';
import type { Side } from './groups.ts';
import type { SnapshotRow } from './history.ts';
import type { DayKind } from './networth.ts';
import { lessSure, SIDES } from './networth.ts';
import type { Conversion, RateRow } from './rates.ts';
import { convertAt, NET_CURRENCY, rateBetween, sumIn } from './rates.ts';

/**
 * What changed this month (ACCT-13): the walk from net worth at the end of last month to net
 * worth on the history's last day, as one part per side, so the parts and the two ends always
 * add up to the cent.
 *
 * From `balance_snapshots` and the assets' values alone, the same rows the chart reads, so
 * each end is the chart's figure for that day. A balance is all a snapshot holds: a market's
 * move and a contribution are one number until holdings are read (BANK-04), so the part says
 * *investments*, never *returns*.
 *
 * Three parts are not sides, and each exists so a side's figure means only what it says:
 *
 * - **Newly counted.** An account or asset with no figure at the opening day. Linking an
 *   account, or valuing the bracelet for the first time, is not a month in which she gained its
 *   whole balance, and in its side it would read as one.
 * - **Not in a group.** Accounts whose side is unknown. They count toward the net and toward no
 *   side, as they do in the tiles and the chart.
 * - **Exchange rate.** Each side's change is converted at the closing day's rate; what the
 *   rate's move did to what was already held is what is left of the difference between the two
 *   ends (invariant 3: each end at its own day's rate). It also takes the rounding — at most
 *   half a cent per currency per part — which is what lets the parts sum exactly. With every
 *   figure in dollars it is zero and is left out.
 *
 * A change is the account's own, counted from the newest row on or before each end, as the
 * chart carries a balance forward.
 */

export type BridgePartKind = Side | 'rate' | 'unsided' | 'new';

export type Member = {
  readonly kind: 'account' | 'asset';
  readonly id: string;
  readonly currency: string;
  /** In its own currency: the change over the month, or for `new`, its figure at the close. */
  readonly minor: bigint;
};

export type BridgePart = {
  readonly part: BridgePartKind;
  /** In the bridge's currency, signed as the net is: debt paid down is positive. */
  readonly minor: bigint;
  /** Largest change first, in the bridge's currency; none for `rate`. */
  readonly members: readonly Member[];
};

export type BridgeEnd = {
  readonly on_date: string;
  readonly minor: bigint;
  /** How sure the end's figure is, as the chart would draw that day. */
  readonly kind: DayKind;
  /** One per currency converted, at that day's rate (invariant 3). */
  readonly conversions: readonly Conversion[];
};

export type Bridge = {
  readonly currency: string;
  readonly from: BridgeEnd;
  readonly to: BridgeEnd;
  /** Every side that has anything in it, in the chart's order; the other three when not zero. */
  readonly parts: readonly BridgePart[];
};

/** The last day of the month before `isoDate`'s: 31 Aug for anything in September. */
export function endOfLastMonth(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7)) - 1;
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

type Held = {
  readonly kind: Member['kind'];
  readonly id: string;
  readonly part: Side | null;
  /** Oldest first. */
  readonly rows: readonly { readonly on_date: string; readonly figure: Figure }[];
};

type Figure = { readonly currency: string; readonly minor: number; readonly kind: DayKind };

function on(held: Held, day: string): Figure | null {
  let found: Figure | null = null;
  for (const row of held.rows) {
    // ISO dates: lexical order is date order.
    if (row.on_date > day) break;
    found = row.figure;
  }
  return found;
}

class Totals {
  readonly #sums = new Map<string, { minor: bigint; accounts: number }>();

  add(currency: string, minor: bigint): void {
    const held = this.#sums.get(currency) ?? { minor: 0n, accounts: 0 };
    held.minor += minor;
    held.accounts += 1;
    this.#sums.set(currency, held);
  }

  get list(): Total[] {
    return [...this.#sums].map(([currency, sum]) => ({ currency, ...sum }));
  }
}

/**
 * The month that holds the history's last day, from the day before it began; or from the
 * history's first day, when that is later. Null with no history, a single day of it, or any
 * figure in a currency with no rate at either end: a bridge left unsaid rather than short.
 *
 * `accounts` and `property` are as `netWorthByDay` takes them.
 */
export function monthBridge(
  snapshots: readonly SnapshotRow[],
  accounts: ReadonlyMap<string, Side | null>,
  rates: readonly RateRow[],
  property: readonly PropertyRow[] = [],
  currency = NET_CURRENCY,
): Bridge | null {
  const byAccount = new Map<string, SnapshotRow[]>();
  let first: string | null = null;
  let last: string | null = null;
  for (const row of snapshots) {
    if (row.deleted_at !== null || !accounts.has(row.account_id)) continue;
    byAccount.set(row.account_id, [...(byAccount.get(row.account_id) ?? []), row]);
    if (first === null || row.on_date < first) first = row.on_date;
    if (last === null || row.on_date > last) last = row.on_date;
  }
  if (first === null || last === null) return null;
  const opening = endOfLastMonth(last) < first ? first : endOfLastMonth(last);
  if (opening >= last) return null;

  const held: Held[] = [];
  for (const [id, rows] of byAccount) {
    held.push({
      kind: 'account',
      id,
      part: accounts.get(id) ?? null,
      rows: rows
        .toSorted((a, b) => a.on_date.localeCompare(b.on_date))
        .map((row) => ({
          on_date: row.on_date,
          figure: { currency: row.currency, minor: row.balance_minor, kind: row.kind },
        })),
    });
  }
  const byAsset = new Map<string, PropertyRow[]>();
  for (const row of property)
    byAsset.set(row.asset_id, [...(byAsset.get(row.asset_id) ?? []), row]);
  for (const [id, rows] of byAsset) {
    held.push({
      kind: 'asset',
      id,
      part: rows[0]?.side ?? 'property',
      // In the order they were set (`propertyRows`), which is the order that counts.
      rows: rows.map((row) => ({
        on_date: row.on_date,
        figure: {
          currency: row.currency,
          minor: row.minor,
          kind: row.source === 'monarch' ? 'monarch' : 'read',
        },
      })),
    });
  }

  const fromTotals = new Totals();
  const toTotals = new Totals();
  let fromKind: DayKind = 'read';
  let toKind: DayKind = 'read';
  const changes = new Map<Exclude<BridgePartKind, 'rate'>, { totals: Totals; members: Member[] }>();
  const into = (part: Exclude<BridgePartKind, 'rate'>) => {
    const entry = changes.get(part) ?? { totals: new Totals(), members: [] };
    changes.set(part, entry);
    return entry;
  };
  for (const thing of held) {
    const start = on(thing, opening);
    const end = on(thing, last);
    if (end === null) continue;
    toTotals.add(end.currency, BigInt(end.minor));
    toKind = lessSure(toKind, end.kind);
    if (start === null) {
      const entry = into('new');
      entry.totals.add(end.currency, BigInt(end.minor));
      entry.members.push({
        kind: thing.kind,
        id: thing.id,
        currency: end.currency,
        minor: BigInt(end.minor),
      });
      continue;
    }
    fromTotals.add(start.currency, BigInt(start.minor));
    fromKind = lessSure(fromKind, start.kind);
    // An account's currency does not change, so the two ends are in one.
    const change = BigInt(end.minor) - BigInt(start.minor);
    const entry = into(thing.part ?? 'unsided');
    entry.totals.add(end.currency, change);
    entry.members.push({ kind: thing.kind, id: thing.id, currency: end.currency, minor: change });
  }

  const from = sumIn(fromTotals.list, rates, currency, opening);
  const to = sumIn(toTotals.list, rates, currency, last);
  if (from.kind === 'unrated' || to.kind === 'unrated') return null;

  const inCurrency = (member: Member): bigint => {
    if (member.currency === currency) return member.minor;
    // Either way round: in euros the only row is the ECB's EUR→USD, read backwards (DIN-10).
    const rate = rateBetween(rates, member.currency, currency, last);
    return rate === null ? 0n : (convertAt(member.minor, member.currency, currency, rate) ?? 0n);
  };
  const size = (minor: bigint) => (minor < 0n ? -minor : minor);

  const parts: BridgePart[] = [];
  let counted = 0n;
  const ordered: readonly Exclude<BridgePartKind, 'rate'>[] = [...SIDES, 'unsided', 'new'];
  for (const part of ordered) {
    const entry = changes.get(part);
    if (entry === undefined) continue;
    // Every currency in it is in one of the ends, which both converted: this cannot be unrated.
    const sum = sumIn(entry.totals.list, rates, currency, last);
    const minor = sum.kind === 'summed' ? sum.minor : 0n;
    counted += minor;
    const members = entry.members
      .map((member) => ({ member, size: size(inCurrency(member)) }))
      .toSorted((a, b) => (a.size === b.size ? 0 : a.size > b.size ? -1 : 1))
      .map(({ member }) => member);
    parts.push({ part, minor, members });
  }
  // All in one currency, the parts are exact and this is zero, so it is only said with another.
  if (from.conversions.length > 0 || to.conversions.length > 0) {
    const rate = to.minor - from.minor - counted;
    const at = parts.findIndex((p) => p.part === 'unsided' || p.part === 'new');
    parts.splice(at === -1 ? parts.length : at, 0, { part: 'rate', minor: rate, members: [] });
  }

  return {
    currency,
    from: { on_date: opening, minor: from.minor, kind: fromKind, conversions: from.conversions },
    to: { on_date: last, minor: to.minor, kind: toKind, conversions: to.conversions },
    parts,
  };
}

/**
 * What the month did to what was already counted at its start: every part but `new`. This is
 * the month's figure, not the difference of the two ends. Seen on 26 Sep with a mortgage linked
 * through Plaid that month (BANK-07): the ends said −$214,880 of a month that gained $3,400,
 * and the new part drew every other bar a pixel wide.
 */
export function likeForLike(bridge: Bridge): bigint {
  return bridge.parts.reduce((sum, p) => (p.part === 'new' ? sum : sum + p.minor), 0n);
}

export type Step = { readonly part: BridgePart; readonly before: bigint; readonly after: bigint };

/**
 * Each part as a step of the walk from the opening figure, which is zero: where a bar is drawn.
 * `new` is not a step, for the reason `likeForLike` gives.
 */
export function stepsOf(bridge: Bridge): Step[] {
  const steps: Step[] = [];
  let at = 0n;
  for (const part of bridge.parts) {
    if (part.part === 'new') continue;
    steps.push({ part, before: at, after: at + part.minor });
    at += part.minor;
  }
  return steps;
}
