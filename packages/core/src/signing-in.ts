/**
 * A bank that wants signing in again, in the words the home screen shows and recognises. One
 * phrase for both aggregators: Plaid's pull writes it (UI-09) and, since BANK-13, so does
 * SimpleFIN's, for the Bridge's `con.auth`. A warning is kept only as words — `bank_pulls`
 * has a detail and no codes — so these words are how the home screen knows to offer a fix.
 */
const SIGN_IN_AGAIN = ' needs signing in again';

export function signingIn(bank: string): string {
  return `${bank}${SIGN_IN_AGAIN}`;
}

export function wantsSignIn(detail: string): boolean {
  return detail.endsWith(SIGN_IN_AGAIN);
}
