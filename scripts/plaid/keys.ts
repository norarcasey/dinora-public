/**
 * What the Plaid commands (`cli.ts`) read from `.env.plaid` and from their arguments, apart
 * from them so a test can import it without running one (DIN-25). The file holds the keys and
 * every access token: a mis-read line there is a token lost or sent to the wrong item.
 */
import type { PlaidKeys } from '../../api/_lib/plaid.ts';
import { plaidEnv, wellFormed } from '../../api/_lib/plaid.ts';
import type { ReadProduct } from '../../packages/core/src/plaid.ts';
import { READ_PRODUCTS, readProduct } from '../../packages/core/src/plaid.ts';
import type { Read } from '../argv.ts';

/** `KEY=value` lines; `#` starts a comment. A key written twice is its last value. */
export function readCredentials(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0 && !line.startsWith('#')) found.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  return found;
}

/** `file` names the file in what is printed, never what is in it. */
export function readKeys(found: ReadonlyMap<string, string>, file: string): Read<PlaidKeys> {
  const clientId = found.get('PLAID_CLIENT_ID');
  const secret = found.get('PLAID_SECRET');
  const env = plaidEnv(found.get('PLAID_ENV') ?? '');
  if (clientId === undefined || secret === undefined || env === null) {
    return { ok: false, reason: `no keys in ${file}. Keep them first: pnpm plaid:keys` };
  }
  if (!wellFormed(clientId, secret)) {
    return { ok: false, reason: `the keys in ${file} are not Plaid's form.` };
  }
  return { ok: true, value: { clientId, secret, env } };
}

export type Item = { readonly product: string; readonly token: string };

const ITEM = /^PLAID_ITEM_(\d+)$/;

/** Each linked item, `PLAID_ITEM_<n>=<product> <access token>`, in the order they were kept. */
export function items(found: ReadonlyMap<string, string>): Item[] {
  return [...found]
    .filter(([k]) => ITEM.test(k))
    .map(([, v]) => {
      const [product = '', token = ''] = v.split(' ');
      return { product, token };
    });
}

/**
 * The `<n>` the next linked item is kept under: one past the highest, not one past the count.
 * With item 2 removed by hand, a count would name the next one 3 again, and the line after it
 * would hide item 3's token, since a key written twice is its last value.
 */
export function nextItem(found: ReadonlyMap<string, string>): number {
  const taken = [...found.keys()].map((k) => Number(ITEM.exec(k)?.[1] ?? 0));
  return Math.max(0, ...taken) + 1;
}

export type RelinkArgs = { readonly wanted: string; readonly adding: ReadProduct | null };

/** `relink <bank | n> [--add <product>]`: the bank in any words, and the read to ask for. */
export function relinkArgs(args: readonly string[]): Read<RelinkArgs> {
  const at = args.indexOf('--add');
  if (at === -1) return { ok: true, value: { wanted: args.join(' ').trim(), adding: null } };
  const adding = readProduct(args[at + 1] ?? '');
  if (adding === null) {
    return { ok: false, reason: `--add takes one of: ${READ_PRODUCTS.join(', ')}` };
  }
  const wanted = [...args.slice(0, at), ...args.slice(at + 2)].join(' ').trim();
  return { ok: true, value: { wanted, adding } };
}
