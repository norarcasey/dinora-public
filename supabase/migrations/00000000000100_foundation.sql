-- Foundation: the privileges every later table inherits, the two trigger helpers every
-- owned table uses, and the function the deploy asks for the schema's version.
--
-- The version is fourteen zeros-and-a-hundred rather than a date so it sorts before every
-- migration `supabase migration new` will ever write, whenever this project was cut.
--
-- Tables are not created here. Each one is written from supabase/patterns/owned_table.sql,
-- with its policies in the same file as the table: a table created in one migration and
-- secured in the next was open for however long that took.

-- --------------------------------------------------------------------------------------
-- Default privileges: nothing is reachable until a migration says so.
-- --------------------------------------------------------------------------------------
--
-- The hosted platform and the local image disagree. Hosted, the default privileges grant
-- `anon` and `service_role` ALL on every new table in public; the local image grants
-- service_role nothing. Nora Bene found out only when its invariants were first run against
-- production (20260823001300 there): service_role could DELETE from every table, and the
-- system — which is what runs as service_role — is exactly what must never hard-delete.
--
-- So both are revoked at the default, converging the two environments on one posture: a
-- new table is unreachable by anon and the server side until a migration grants it.
-- `authenticated` keeps its default because RLS decides what it sees — and a table without
-- a policy is deny-all to it anyway.

alter default privileges for role postgres in schema public
  revoke all on tables from anon, service_role;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, service_role;

-- Functions are executable by PUBLIC in Postgres and by anon on the platform unless taken
-- back. A privilege held "in case" is a privilege to be wrong about later; the one function
-- anon needs is granted by name below. Triggers are unaffected: a trigger's EXECUTE is
-- checked when it is created, not each time it fires.
--
-- Two statements because they are two kinds of default. anon's grant is the platform's,
-- made per schema, so it is revoked per schema. PUBLIC's is Postgres's own, global, and a
-- per-schema default can only add to a global one — written `in schema public`, this
-- revoke is accepted and does nothing. Measured when this layer was built (SKL-03): the
-- invariants caught both trigger helpers executable by anon through PUBLIC.
alter default privileges for role postgres in schema public
  revoke execute on functions from anon;

alter default privileges for role postgres
  revoke execute on functions from public;

-- --------------------------------------------------------------------------------------
-- Trigger helpers
-- --------------------------------------------------------------------------------------

-- Set server-side so a client with a wrong clock cannot hide a row from an incremental
-- read keyed on this column.
create function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Sets updated_at on every UPDATE. Attached to every table carrying updated_at.';

-- user_id is the axis every policy turns on. A policy that checks only the new row would
-- otherwise let a client hand its row to someone else.
create function public.freeze_user_id()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id is immutable on %', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.freeze_user_id() is
  'Rejects any UPDATE that changes user_id. Attached to every user-owned table.';

-- --------------------------------------------------------------------------------------
-- What schema this database has, for `pnpm db:deployed`.
-- --------------------------------------------------------------------------------------
--
-- Migrations are pushed by hand, never by CI: applying schema as a side effect of a green
-- build is how an irreversible one lands unnoticed. So the deploy cannot fix a missing
-- migration; it can only refuse to ship a bundle ahead of one — Nora Bene's OPS-3, where
-- production served a build expecting a column that did not exist.
--
-- A function rather than a credential: the deploy asks with the anon key it already
-- carries. Giving CI a database password would put it one workflow edit away from running
-- `db push` on a green build, which is the door this arrangement exists to keep shut.
--
-- It discloses one timestamp to anyone, which is a trade made knowingly: "production is at
-- X, this build needs Y" is worth more in a failure message than it costs as fingerprinting.

create function public.schema_version()
returns text
language sql
-- DEFINER because supabase_migrations is readable by no API role. No arguments, no rows
-- anybody owns, one value out. supabase/tests/schema_invariants.sql allowlists it by name
-- so that DEFINER does not become a habit.
security definer
stable
set search_path = ''
as $$
  select max(version) from supabase_migrations.schema_migrations;
$$;

comment on function public.schema_version() is
  'The newest applied migration version. Read by the deploy so a build cannot ship ahead '
  'of the schema it expects.';

revoke all on function public.schema_version() from public;
grant execute on function public.schema_version() to anon, authenticated;
