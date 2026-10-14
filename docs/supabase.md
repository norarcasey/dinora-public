# Supabase for Dinora

The database is pushed by hand; the app is deployed by CI, which refuses to ship ahead of the
database or into a project anyone can sign up to. This is the one-time setup, and the one
routine.

## Every schema change

```bash
pnpm db:new <what_it_adds>      # an empty, timestamped migration
# write it from supabase/patterns/owned_table.sql — the policy in the same file as the table
pnpm db:reset                   # apply every migration and the seed to the local stack
pnpm db:verify                  # the invariants, against what you just built
pnpm db:push:dry                # read exactly what production will run
pnpm db:push                    # then run it
```

Then push the code. Schema first, always: migrations are additive, so the running app
tolerates the new shape for the minute before the new bundle arrives. The deploy's
`pnpm db:deployed` refuses the other order.

Migrations are append-only. One that has run is never edited — that is how a laptop and a
fresh clone end up with different schemas. A mistake is fixed by the next migration.

## One-time setup

### The project

```bash
pnpm exec supabase login
pnpm exec supabase projects create dinora --region <region> --org-id <org>
pnpm exec supabase link --project-ref <ref>
pnpm db:push:dry && pnpm db:push
```

One project per app. The database password is generated here and belongs in a password
manager, never in this repo.

### In the dashboard — none of this can be set from the repo

- **Authentication → URL Configuration**: Site URL is the production origin, and the same
  as a redirect URL. Sign-in links break silently if it is wrong.
- **Authentication → Sign In / Providers → Allow new users to sign up → OFF.** This is the
  lock. `shouldCreateUser: false` in a client is a field in a request body, and the
  publishable key is in every bundle.

  > **Two switches, and one is a lockout.** Leave **Email → Enable email provider ON**.
  > Turning that one off fails every email sign-in for everybody, you included, with
  > `email_provider_disabled`. `pnpm auth:closed` checks both, and says which is wrong.

- **Authentication → Emails → Magic Link**: paste `supabase/templates/magic_link.html`, subject
  `Your Dinora sign-in code`. The default template has only a link, and an installed app
  needs the code — a link signs in the browser, not the app.
- **Authentication → Sign In / Providers → Passkeys → ON** (SEC-01), with the relying party
  ID `dinora.example.com`, display name `Dinora` and origin
  `https://dinora.example.com` — the bare host, then the full origin. Off, _Sign in with
  Face ID_ and _Use Face ID_ both fail. A passkey belongs to its host: when the domain changes
  (`OPS-02`) these three change with it, and each device signs in by code once and turns Face
  ID on again. `/auth/v1/settings` answers `passkeys_enabled`, so this one can be checked
  from outside.
- **Project Settings → Authentication → SMTP**: a real sender before anyone else uses the
  app. The built-in one is shared, throttled, and sends from a Supabase address.
- **Authentication → Users → Add user → Create new user**: your own email, **Auto Confirm User**
  on, and a long random password from the password manager — it is never typed; sign-in is by
  the emailed code. With signup closed this is the only way an account comes to exist, so until
  it is done nobody can sign in, you included. Everyone the app is for is made the same way.

**Never run `supabase config push`.** It would overwrite all of the above with the local
`config.toml`, whose Site URL is localhost.

### Secrets for the deploy

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the `sb_publishable_` key) from
**Project Settings → API**, as GitHub repository secrets. Both are public; they are secrets
only so they live in one place.

## Checking production

```bash
SUPABASE_DB_URL=… pnpm db:verify:remote
```

The structural invariants, read-only, against the real project — worth running after the
first push and after anything done in the dashboard. The hosted platform's default grants are
not the local image's; this is the only check that sees the difference. Use the session
pooler connection string: the direct `db.<ref>.supabase.co` host is IPv6-only.

## Locally

```bash
pnpm db:start && pnpm db:env    # the stack, and apps/web/.env.local pointing at it
pnpm dev
```

Two seeded users, `one@example.test` and `two@example.test`. Sign in with either; the code
arrives in the local mailbox at the Mailpit URL `supabase status` prints.
