import { z } from 'zod';

import { minorDigits, toMinor } from './money.ts';

/**
 * A card's terms (ACCT-10): its credit limit, cash-advance limit, purchase APR and any promo
 * APR, as Nora enters them from a statement.
 *
 * Entered, because no bank sends them: on 25 Sep 2026 none of the 20 linked accounts carried
 * SimpleFIN's `extra`, and `available-balance` was zero on every account owing money, so a
 * limit cannot be derived from it either (the migration has the measurement).
 *
 * Each figure is dated by the day it took effect and kept when a newer one arrives, so the
 * one in force on a day is the newest that had started by then, and a change she enters
 * ahead of time — a rate going up next month — waits as the next one rather than replacing
 * today's early.
 */

export const TERM_KINDS = [
  'credit_limit',
  'cash_advance_limit',
  'purchase_apr',
  'promo_apr',
] as const;

export type TermKind = (typeof TERM_KINDS)[number];

const day = z.iso.date();

const base = {
  id: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  account_id: z.string(),
  effective_on: day,
};

/**
 * One row, as PostgREST sends it and as the device keeps it. Each kind carries exactly its
 * own columns, as `account_terms_shape` insists, so a limit is never read as a rate.
 */
export const termRowSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.enum(['credit_limit', 'cash_advance_limit']),
    // `z.int()` is a safe integer: past 2^53 a bigint column would arrive already rounded.
    amount_minor: z.int().nonnegative(),
    rate_bp: z.null(),
    ends_on: z.null(),
  }),
  z.object({
    ...base,
    kind: z.literal('purchase_apr'),
    amount_minor: z.null(),
    rate_bp: z.int().min(0).max(10_000),
    ends_on: z.null(),
  }),
  z.object({
    ...base,
    kind: z.literal('promo_apr'),
    amount_minor: z.null(),
    rate_bp: z.int().min(0).max(10_000),
    ends_on: day,
  }),
]);

export type TermRow = z.output<typeof termRowSchema>;

export function compareTerms(a: TermRow, b: TermRow): number {
  return (
    a.account_id.localeCompare(b.account_id) ||
    a.effective_on.localeCompare(b.effective_on) ||
    a.id.localeCompare(b.id)
  );
}

/* ─── what she types ────────────────────────────────────────────────────────────────────── */

/**
 * `"$12,500"` in USD is 1250000. Currency signs, commas and spaces are dropped; the rest goes
 * through `toMinor`, so a limit is exact or refused, never rounded. A limit cannot be
 * negative.
 */
export function parseLimit(text: string, currency: string): number | null {
  const digits = minorDigits(currency);
  if (digits === null) return null;
  const parsed = toMinor(text.replace(/[\s,$€£]/g, ''), digits);
  return parsed.ok && parsed.minor >= 0 ? parsed.minor : null;
}

/**
 * `"24.99%"` is 2499: hundredths of a percent, read as text so it never becomes a float.
 * Issuers print APRs to two places; a third, unless it is a zero, is refused rather than
 * rounded. Between 0 and 100%.
 */
export function parseRate(text: string): number | null {
  const parsed = toMinor(text.replace(/[\s%]/g, ''), 2);
  return parsed.ok && parsed.minor >= 0 && parsed.minor <= 10_000 ? parsed.minor : null;
}

/** 2499 is `24.99%`, 2450 is `24.5%`, 0 is `0%`: as short as it is exact. */
export function formatRate(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${whole}${fraction === '' ? '' : `.${fraction}`}%`;
}

/* ─── what is in force ──────────────────────────────────────────────────────────────────── */

export type Figure = {
  /** The newest that had taken effect by today. */
  readonly current: TermRow | null;
  /** The soonest entered for a day still to come. */
  readonly next: TermRow | null;
};

export type CardTerms = {
  readonly figures: Readonly<Record<TermKind, Figure>>;
  /** Every live row for the account, newest first: what the history list shows. */
  readonly history: readonly TermRow[];
};

/** `today` is her local day, `YYYY-MM-DD`: a date compares as text, day by day. */
export function cardTerms(rows: readonly TermRow[], accountId: string, today: string): CardTerms {
  const live = rows
    .filter((row) => row.account_id === accountId && row.deleted_at === null)
    .toSorted((a, b) => compareTerms(b, a));
  const figure = (kind: TermKind): Figure => {
    const own = live.filter((row) => row.kind === kind);
    return {
      current: own.find((row) => row.effective_on <= today) ?? null,
      next: own.findLast((row) => row.effective_on > today) ?? null,
    };
  };
  return {
    figures: {
      credit_limit: figure('credit_limit'),
      cash_advance_limit: figure('cash_advance_limit'),
      purchase_apr: figure('purchase_apr'),
      promo_apr: figure('promo_apr'),
    },
    history: live,
  };
}

/** A limit's amount, or null for a row of another kind. */
export function limitOf(row: TermRow | null): number | null {
  return row !== null && (row.kind === 'credit_limit' || row.kind === 'cash_advance_limit')
    ? row.amount_minor
    : null;
}

/* ─── what a limit leaves ───────────────────────────────────────────────────────────────── */

export type Headroom = {
  /** The limit less what is owed. A card in credit has more than its limit. */
  readonly availableMinor: number;
  /** What is owed as a share of the limit, in tenths of a percent: 234 is 23.4%. */
  readonly usedTenths: number;
};

/**
 * Against a card's balance as the bank sends it: negative when owed (BANK-01), so what is
 * left is the limit plus the balance. A limit of zero leaves no share to speak of.
 */
export function headroom(balanceMinor: number, limitMinor: number): Headroom | null {
  if (limitMinor <= 0) return null;
  const owed = Math.max(0, -balanceMinor);
  return {
    availableMinor: limitMinor + balanceMinor,
    usedTenths: Math.round((owed * 1000) / limitMinor),
  };
}

/** 234 is `23.4%`. */
export function formatTenths(tenths: number): string {
  const whole = Math.trunc(tenths / 10);
  const tenth = tenths % 10;
  return tenth === 0 ? `${whole}%` : `${whole}.${tenth}%`;
}

/* ─── a promo's clock ───────────────────────────────────────────────────────────────────── */

/** Within this many days of its end, a promo says so in the warning colour. */
export const PROMO_WARNING_DAYS = 30;

export type PromoState =
  | { readonly kind: 'running'; readonly daysLeft: number; readonly endingSoon: boolean }
  | { readonly kind: 'ended' };

/** Days from one `YYYY-MM-DD` to another, whole: both read as UTC midnights. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A promo runs until the day before `ends_on`, the day the card's own rate is back. */
export function promoState(endsOn: string, today: string): PromoState {
  const daysLeft = daysBetween(today, endsOn);
  if (daysLeft <= 0) return { kind: 'ended' };
  return { kind: 'running', daysLeft, endingSoon: daysLeft <= PROMO_WARNING_DAYS };
}
