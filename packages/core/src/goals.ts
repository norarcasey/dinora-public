import { z } from 'zod';

import type { AccountRow, Total } from './balances.ts';
import { totalsByCurrency } from './balances.ts';
import type { SnapshotRow } from './history.ts';
import type { DayKind } from './networth.ts';
import { lessSure } from './networth.ts';
import type { RateRow } from './rates.ts';
import { sumIn } from './rates.ts';
import { daysBetween } from './terms.ts';

/**
 * Goals (GOAL-01): a savings target, or a loan paid off, and how far along it is.
 *
 * Nora, 25 Sep 2026, on Monarch: *"It was really difficult to actually track my car payments
 * and mortgage payments. It ended up just being rough numbers and hard to see progress."* So a
 * goal holds no balance of its own. It names accounts, and everything shown is computed from
 * the rows the sync keeps: today's balance from `accounts`, the past from `balance_snapshots`
 * (ACCT-03), Monarch's days included (ACCT-05).
 *
 * Decided with her, 25 Sep: a saving is the accounts' whole balance against a target; a payoff
 * is measured from what the loans owed on a start day; a date is optional, and with one the
 * page says whether the pace gets there by then.
 *
 * Both kinds are one shape: a balance rising toward a line. A saving's line is its target; a
 * loan's is zero, since a loan owed is negative (BANK-01). So one rule measures the pace of
 * either, and the only difference is what the screen calls the gap.
 */

export const GOAL_KINDS = ['save', 'payoff'] as const;

export type GoalKind = (typeof GOAL_KINDS)[number];

const day = z.iso.date();

/** One goal, as PostgREST sends it and as the device keeps it. */
export const goalRowSchema = z
  .object({
    id: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
    name: z.string().min(1),
    kind: z.enum(GOAL_KINDS),
    currency: z.string().regex(/^[A-Z]{3}$/),
    // `z.int()` is a safe integer: past 2^53 a bigint column would arrive already rounded.
    target_minor: z.int().positive().nullable(),
    starts_on: day,
    target_on: day.nullable(),
    created_at: z.iso.datetime({ offset: true }),
  })
  // As `goals_target_shape` insists: a saving has a target, a payoff's is zero and unstored.
  .refine((row) => (row.kind === 'save') === (row.target_minor !== null));

export type GoalRow = z.output<typeof goalRowSchema>;

export const goalAccountRowSchema = z.object({
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  goal_id: z.string(),
  account_id: z.string(),
});

export type GoalAccountRow = z.output<typeof goalAccountRowSchema>;

/** In the order she made them: the first goal she set is the one she named first. */
export function compareGoals(a: GoalRow, b: GoalRow): number {
  return Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id);
}

export function compareGoalAccounts(a: GoalAccountRow, b: GoalAccountRow): number {
  return a.goal_id.localeCompare(b.goal_id) || a.id.localeCompare(b.id);
}

/** The live accounts a goal counts, in the order the dashboard lists accounts. */
export function accountsOf(
  goalId: string,
  links: readonly GoalAccountRow[],
  accounts: readonly AccountRow[],
): AccountRow[] {
  const linked = new Set(
    links
      .filter((link) => link.goal_id === goalId && link.deleted_at === null)
      .map((link) => link.account_id),
  );
  return accounts.filter((account) => account.deleted_at === null && linked.has(account.id));
}

/* ─── a balance on a past day ───────────────────────────────────────────────────────────── */

export type PastBalance =
  | {
      readonly kind: 'summed';
      readonly minor: bigint;
      /** The least sure of its rows: a start read from Monarch's history says so. */
      readonly sureness: DayKind;
    }
  /** Some account has no row that early. */
  | { readonly kind: 'missing' }
  /** Some currency had no rate yet that day. */
  | { readonly kind: 'unrated' };

/**
 * The accounts' balance at the end of `onDate`, each from its newest row on or before it, as
 * `netWorthByDay` carries a quiet day forward. Converted at the rate that day had, so a start
 * computed today computes the same next year (invariant 3).
 */
export function balanceOn(
  accountIds: readonly string[],
  snapshots: readonly SnapshotRow[],
  rates: readonly RateRow[],
  currency: string,
  onDate: string,
): PastBalance {
  const totals = new Map<string, { minor: bigint; accounts: number }>();
  let sureness: DayKind = 'read';
  for (const accountId of accountIds) {
    let newest: SnapshotRow | null = null;
    for (const row of snapshots) {
      if (row.deleted_at !== null || row.account_id !== accountId || row.on_date > onDate) continue;
      if (newest === null || row.on_date > newest.on_date) newest = row;
    }
    if (newest === null) return { kind: 'missing' };
    sureness = lessSure(sureness, newest.kind);
    const held = totals.get(newest.currency) ?? { minor: 0n, accounts: 0 };
    held.minor += BigInt(newest.balance_minor);
    held.accounts += 1;
    totals.set(newest.currency, held);
  }
  const list: Total[] = [...totals].map(([code, sum]) => ({ currency: code, ...sum }));
  const sum = sumIn(list, rates, currency, onDate);
  return sum.kind === 'summed'
    ? { kind: 'summed', minor: sum.minor, sureness }
    : { kind: 'unrated' };
}

/**
 * The first day every one of the accounts has a row for, or null if one has none at all. A
 * start before it would leave an account out of the start and count all of it as progress.
 */
export function firstCommonDay(
  accountIds: readonly string[],
  snapshots: readonly SnapshotRow[],
): string | null {
  let common: string | null = null;
  for (const accountId of accountIds) {
    let first: string | null = null;
    for (const row of snapshots) {
      if (row.deleted_at !== null || row.account_id !== accountId) continue;
      if (first === null || row.on_date < first) first = row.on_date;
    }
    if (first === null) return null;
    if (common === null || first > common) common = first;
  }
  return common;
}

/* ─── the pace ──────────────────────────────────────────────────────────────────────────── */

/**
 * The pace is measured over at most the last 90 days: the pace a goal is going at now, not its
 * average since 2024. A mortgage's first years, or a lump sum paid long ago, say little about
 * when it will be done. A reasoned number, not a measured one.
 */
export const PACE_WINDOW_DAYS = 90;

/**
 * Under a month, one payday or one statement moves the pace more than the habit does, and a
 * finish date drawn from it would jump from day to day. Also reasoned, not measured.
 */
export const PACE_MIN_DAYS = 30;

export type Pace =
  /** The goal's start is too recent to say. */
  | { readonly kind: 'too-early'; readonly days: number }
  /** No balance that far back, or no rate for it. */
  | { readonly kind: 'unknown' }
  /** Not moving toward the line, or moving away: no finish date can be drawn from it. */
  | { readonly kind: 'stalled'; readonly from: string; readonly movedMinor: bigint }
  | {
      readonly kind: 'moving';
      readonly from: string;
      readonly movedMinor: bigint;
      /** An average month's worth: a year's pace over twelve. */
      readonly perMonthMinor: bigint;
      /**
       * The day the line is reached at this pace; null past a century, where a date would
       * say nothing a person could plan by, and past year 9999 is not an ISO date at all.
       */
      readonly finishOn: string | null;
    };

const CENTURY_DAYS = 36_525;

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Rounded up: a finish date is the first day the line is reached, not the day before. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function perMonth(minor: bigint, days: number): bigint {
  return (minor * 365n) / (12n * BigInt(days));
}

function paceOf(
  nowMinor: bigint,
  lineMinor: bigint,
  start: string,
  today: string,
  pastOf: (onDate: string) => PastBalance,
): Pace {
  const windowStart = addDays(today, -PACE_WINDOW_DAYS);
  const from = start > windowStart ? start : windowStart;
  const days = daysBetween(from, today);
  if (days < PACE_MIN_DAYS) return { kind: 'too-early', days: Math.max(0, days) };
  const then = pastOf(from);
  if (then.kind !== 'summed') return { kind: 'unknown' };
  const movedMinor = nowMinor - then.minor;
  if (movedMinor <= 0n) return { kind: 'stalled', from, movedMinor };
  const gap = lineMinor - nowMinor;
  const daysToGo = gap <= 0n ? 0n : ceilDiv(gap * BigInt(days), movedMinor);
  return {
    kind: 'moving',
    from,
    movedMinor,
    perMonthMinor: perMonth(movedMinor, days),
    finishOn: daysToGo > BigInt(CENTURY_DAYS) ? null : addDays(today, Number(daysToGo)),
  };
}

/* ─── how far along ─────────────────────────────────────────────────────────────────────── */

export type Deadline = {
  readonly on: string;
  /** Negative once it has passed. */
  readonly daysLeft: number;
  /** What each month from now to then has to move, while it is ahead and not yet reached. */
  readonly perMonthNeededMinor: bigint | null;
  /** Null while the pace cannot be told. */
  readonly onPace: boolean | null;
};

/** Where a payoff is measured from. */
export type Start =
  | {
      readonly kind: 'owed';
      /** The day it is measured from: hers, or later when an account has no row that early. */
      readonly on: string;
      readonly moved: boolean;
      readonly owedMinor: bigint;
      readonly sureness: DayKind;
    }
  /** The loans owed nothing that day, so there is nothing to measure a share of. */
  | { readonly kind: 'nothing-owed'; readonly on: string }
  | { readonly kind: 'unknown' };

type Along = {
  readonly reached: boolean;
  /** How far there is still to go: to the target, or what is still owed. Zero once reached. */
  readonly gapMinor: bigint;
  readonly pace: Pace;
  readonly deadline: Deadline | null;
};

export type Progress =
  | { readonly kind: 'no-accounts' }
  /** Some account is in a currency with no rate into the goal's yet. */
  | { readonly kind: 'unrated' }
  | (Along & {
      readonly kind: 'save';
      readonly balanceMinor: bigint;
      readonly targetMinor: bigint;
      /** Tenths of a percent, from 0; above 1000 once past the target. */
      readonly tenths: number;
    })
  | (Along & {
      readonly kind: 'payoff';
      readonly owedMinor: bigint;
      readonly start: Start;
      /** Paid off since the start; null when the start is not known. */
      readonly paidMinor: bigint | null;
      /** Tenths of a percent of the start paid off, from 0 to 1000; null with no start. */
      readonly tenths: number | null;
    });

function tenthsOf(part: bigint, whole: bigint): number {
  return part <= 0n ? 0 : Number((part * 1000n) / whole);
}

function deadlineOf(
  goal: GoalRow,
  gap: bigint,
  pace: Pace,
  today: string,
  reached: boolean,
): Deadline | null {
  if (goal.target_on === null) return null;
  const daysLeft = daysBetween(today, goal.target_on);
  const onPace = reached
    ? true
    : pace.kind === 'moving'
      ? pace.finishOn !== null && pace.finishOn <= goal.target_on
      : pace.kind === 'stalled'
        ? false
        : null;
  return {
    on: goal.target_on,
    daysLeft,
    perMonthNeededMinor: reached || daysLeft <= 0 ? null : perMonth(gap, daysLeft),
    onPace,
  };
}

/**
 * How far along a goal is today, and at what pace. `accounts` is every account (the goal's
 * are picked by its links), `today` her own day, as a card's terms use (ACCT-10).
 */
export function progressOf(
  goal: GoalRow,
  links: readonly GoalAccountRow[],
  accounts: readonly AccountRow[],
  snapshots: readonly SnapshotRow[],
  rates: readonly RateRow[],
  today: string,
): Progress {
  const counted = accountsOf(goal.id, links, accounts);
  if (counted.length === 0) return { kind: 'no-accounts' };
  const now = sumIn(totalsByCurrency(counted), rates, goal.currency);
  if (now.kind !== 'summed') return { kind: 'unrated' };
  const ids = counted.map((account) => account.id);
  const pastOf = (onDate: string) => balanceOn(ids, snapshots, rates, goal.currency, onDate);

  // The pace is measured from her start day, or the first day every account has a row.
  const common = firstCommonDay(ids, snapshots);
  const start = common !== null && common > goal.starts_on ? common : goal.starts_on;

  if (goal.kind === 'save') {
    const targetMinor = BigInt(goal.target_minor ?? 0);
    const reached = now.minor >= targetMinor;
    const gapMinor = reached ? 0n : targetMinor - now.minor;
    const pace = paceOf(now.minor, targetMinor, start, today, pastOf);
    return {
      kind: 'save',
      balanceMinor: now.minor,
      targetMinor,
      tenths: tenthsOf(now.minor, targetMinor),
      reached,
      gapMinor,
      pace,
      deadline: deadlineOf(goal, gapMinor, pace, today, reached),
    };
  }

  const owedMinor = now.minor < 0n ? -now.minor : 0n;
  const reached = owedMinor === 0n;
  const then = common === null ? null : pastOf(start);
  const begun: Start =
    then === null || then.kind !== 'summed'
      ? { kind: 'unknown' }
      : then.minor >= 0n
        ? { kind: 'nothing-owed', on: start }
        : {
            kind: 'owed',
            on: start,
            moved: start !== goal.starts_on,
            owedMinor: -then.minor,
            sureness: then.sureness,
          };
  const paidMinor = begun.kind === 'owed' ? begun.owedMinor - owedMinor : null;
  const pace = paceOf(now.minor, 0n, start, today, pastOf);
  return {
    kind: 'payoff',
    owedMinor,
    start: begun,
    paidMinor,
    tenths:
      begun.kind === 'owed' && paidMinor !== null ? tenthsOf(paidMinor, begun.owedMinor) : null,
    reached,
    gapMinor: owedMinor,
    pace,
    deadline: deadlineOf(goal, owedMinor, pace, today, reached),
  };
}

/**
 * The start a new payoff goal is offered: the oldest day every chosen loan has a row, which
 * reaches back into Monarch's history. Today when there is none.
 */
export function defaultStart(
  accountIds: readonly string[],
  snapshots: readonly SnapshotRow[],
  today: string,
): string {
  if (accountIds.length === 0) return today;
  return firstCommonDay(accountIds, snapshots) ?? today;
}

/** `42.5%`, `100%`, `0%`: unsigned, since a share of the way there has only one direction. */
export function formatShare(tenths: number): string {
  const whole = Math.trunc(tenths / 10);
  const tenth = tenths % 10;
  return `${whole}${tenth === 0 ? '' : `.${tenth}`}%`;
}
