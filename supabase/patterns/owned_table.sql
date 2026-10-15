-- The shape of a table somebody owns. Copy this into a new migration
-- (`pnpm db:new <name>`), rename `things`, and add the columns the app needs.
--
-- Not a migration and never run: supabase/migrations is the only directory the CLI reads.
-- supabase/tests/schema_invariants.sql checks every table in public against the rules
-- below, so a table that leaves one out fails `pnpm db:verify` rather than a review.
--
--   * `user_id not null`, and the policy in THIS file. A table secured in a later
--     migration was open until then.
--   * RLS enabled AND forced — forced so the table owner is not exempt. No policy is
--     default deny; one policy per operation, each on `(select auth.uid())`, `to
--     authenticated` so anon never matches.
--   * `deleted_at`: nothing hard-deletes (invariant 2). Removing a row is setting
--     deleted_at, for her as for the system: no role holds DELETE or TRUNCATE, so there is
--     no delete policy to write. Every table already built held to this; the pattern alone
--     still granted DELETE until DIN-24 (14 Oct 2026), and monarch_decisions, the one table
--     that copied it, had it revoked in DIN-15.
--   * `revoke all` before the grants: the foundation leaves authenticated its default
--     privileges, which on the local image are all seven, TRUNCATE included, and RLS does
--     not govern TRUNCATE (20260924134228).
--   * `unique (user_id, id)`, so a child can carry a composite foreign key to it. RLS
--     checks a row's own user_id, not the row it points at — without this a user can
--     attach their row to someone else's.
--   * user_id frozen by trigger, updated_at set by trigger.
--   * Policies do not filter deleted_at: a soft-deleted row stays readable so it can be
--     listed and restored. Hiding it is the query's job, backed by the partial index.

create table public.things (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- A child of another owned table points at it through both columns:
  --   parent_id uuid,
  --   foreign key (user_id, parent_id) references public.parents (user_id, id),

  title text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint things_user_id_id_key unique (user_id, id),
  constraint things_title_length check (char_length(title) <= 500)
);

create index things_user_live_idx
  on public.things (user_id, created_at)
  where deleted_at is null;

create trigger things_set_updated_at
  before update on public.things
  for each row execute function public.set_updated_at();

create trigger things_freeze_user_id
  before update on public.things
  for each row execute function public.freeze_user_id();

alter table public.things enable row level security;
alter table public.things force row level security;

create policy things_select_own on public.things
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy things_insert_own on public.things
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy things_update_own on public.things
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.things from authenticated;
revoke all on table public.things from service_role;
grant select, insert, update on table public.things to authenticated;

-- Server side (a Vercel function holding the service key) gets a grant only when it needs
-- one, in the migration that needs it, and never DELETE:
--   grant select, insert, update on table public.things to service_role;
