# Vercel for dinora

CI is the only way to production. `vercel.json` turns off Vercel's own deploys of `main`, and
the `deploy` job in `.github/workflows/ci.yml` runs only after the gate passes.

## One-time setup

```bash
vercel link                     # from the repo root; writes .vercel/, which is ignored
```

In **Project → Settings → Environment Variables**, for Production:

- `CRON_SECRET` — 16 characters or more. Vercel sends it as the bearer, and
  `api/_lib/cron.ts` refuses every call while it is unset.
- For the nightly bank pull (`api/cron/nightly.ts`, BANK-02), all marked **Sensitive**:
  - `SUPABASE_URL` — the project URL, as in **Project Settings → API**.
  - `SUPABASE_SECRET_KEY` — an `sb_secret_` key from **Project Settings → API Keys**. It
    acts as service_role, which may call `bank_store` and delete nothing.
  - `SIMPLEFIN_ACCESS_URL` — the line of that name in the main checkout's
    `.env.simplefin`. Pasted by hand into the dashboard: it is a credential, and a session
    never reads it.

  Until both Supabase keys are set a run answers 500 naming the ones missing, and records
  nothing — there is no owner to record it for without the database. Without
  `SIMPLEFIN_ACCESS_URL` the SimpleFIN pull is skipped rather than failed, as is the Plaid
  pull without any of its keys (DIN-19).

- Any key a function needs, never prefixed `VITE_` — a `VITE_` variable is in the bundle.
  The `VITE_` values are baked in at build time by CI and are not read from here.

GitHub repository secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (the last two
are in `.vercel/project.json` after linking), and a `production` environment. Then the
repository **variable** `ENABLE_VERCEL_DEPLOY=true`; until it is set the deploy job is
skipped, not failed.

**Scope the token to the team, not the project.** `vercel pull` cannot use a project-scoped
token — Nora Bene measured `Error: Could not retrieve Project Settings.` with correct ids, CLI
58.9.5. And pass no `--scope`: the two ids in the environment are how the CLI finds the
project.

## Functions

Every `.ts` under `api/` is a function, except paths starting with `_`. Tests sit beside the
code and `.vercelignore` keeps them from deploying — measured: without it, `x.test.ts` became
a function.

- **Import the core by relative path**, `../packages/core/src/<file>.ts`. By package name
  (`@dinora/core/…`) it is not found at runtime, and lint refuses it.
- **A package a function uses at runtime is a dependency of the root `package.json`** — the
  root is Vercel's project, and a package declared only in `packages/core` or `apps/web` was
  not found when the built function ran.
- Runtime is Node 24, from `engines` in `package.json`; CI and the laptop run the exact 24 in
  `.node-version`. Vercel refuses `use-node-version` in `.npmrc`, so that file cannot pin it
  (DIN-6). An open range such as `>=24` moves on its own at the next major, so the range is
  closed and a major is a change made on purpose (OPS-05).
- **`undici-types` is held at `@types/node`'s own range, copied verbatim**, and `@types/node`
  by a tilde so a bump cannot move that range underneath it. A root copy pnpm cannot dedupe
  with the one `@types/node` resolves is the missing-`Response` failure below.
- **`vercel build` typechecks every function a second time, and the deploy refuses on an
  error** (`EXPERIMENTAL_NODE_TYPESCRIPT_ERRORS` in `ci.yml`). Its compiler is not ours, in
  two ways measured on 24 Sep 2026 (OPS-03) with `@vercel/node` 58.9.5. It reads the root
  `tsconfig.json` without resolving `extends`, and finding no `module` there it forces
  `NodeNext` and `strict: false`. So the root file sets `module` itself. And it follows no
  symlinks, so a package pnpm keeps only beside another, not in the root `node_modules`, is
  missing. That is why `undici-types` is a root dev dependency: without it `@types/node`'s
  `Response` has no members. A new error only this build reports is almost certainly
  another of these, not the code.
- To see what it reports without deploying, write `.vercel/project.json` with `settings`
  copied from `vercel.json` rather than running `vercel pull`, which writes production's
  variables to disk. Then build with placeholder public values:

  ```bash
  EXPERIMENTAL_NODE_TYPESCRIPT_ERRORS=1 VITE_SUPABASE_URL=https://placeholder.supabase.co \
    VITE_SUPABASE_ANON_KEY=sb_publishable_placeholder npx vercel@58.9.5 build --prod
  ```

## Scheduled jobs

A cron is a function plus an entry in `vercel.json`:

```json
"crons": [{ "path": "/api/cron/nightly", "schedule": "0 5 * * *" }]
```

```ts
import { isCronRequest } from '../_lib/cron.ts';

export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request, process.env.CRON_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }
  // reconcile everything since the last run that succeeded, then record this one
  return Response.json({ ok: true });
}
```

From Vercel's docs, read 24 Sep 2026: 100 crons per project on every plan. On Hobby, at most
once a day, fired anywhere inside the hour named. A failed run is not retried; delivery is
best effort, so a run can be missed or arrive twice. Write a job to reconcile, never to
increment, and keep its last success somewhere the app can show — a job that quietly stopped
is otherwise indistinguishable from one with nothing to do. Durations are the function
limits; nothing here runs continuously.
