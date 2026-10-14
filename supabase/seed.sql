-- Local development seed. Runs on `supabase start` and `pnpm db:reset`; never against a
-- deployed database.
--
-- Two users, because a single-user seed cannot show that RLS isolates anything.
-- supabase/tests/rls_behaviour.sql relies on both. Sign in locally as either address; the
-- code arrives in the local mailbox (Mailpit, on the port `supabase status` prints).
--
-- The token columns are '' rather than NULL on purpose: GoTrue scans them into
-- non-nullable Go strings and answers "Database error querying schema" on a NULL, which
-- surfaces as an unexplained 500 at sign-in. Found by Nora Bene.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change_token_new,
  email_change_token_current, email_change, phone_change, phone_change_token,
  reauthentication_token
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-1111-1111-111111111111',
    'authenticated', 'authenticated', 'one@example.test', '',
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    '', '', '', '', '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-2222-2222-222222222222',
    'authenticated', 'authenticated', 'two@example.test', '',
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    '', '', '', '', '', '', '', ''
  )
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
values
  (
    gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    '{"sub":"11111111-1111-1111-1111-111111111111","email":"one@example.test","email_verified":true}'::jsonb,
    'email', now(), now(), now()
  ),
  (
    gen_random_uuid(), '22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222222',
    '{"sub":"22222222-2222-2222-2222-222222222222","email":"two@example.test","email_verified":true}'::jsonb,
    'email', now(), now(), now()
  )
on conflict (provider_id, provider) do nothing;
