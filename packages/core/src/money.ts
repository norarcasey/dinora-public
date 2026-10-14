/**
 * Decimal strings into integer minor units (invariant 1), without passing through a float.
 *
 * Aggregators send amounts as decimal strings — SimpleFIN's demo sends `"-05.50"` and
 * `"00.00"`, leading zeros and all (fetched 24 Sep 2026) — and `Number("0.1") * 100` is
 * already wrong in the last place. So the digits are joined as text and read once, as an
 * integer, which is exact up to 2^53 minor units: ninety trillion dollars.
 */

/**
 * ISO 4217 currencies whose minor unit is not two digits. Every other three-letter code is
 * taken as two, which is what ISO assigns to nearly all of them — and both currencies Dinora
 * is for, USD and EUR.
 */
const EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

/** The minor unit's digits for an ISO 4217 code, or null for anything that is not one. */
export function minorDigits(currency: string): number | null {
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return EXPONENTS[currency] ?? 2;
}

export type Minor = { readonly ok: true; readonly minor: number } | { readonly ok: false };

/**
 * `"-05.50"` in USD is -550. Refused rather than rounded: more fractional digits than the
 * currency has, unless the extra ones are zeros — a total silently rounded is the drift
 * invariant 1 exists to prevent. The failure carries no detail on purpose: the caller's
 * message must not quote the amount (invariant 4), so there is nothing here to quote.
 */
export function toMinor(decimal: string, digits: number): Minor {
  const match = /^([+-])?(\d+)(?:\.(\d*))?$/.exec(decimal.trim());
  if (match === null) return { ok: false };
  const [, sign, whole = '', fraction = ''] = match;
  const extra = fraction.slice(digits);
  if (/[^0]/.test(extra)) return { ok: false };
  const units = Number(whole + fraction.slice(0, digits).padEnd(digits, '0'));
  if (!Number.isSafeInteger(units)) return { ok: false };
  // `|| 0` so that "-0.00" is 0 rather than -0, which prints and compares oddly.
  return { ok: true, minor: (sign === '-' ? -units : units) || 0 };
}
