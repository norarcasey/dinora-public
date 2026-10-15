/**
 * What the command-line scripts read from their arguments, apart from the scripts themselves
 * so that a test can import it without running one (DIN-25).
 */
import { homedir } from 'node:os';

/** A script's answer: a value, or why there is none, in words it can print. */
export type Read<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/**
 * The value after `name`, or undefined when `name` is not given. A flag given with nothing after
 * it, or with another flag after it, is refused rather than read as absent or as that flag:
 * `--dir --production` once meant the default folder, and `--set --as skip` an account named
 * `--as`. Every value these scripts take is a path, a name, an id or a sentence, and none of
 * them starts with `--`.
 */
export function flag(argv: readonly string[], name: string): Read<string | undefined> {
  const i = argv.indexOf(name);
  if (i === -1) return { ok: true, value: undefined };
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    return { ok: false, reason: `${name} takes a value` };
  }
  return { ok: true, value };
}

/** `~` and `~/…` as the shell would have expanded them, had the path not been quoted. */
export function expandHome(path: string, home: string = homedir()): string {
  return path.replace(/^~(?=\/|$)/, home);
}
