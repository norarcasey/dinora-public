# Dinora

Every account in one place, read-only: balances, budgets, goals, projections and history.

A personal replacement for Monarch, built for one person. It pulls every account — US cards and
brokerages through SimpleFIN, a Spanish bank through Enable Banking — into one place, read-only,
and opens in a browser, as an installed app on a phone, and as a Mac app.

## Develop

Node at the version in `.node-version` (`fnm` switches to it on cd; pnpm refuses any other
major) and pnpm 9 (`corepack enable` picks up the version in `package.json`).

```bash
pnpm install
pnpm db:start # the local Supabase stack (Docker)
pnpm db:env   # writes apps/web/.env.local for it
pnpm dev      # the web app
pnpm gate     # what CI runs: format, lint, typecheck, tests with coverage
pnpm format   # the only command that rewrites files
```

## Plan

What is shipped, what is next and why: tickets in Linora, app `DIN`. The `RUNWAY.md` that held
them was retired on 3 Oct 2026 and its history is in git.
