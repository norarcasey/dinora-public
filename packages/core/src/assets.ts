import { z } from 'zod';

import type { AccountRow, Total } from './balances.ts';
import type { SnapshotRow } from './history.ts';
import { PROVIDERS } from './estimates.ts';
import { METALS } from './metals.ts';
import { daysBetween } from './terms.ts';

/**
 * Property and valuables (ACCT-06): the apartment, the car, jewelry and silver, at values
 * Nora sets, counted in net worth.
 *
 * What she disliked in Monarch, asked 25 Sep 2026 before this was designed: a value that sat
 * unchanged looked as current as one set yesterday; the home was not tied to the mortgage nor
 * the car to the auto loan, so what she owned of either never showed; and a gold bracelet
 * bought in 2022 had no way to show what it had gained. So each value keeps the day it was
 * set and turns stale with age, an asset names the loan it was bought with, and what it cost
 * and when is kept beside it.
 *
 * Each value is kept when a newer one arrives, like a card's terms (ACCT-10), so the chart
 * can draw the asset's past and a value entered by mistake can be taken back to the one
 * before.
 */

export const ASSET_KINDS = ['home', 'vehicle', 'valuables', 'crypto'] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * Which side of net worth an asset counts toward. Crypto (ACCT-21) is an investment: a holding
 * priced by a market every day, like the brokerage's funds, and nothing she lives in, drives or
 * wears. Counted as property it would move the Property tile by a coin's week and leave the
 * Investments tile short of something she holds to grow. Decided 27 Sep 2026, when the first
 * holding was added; everything else she owns is property, as ACCT-06 made it.
 */
export function assetSide(kind: AssetKind): 'property' | 'investments' {
  return kind === 'crypto' ? 'investments' : 'property';
}

const day = z.iso.date();

/** One asset, as PostgREST sends it and as the device keeps it. */
export const assetRowSchema = z
  .object({
    id: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
    name: z.string().min(1),
    kind: z.enum(ASSET_KINDS),
    currency: z.string().regex(/^[A-Z]{3}$/),
    acquired_on: day.nullable(),
    // `z.int()` is a safe integer: past 2^53 a bigint column would arrive already rounded.
    cost_minor: z.int().nonnegative().nullable(),
    financed_by: z.string().nullable(),
    // What an estimate is asked with (ACCT-11): an address for a home; a VIN, a ZIP code and
    // a dated mileage for a vehicle.
    address: z.string().nullable(),
    postal_code: z.string().nullable(),
    vin: z.string().nullable(),
    odometer_miles: z.int().nonnegative().nullable(),
    odometer_on: day.nullable(),
    // What a piece of gold or silver is valued from (ACCT-12): its weight in milligrams and its
    // purity in thousandths, all three or none.
    metal: z.enum(METALS).nullable(),
    metal_mg: z.int().positive().nullable(),
    fineness: z.int().min(1).max(1000).nullable(),
    // How much of a coin she holds (ACCT-21): both or neither, and only on crypto. The quantity
    // is decimal text, selected as `coin_quantity::text`, since a JSON number would round it.
    coin: z.string().nullable(),
    coin_quantity: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .nullable(),
  })
  // As `assets_cost_dated` insists: a cost is only a gain against the day it was paid.
  .refine((row) => row.cost_minor === null || row.acquired_on !== null);

export type AssetRow = z.output<typeof assetRowSchema>;

/**
 * Hers, Monarch's (ACCT-05), or a market estimate the nightly job read (ACCT-11) or worked out
 * from a metal's price (ACCT-12). Monarch's values for the apartment and the car were its own
 * market estimates, re-read weekly.
 */
export const VALUE_SOURCES = ['entered', 'monarch', 'estimate'] as const;

export type ValueSource = (typeof VALUE_SOURCES)[number];

export const assetValueRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  asset_id: z.string(),
  valued_on: day,
  amount_minor: z.int().nonnegative(),
  source: z.enum(VALUE_SOURCES),
  // Who made an estimate, and the range it gave around it; null on any other value.
  provider: z.enum(PROVIDERS).nullable(),
  low_minor: z.int().nonnegative().nullable(),
  high_minor: z.int().nonnegative().nullable(),
  // The quantity a Gemini value was worked out with (ACCT-21), as `coin_quantity::text`; null on
  // any other value.
  coin_quantity: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .nullable(),
  // Two values set on the same day: the later one is what she meant.
  created_at: z.iso.datetime({ offset: true }),
});

export type AssetValueRow = z.output<typeof assetValueRowSchema>;

export function compareAssets(a: AssetRow, b: AssetRow): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** Oldest first, by the day it was set, then by when it was entered. */
export function compareAssetValues(a: AssetValueRow, b: AssetValueRow): number {
  return (
    a.asset_id.localeCompare(b.asset_id) ||
    a.valued_on.localeCompare(b.valued_on) ||
    Date.parse(a.created_at) - Date.parse(b.created_at) ||
    a.id.localeCompare(b.id)
  );
}

/* ─── which value counts ────────────────────────────────────────────────────────────────── */

/**
 * The values that decide what an asset is worth, oldest first. Decided by Nora 25 Sep 2026: a
 * value she entered takes precedence over any estimate, and the estimate is shown beside it,
 * less prominently. So from the first day she set one, only hers count, however old the
 * newest of them grows while estimates arrive weekly; before it, Monarch's and the estimates
 * do, the newest winning, since both are guesses at the same market.
 *
 * Put as a filter, so that "the newest on or before a day" over what is left is the rule for
 * every day at once: the chart's carrying forward and today's value agree by construction.
 */
export function countedValues(rows: readonly AssetValueRow[]): AssetValueRow[] {
  const live = rows.filter((row) => row.deleted_at === null).toSorted(compareAssetValues);
  const firstEntered = new Map<string, string>();
  for (const row of live) {
    if (row.source === 'entered' && !firstEntered.has(row.asset_id)) {
      firstEntered.set(row.asset_id, row.valued_on);
    }
  }
  return live.filter((row) => {
    const from = firstEntered.get(row.asset_id);
    return row.source === 'entered' || from === undefined || row.valued_on < from;
  });
}

/* ─── where each stands ─────────────────────────────────────────────────────────────────── */

/**
 * Past this, a value is shown as old. Reasoned, not measured: a home's or a car's price moves
 * over months, not nights, so the bank's 36 hours would mark every value stale the day after
 * it was set; half a year is long enough that the figure is probably not what it would sell
 * for. Monarch re-estimated the apartment on 71 of its 618 days and the Civic on 14 (counted
 * 25 Sep from its balance file), about once a week and once every six weeks.
 */
export const VALUE_STALE_DAYS = 180;

export type Change = {
  /** Signed: what it is worth now less what it cost. */
  readonly minor: number;
  /** The same as a share of the cost, in tenths of a percent: 234 is 23.4%. Null at no cost. */
  readonly tenths: number | null;
};

export type Loan = {
  readonly account: AccountRow;
  /** What the loan's balance says is still owed: the bank sends it negative (BANK-01). */
  readonly owedMinor: number;
  /**
   * The value less what is owed on it. Null across currencies, which would need a rate and a
   * day for it (invariant 3) for a figure she can work out from the two beside it.
   */
  readonly equityMinor: number | null;
};

export type Standing = {
  readonly asset: AssetRow;
  /** The value that counts today: the newest of `countedValues` on or before it. */
  readonly current: AssetValueRow | null;
  /**
   * The newest estimate on or before today, shown beside `current` when that is hers, and
   * the same row as `current` when nothing of hers outranks it.
   */
  readonly estimate: AssetValueRow | null;
  /** Whole days since `current` was set. */
  readonly ageDays: number | null;
  readonly stale: boolean;
  /** Against what it cost, when she said. */
  readonly change: Change | null;
  /** The loan she said it was bought with, while that account is live. */
  readonly loan: Loan | null;
  /** Every live value, newest first: what the asset's page lists. */
  readonly history: readonly AssetValueRow[];
};

export function changeOver(valueMinor: number, costMinor: number): Change {
  const minor = valueMinor - costMinor;
  return {
    minor,
    tenths: costMinor === 0 ? null : Math.round((minor * 1000) / costMinor),
  };
}

/** `today` is her local day, `YYYY-MM-DD`: a date compares as text, day by day. */
export function standOf(
  asset: AssetRow,
  values: readonly AssetValueRow[],
  accounts: readonly AccountRow[],
  today: string,
): Standing {
  const own = values.filter((row) => row.asset_id === asset.id);
  const history = own
    .filter((row) => row.deleted_at === null)
    .toSorted((a, b) => compareAssetValues(b, a));
  const current = countedValues(own).findLast((row) => row.valued_on <= today) ?? null;
  const estimate =
    history.find((row) => row.source === 'estimate' && row.valued_on <= today) ?? null;
  const ageDays = current === null ? null : daysBetween(current.valued_on, today);
  const account =
    asset.financed_by === null
      ? undefined
      : accounts.find((row) => row.id === asset.financed_by && row.deleted_at === null);
  let loan: Loan | null = null;
  if (account !== undefined) {
    const owedMinor = Math.max(0, -account.balance_minor);
    loan = {
      account,
      owedMinor,
      equityMinor:
        current === null || account.currency !== asset.currency
          ? null
          : current.amount_minor - owedMinor,
    };
  }
  return {
    asset,
    current,
    estimate,
    ageDays,
    stale: ageDays !== null && ageDays > VALUE_STALE_DAYS,
    change:
      current === null || asset.cost_minor === null
        ? null
        : changeOver(current.amount_minor, asset.cost_minor),
    loan,
    history,
  };
}

/** Every live asset, by name. */
export function standings(
  assets: readonly AssetRow[],
  values: readonly AssetValueRow[],
  accounts: readonly AccountRow[],
  today: string,
): Standing[] {
  return assets
    .filter((asset) => asset.deleted_at === null)
    .toSorted(compareAssets)
    .map((asset) => standOf(asset, values, accounts, today));
}

/** The standings that count toward one side of net worth (`assetSide`). */
export function onSide(stood: readonly Standing[], side: 'property' | 'investments'): Standing[] {
  return stood.filter((standing) => assetSide(standing.asset.kind) === side);
}

/** What the assets are worth, one total per currency, as `totalsByCurrency` sums accounts. */
export function propertyTotals(stood: readonly Standing[]): Total[] {
  const sums = new Map<string, { minor: bigint; accounts: number }>();
  for (const { asset, current } of stood) {
    if (current === null) continue;
    const held = sums.get(asset.currency) ?? { minor: 0n, accounts: 0 };
    held.minor += BigInt(current.amount_minor);
    held.accounts += 1;
    sums.set(asset.currency, held);
  }
  return [...sums]
    .map(([currency, { minor, accounts }]) => ({ currency, minor, accounts }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Two lists of totals as one, a currency in both added together. */
export function combineTotals(a: readonly Total[], b: readonly Total[]): Total[] {
  const sums = new Map<string, Total>();
  for (const total of [...a, ...b]) {
    const held = sums.get(total.currency);
    sums.set(
      total.currency,
      held === undefined
        ? total
        : {
            currency: total.currency,
            minor: held.minor + total.minor,
            accounts: held.accounts + total.accounts,
          },
    );
  }
  return [...sums.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** `+23.4%`, `-12%`, `0%`: a change is always signed, since its direction is the news. */
export function formatChange(tenths: number): string {
  const size = Math.abs(tenths);
  const whole = Math.trunc(size / 10);
  const tenth = size % 10;
  const sign = tenths > 0 ? '+' : tenths < 0 ? '-' : '';
  return `${sign}${whole}${tenth === 0 ? '' : `.${tenth}`}%`;
}

/* ─── for the chart ─────────────────────────────────────────────────────────────────────── */

/** One asset's value from a day on, as `netWorthByDay` carries it forward. */
export type PropertyRow = {
  readonly asset_id: string;
  /** Which side of net worth it counts toward (`assetSide`). */
  readonly side: 'property' | 'investments';
  readonly on_date: string;
  readonly currency: string;
  readonly minor: number;
  readonly source: ValueSource;
};

/** Every value of every live asset that counts (`countedValues`), in the order it was set. */
export function propertyRows(
  assets: readonly AssetRow[],
  values: readonly AssetValueRow[],
): PropertyRow[] {
  const live = new Map(
    assets.filter((asset) => asset.deleted_at === null).map((asset) => [asset.id, asset]),
  );
  return countedValues(values).flatMap((row) => {
    const asset = live.get(row.asset_id);
    return asset === undefined
      ? []
      : [
          {
            asset_id: row.asset_id,
            side: assetSide(asset.kind),
            on_date: row.valued_on,
            currency: asset.currency,
            minor: row.amount_minor,
            source: row.source,
          },
        ];
  });
}

/** Rows before `start` are left out but the newest of them, which is moved to `start`. */
function startOn<Row extends { readonly on_date: string }>(
  rows: readonly Row[],
  start: string,
): Row[] {
  let carried: Row | undefined;
  for (const row of rows) {
    if (row.on_date < start && (carried === undefined || row.on_date >= carried.on_date)) {
      carried = row;
    }
  }
  const after = rows.filter((row) => row.on_date >= start);
  // First, so a figure of the day's own comes after it and wins.
  return carried === undefined ? after : [{ ...carried, on_date: start }, ...after];
}

function firstDayOf<Row extends { readonly on_date: string }>(
  rows: Iterable<Row>,
  keyOf: (row: Row) => string,
): Map<string, string> {
  const first = new Map<string, string>();
  for (const row of rows) {
    const held = first.get(keyOf(row));
    if (held === undefined || row.on_date < held) first.set(keyOf(row), row.on_date);
  }
  return first;
}

function grouped<Row>(rows: readonly Row[], keyOf: (row: Row) => string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  return groups;
}

/**
 * An asset bought with a loan, and the loan, start on the same day: the later of the asset's
 * first value and the loan's first balance. Before it, neither counts. The newest figure of
 * each before that day is carried to it, so each enters at what it stood at; older ones are
 * left out of the chart, not the database.
 *
 * Why, both ways round (Nora, 26 Sep 2026: *"the start of the loan and the start of the value
 * of the condo don't line up"*). ACCT-19: the apartment's values reached back to Jan 2025 and
 * the Harbor mortgage's balances only to 25 Sep 2026, so the chart counted the whole apartment
 * with nothing owed on it for twenty months and dropped by the mortgage the night Plaid first
 * read it. ACCT-20: Harbor's own statement then took the mortgage back to Apr 2023, which would
 * have counted the whole loan with no apartment for the twenty months before its first value.
 * Either way a spike or a trough that is neither's figure, only a difference in who kept
 * records when.
 *
 * An asset with no value, or a loan with no balance, puts no start on the other: that would
 * hide it for good.
 */
export function startTogether(
  assets: readonly AssetRow[],
  property: readonly PropertyRow[],
  snapshots: readonly SnapshotRow[],
): { readonly property: PropertyRow[]; readonly snapshots: SnapshotRow[] } {
  const live = snapshots.filter((row) => row.deleted_at === null);
  const assetFirst = firstDayOf(property, (row) => row.asset_id);
  const loanFirst = firstDayOf(live, (row) => row.account_id);
  const assetStart = new Map<string, string>();
  const loanStart = new Map<string, string>();
  for (const asset of assets) {
    if (asset.deleted_at !== null || asset.financed_by === null) continue;
    const valued = assetFirst.get(asset.id);
    const owed = loanFirst.get(asset.financed_by);
    if (valued === undefined || owed === undefined) continue;
    const start = valued > owed ? valued : owed;
    assetStart.set(asset.id, start);
    const held = loanStart.get(asset.financed_by);
    if (held === undefined || start < held) loanStart.set(asset.financed_by, start);
  }
  const shift = <Row extends { readonly on_date: string }>(
    groups: Map<string, Row[]>,
    starts: ReadonlyMap<string, string>,
  ): Row[] =>
    [...groups].flatMap(([key, rows]) => {
      const start = starts.get(key);
      return start === undefined ? rows : startOn(rows, start);
    });
  return {
    property: shift(
      grouped(property, (row) => row.asset_id),
      assetStart,
    ),
    snapshots: shift(
      grouped(live, (row) => row.account_id),
      loanStart,
    ),
  };
}
