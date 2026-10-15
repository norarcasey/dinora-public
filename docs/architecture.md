# How Dinora is built

The rules the code is held to, what it will not do, how the repository is laid out, and the
conventions every file follows. Comments throughout cite these by number: "invariant 4" is the
fourth below.

## Invariants

The short list. Violating one is a bug even if every test passes. Each says why it exists.

1. **Amounts are integer minor units, never floats.** Floats drift by cents over a sum, and a
   total that disagrees with the bank's by a cent is a total nobody trusts again.
2. **Nothing is ever hard-deleted.** A sync that runs again, or a delete made by mistake, must
   never lose history — history is the point of the app. Owned tables carry `deleted_at`,
   and removing a row is setting it, for her as for the sync: neither `authenticated` nor
   `service_role` holds DELETE or TRUNCATE on any table, and `pnpm db:verify` checks both.
3. **Every currency conversion stores the rate it used and the date of that rate.** A total in
   dollars over euro accounts has to reproduce later: last March in USD must not move because
   today's rate did.
4. **No amounts and no payees in any log.** Logs leave the database's protections — Vercel's log
   viewer, an error message, a CI run — and a list of payees is a diary.
5. **Dinora never holds a credential or consent that can move money.** Read-only access at every
   aggregator, so the worst a breach of this app can cost is privacy, never a balance.
6. **Row-level security on every table, forced, default deny, with the policy in the same
   migration as the table.** Written from `supabase/patterns/owned_table.sql`; `pnpm db:verify`
   checks every table in public against it, so a new table is held to rules written before it.
7. **Migrations are append-only and pushed by hand, schema before code.** CI never applies one;
   the deploy refuses to ship a bundle ahead of one (`pnpm db:deployed`).
8. **Signup is closed.** There is one user and she is made by hand. The deploy refuses a
   project anyone can join, and refuses the neighbouring switch that would lock everyone out
   (`pnpm auth:closed`).
9. **CI is the only way to production.** Vercel's own deploys of `main` are off in `vercel.json`.
10. **The service worker caches the shell and nothing else.** `runtimeCaching` is empty in
    `apps/web/pwa.config.ts`, so every data request reaches the network or fails; rows kept for
    offline are the app's own, in IndexedDB, under an owner. The first runtime route turns this
    off.
11. **Rows on this device belong to one account.** The row cache names its owner and is refused
    for anyone else; any change of account, sign-out included, empties it and the in-memory
    cache.
12. **Signed out is a server's answer; offline is no answer.** The app renders from the stored
    session and only a server that refuses it signs anybody out (`supabase/remembered.ts`).
13. **The Mac app decides nothing the web app decides.** It loads `apps/web`; a rule written in
    Swift is a second copy that a stale bundle keeps enforcing after the page has changed.

## Non-goals

Each is something a finance app plausibly does, and this one will not.

- **Moving money** — no transfers, no bill pay, no payments started from here. It is a view, and
  invariant 5 keeps it one.
- **Other people.** No household sharing, no second user, no invitations. One person, so no
  roles, no sharing model and no per-user settings screen.
- **Investment advice.** It shows holdings and projects them forward; it never suggests a trade,
  a rebalance or an allocation.
- **Encrypting the rows cached in the browser.** Decided 23 Sep 2026: a key kept beside the data
  it locks is theatre. Device encryption, the app-switcher veil, the wipe on sign-out and a
  passkey re-lock after idle protect them instead.

Two things that look like non-goals are not: **tax preparation** and **a native iOS app** are
wanted later, and are parked rather than refused.

## Shape

```
packages/core     framework-free domain: rules, parsing, anything with an opinion
apps/web          Vite + React SPA over it
apps/web/pwa.config.ts
                  installable: the manifest, the service worker's rules, the stale-chunk
                  reload, the iOS shell — with apps/web/src/pwa/
apps/web/src/device/
                  what is kept on this device, and for whom
apps/web/src/queries/
                  the tables the app reads, and how
apps/mac          the Mac app: a native window onto the same apps/web build. Swift, built by
                  `pnpm app:install`, never by the gate or CI. `shell/App.swift` is the one
                  file the app edits
api/              Vercel functions — every .ts is one, except under a `_` path
supabase/         migrations (append-only), the table pattern, the invariants, the local seed
scripts/db/       the deploy's two refusals and the invariant runner
docs/             this file, and the one-time setup only a person can do
```

A function imports the core by relative path, never by package name, and a package it uses at
runtime is a root dependency: Vercel compiles each function on its own and ships only what it
can trace.

`packages/core` imports no React, no DOM, no database client and no Node built-ins. Its
tsconfig has no DOM and no ambient types, and lint bans the imports, so this holds by
construction rather than by memory. It is the layer the coverage gate (90/90/85/90) measures
and the layer worth testing exhaustively.

## Conventions

- **Strict TS, no `as`, no `!`.** Parse at every boundary with Zod through
  `packages/core/src/parse.ts` and infer the type from the schema; narrow at runtime. A cast
  is how unvalidated data gets into the type system while still being whatever it was.
  `as const` is fine.
- **Discriminated unions over optional-field soup** in the domain.
- **No barrel files; named exports; import from the file that defines the thing.** Every
  relative import ends in `.ts` or `.tsx`.
- **Comments record the argument, not the mechanics.** If a comment would restate the line
  below it, delete it. If it records a decision, keep it and date it.
- **Numbers in comments are measured, and say against what.**
- **Wherever "Uncategorized" is shown, it can be categorized right there.** Nora, 26 Sep: a
  word that names a gap and offers no way to close it sends her to another page to do it. A
  transaction in a list is a `FilingRow` with the page's one `usePicker` sheet
  (`apps/web/src/Sorting.tsx`); a count of them links to the Categorize queue.
