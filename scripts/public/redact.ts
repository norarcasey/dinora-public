/**
 * What the public export decides, apart from how it copies (DIN-12). `export.ts` beside this
 * does the files and the git; this is the part that has to be right, so it is tested.
 *
 * Why redact a copy rather than scrub this repository (Nora, 13 Oct 2026, choosing a fresh
 * public repo of one commit): her lender, employer, banks, account digits, car, ZIP and the
 * figures they were measured against run through tests, comments and three append-only
 * migrations, and through 203 commits of history. The comments are the argument of each
 * decision and are worth keeping true here. So this repository stays private and keeps them;
 * the public one is a snapshot of HEAD with each private term swapped for a stand-in.
 *
 * The map of terms is the one thing that cannot be committed, since it is a list of exactly
 * what must not be public. It lives in `.env.public-redactions`, which `.gitignore` already
 * ignores and `.worktreeinclude` already copies into a worktree, beside the credentials.
 *
 * Everything here fails closed: a term that survives, a secret-shaped string or a migration
 * whose SQL would change is a refused export, never a warning.
 */

export type Redaction = { readonly from: string; readonly to: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * `.env.public-redactions`: one `term => stand-in` a line, `#` for comments. A stand-in may be
 * empty, which deletes the term. Each case a term is written in is its own line, because the
 * survivors check is case-blind and will name the one that was forgotten.
 */
export function parseRedactions(text: string): Parsed<Redaction[]> {
  const redactions: Redaction[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const arrow = line.indexOf('=>');
    if (arrow === -1) return { ok: false, reason: `line ${index + 1} has no "=>"` };
    const from = line.slice(0, arrow).trim();
    const to = line.slice(arrow + 2).trim();
    if (from === '') return { ok: false, reason: `line ${index + 1} has no term before "=>"` };
    if (redactions.some((r) => r.from === from)) {
      return { ok: false, reason: `line ${index + 1} repeats a term` };
    }
    // A stand-in that contains a term would put it straight back, and the survivors check
    // would then refuse every export for a reason that is the map's, not the code's.
    if (to.toLowerCase().includes(from.toLowerCase())) {
      return { ok: false, reason: `line ${index + 1}'s stand-in contains its own term` };
    }
    redactions.push({ from, to });
  }
  if (redactions.length === 0) return { ok: false, reason: 'it lists no terms' };
  return { ok: true, value: redactions };
}

/**
 * Longest term first, so `Harbor Mortgage => Harbor Mortgage` is replaced before `Harbor =>
 * Harbor` gets to it. Literal, case-sensitive replacement: a term means exactly that text.
 */
export function redact(text: string, redactions: readonly Redaction[]): string {
  const ordered = [...redactions].sort((a, b) => b.from.length - a.from.length);
  return ordered.reduce((out, { from, to }) => out.split(from).join(to), text);
}

/** The terms still in `text`, in any case: a variant the map missed, by name. */
export function survivors(text: string, redactions: readonly Redaction[]): string[] {
  const lower = text.toLowerCase();
  return redactions.filter(({ from }) => lower.includes(from.toLowerCase())).map((r) => r.from);
}

/**
 * Shapes no tracked file should ever have, so one in the export is a credential that got in.
 * Measured 13 Oct 2026 against all 203 commits: none of these matches anything but the test
 * values listed in `SAFE`, which is why a match is a refusal rather than a question.
 */
const SECRETS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'a JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: 'a PEM private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'a Supabase secret key', pattern: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: 'a Supabase access token', pattern: /\bsbp_[A-Za-z0-9]{20,}/ },
  { name: 'a GitHub token', pattern: /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|\bgithub_pat_\w{20,}/ },
  { name: 'an AWS key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a Stripe key', pattern: /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}/ },
  { name: 'a Plaid access token', pattern: /\baccess-(production|development)-[0-9a-f-]{20,}/ },
  { name: 'a Vercel token', pattern: /\bVERCEL_(OIDC_)?TOKEN=\S{20,}/ },
  { name: 'a credential in a URL', pattern: /https?:\/\/[^\s/:@'"`]+:[^\s/@'"`]+@[^\s/'"`]+/g },
];

/**
 * The credentials-in-a-URL the code holds on purpose: test hosts that resolve nowhere, the
 * escaped userinfo a parser test reads, SimpleFIN's published demo account, and the
 * `user:pass@host` a comment uses to describe the shape.
 */
const SAFE =
  /^https?:\/\/([^@]+@([a-z0-9.-]+\.test|beta-bridge\.simplefin\.org)\b|user:pass@host\b)/;

export function secrets(text: string): string[] {
  const found: string[] = [];
  for (const { name, pattern } of SECRETS) {
    const all = pattern.global ? [...text.matchAll(pattern)] : [pattern.exec(text)];
    if (all.some((m) => m !== null && !SAFE.test(m[0]))) found.push(name);
  }
  return found;
}

/**
 * Whether a migration changed only in its comments. Migrations are append-only (invariant 7)
 * and the public copy must create exactly the schema this one does, so a term found in SQL
 * itself — a table, a value, a policy — is a refusal: it needs a person, not a find-replace.
 */
export function commentsOnly(before: string, after: string): Parsed<null> {
  const was = before.split('\n');
  const is = after.split('\n');
  if (was.length !== is.length) return { ok: false, reason: 'its line count changed' };
  for (const [index, line] of was.entries()) {
    const now = is[index] ?? '';
    if (line === now) continue;
    const at = line.indexOf('--');
    if (at === -1 || line.slice(0, at) !== now.slice(0, at) || !now.startsWith('--', at)) {
      return { ok: false, reason: `line ${index + 1} changed outside a comment` };
    }
  }
  return { ok: true, value: null };
}
