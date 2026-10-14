-- Structural invariants. Safe anywhere, production included: every check is a catalogue
-- query, inside a transaction that is READ ONLY so a check that grows a write fails loudly
-- instead of touching data.
--
--   pnpm db:verify           the local stack, this file and rls_behaviour.sql
--   pnpm db:verify:remote    the linked project, this file only
--
-- Nothing here names a table. Every rule is checked against every table in public, so a
-- table added next month is covered by rules written today, and an allowlist — where there
-- is one — is the only way out of a rule, one name at a time, with a reason beside it.
--
-- Absence is reported as absence. With no tables yet, the table checks print NONE rather
-- than PASS: a rule that held because there was nothing to check has not been shown to hold.

\set ON_ERROR_STOP on

begin;
set transaction read only;

-- --------------------------------------------------------------------------------------
-- Row-level security on every table, default deny.
-- --------------------------------------------------------------------------------------

do $$
declare
  tables integer;
  offenders text;
begin
  select count(*) into tables
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p');

  if tables = 0 then
    raise notice 'NONE  no tables in public yet; the table checks below have nothing to check';
    return;
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and not (c.relrowsecurity and c.relforcerowsecurity);
  if offenders is not null then
    raise exception 'tables without RLS enabled and forced: %', offenders;
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  if offenders is not null then
    raise exception 'tables with no policy at all: %', offenders;
  end if;

  raise notice 'PASS  % table(s): RLS enabled and forced on each, each with a policy', tables;
end;
$$;

-- A policy with no `to` clause applies to PUBLIC, which includes anon.
do $$
declare
  offenders text;
begin
  select string_agg(c.relname || '.' || p.polname, ', ' order by c.relname, p.polname)
  into offenders
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and (0 = any (p.polroles) or 'anon'::regrole::oid = any (p.polroles))
    and c.relname not in (
      -- Tables readable without signing in, each with its reason. None yet.
      ''
    );
  if offenders is not null then
    raise exception 'policies that apply to anon or PUBLIC: %', offenders;
  end if;
  raise notice 'PASS  no policy applies to anon or PUBLIC';
end;
$$;

do $$
declare
  offenders text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
    and has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
    and c.relname not in (
      -- The same allowlist as above. None yet.
      ''
    );
  if offenders is not null then
    raise exception 'anon holds privileges on: %', offenders;
  end if;
  raise notice 'PASS  anon holds no privilege on any table or view in public';
end;
$$;

-- --------------------------------------------------------------------------------------
-- The system never hard-deletes, and service_role is the system.
-- --------------------------------------------------------------------------------------

do $$
declare
  offenders text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into offenders
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and has_table_privilege('service_role', c.oid, 'DELETE, TRUNCATE');
  if offenders is not null then
    raise exception 'service_role can DELETE or TRUNCATE: %', offenders;
  end if;
  raise notice 'PASS  service_role can delete from no table';
end;
$$;

-- --------------------------------------------------------------------------------------
-- Every owned table has the pattern's shape (supabase/patterns/owned_table.sql).
-- --------------------------------------------------------------------------------------

-- A table is owned if it has a user_id. The subquery is repeated rather than made a view:
-- a READ ONLY transaction refuses every CREATE, temporary ones included.
do $$
declare
  owned integer;
  offenders text;
begin
  select count(*) into owned from (
    select c.oid, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
      )
  ) as t;
  if owned = 0 then
    raise notice 'NONE  no table has a user_id yet; the ownership checks have nothing to check';
    return;
  end if;

  select string_agg(t.relname, ', ' order by t.relname) into offenders
  from (
    select c.oid, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
      )
  ) as t
  where not exists (
    select 1 from pg_attribute a
    where a.attrelid = t.oid and a.attname = 'deleted_at' and not a.attisdropped
  )
  and t.relname not in (
    -- Owned tables that are allowed to hard-delete, each with its reason. None yet.
    ''
  );
  if offenders is not null then
    raise exception 'owned tables with no deleted_at (no soft delete): %', offenders;
  end if;

  select string_agg(t.relname, ', ' order by t.relname) into offenders
  from (
    select c.oid, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
      )
  ) as t
  where not exists (
    select 1 from pg_trigger g
    where g.tgrelid = t.oid and g.tgfoid = 'public.freeze_user_id()'::regprocedure
  );
  if offenders is not null then
    raise exception 'owned tables whose user_id is not frozen by trigger: %', offenders;
  end if;

  select string_agg(t.relname, ', ' order by t.relname) into offenders
  from (
    select c.oid, c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
      )
  ) as t
  where not exists (
    select 1 from pg_constraint k
    where k.conrelid = t.oid and k.contype in ('u', 'p')
      and (
        select array_agg(a.attname::text order by a.attname)
        from unnest(k.conkey) as key(attnum)
        join pg_attribute a on a.attrelid = k.conrelid and a.attnum = key.attnum
      ) = array['id', 'user_id']
  );
  if offenders is not null then
    raise exception 'owned tables with no unique (user_id, id) for a composite key: %', offenders;
  end if;

  raise notice 'PASS  % owned table(s): soft delete, frozen user_id, unique (user_id, id)', owned;
end;
$$;

-- --------------------------------------------------------------------------------------
-- Functions: none bypasses RLS unless named, none runs on a caller's search_path, and
-- anon can call exactly one.
-- --------------------------------------------------------------------------------------

do $$
declare
  offenders text;
begin
  -- A DEFINER function runs as its owner and sees every row regardless of policy: the one
  -- construct that can quietly undo RLS for a whole table. Adding a name here is a
  -- one-line change, which is about the deliberation that deserves.
  select string_agg(p.proname, ', ' order by p.proname) into offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and p.proname not in (
      -- One timestamp, no arguments, no rows anybody owns. For the deploy's schema check.
      'schema_version'
    );
  if offenders is not null then
    raise exception 'SECURITY DEFINER functions not on the allowlist: %', offenders;
  end if;

  select string_agg(p.proname, ', ' order by p.proname) into offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and not exists (select 1 from unnest(p.proconfig) as c(setting) where c.setting like 'search_path=%');
  if offenders is not null then
    raise exception 'functions without a fixed search_path (write set search_path = ''''): %', offenders;
  end if;

  select string_agg(p.proname, ', ' order by p.proname) into offenders
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and has_function_privilege('anon', p.oid, 'execute')
    and p.proname <> 'schema_version';
  if offenders is not null then
    raise exception 'functions anon can execute: %', offenders;
  end if;

  raise notice 'PASS  functions: DEFINER only where allowed, search_path fixed, anon calls one';
end;
$$;

do $$
begin
  if to_regprocedure('public.schema_version()') is null then
    raise exception 'public.schema_version() is missing; the deploy check cannot run';
  end if;
  if not has_function_privilege('anon', 'public.schema_version()', 'execute') then
    raise exception 'anon cannot execute schema_version(); the deploy carries only that key';
  end if;
  if exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
    where p.oid = 'public.schema_version()'::regprocedure
      and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ) then
    raise exception 'schema_version() is executable by PUBLIC rather than the named roles';
  end if;
  raise notice 'PASS  schema_version() is callable by anon, and PUBLIC holds no grant';
end;
$$;

rollback;
