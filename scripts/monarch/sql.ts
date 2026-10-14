/**
 * The pure half of `pnpm monarch:import`: the SQL it sends and the reading of what comes
 * back. `cli.ts` is the half that reads files and talks to Docker or the Supabase CLI.
 *
 * Every value reaches Postgres inside a dollar-quoted literal, as `scripts/bank/simplefin.ts`
 * does it, so a merchant with a quote in it is only a merchant.
 */
import { z } from 'zod';

import type {
  AssetPayload,
  Decision,
  Payload,
  PayloadAccount,
  Stored,
} from '../../packages/core/src/monarch.ts';
import { UNREADY_WHY, decisionSchema, parseStored } from '../../packages/core/src/monarch.ts';
import { parse } from '../../packages/core/src/parse.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A dollar-quote tag the text does not contain, so nothing in it can end the literal. */
function tagFor(text: string): string {
  for (let i = 0; ; i++) {
    const tag = `$m${i}$`;
    if (!text.includes(tag)) return tag;
  }
}

export function literal(text: string): string {
  const tag = tagFor(text);
  return `${tag}${text}${tag}`;
}

/**
 * Whose rows. Locally the seeded address, since a worktree's stack has two users; in
 * production the one user there is, and a refusal if there is not exactly one — invariant
 * 8, as the nightly job reads it (BANK-02).
 */
export function userSql(email: string | null): string {
  if (email !== null) {
    return `select json_build_object('ids', coalesce(json_agg(id), '[]'::json)) as answer from auth.users where email = lower(${literal(email)});`;
  }
  return `select json_build_object('ids', coalesce(json_agg(id), '[]'::json)) as answer from auth.users;`;
}

/** Her bank accounts, by name, for the proposal. Names and ids: no balance. */
export function accountsSql(userId: string): string {
  if (!UUID.test(userId)) throw new Error('accountsSql: userId is not a uuid');
  return `select json_build_object('accounts', coalesce(json_agg(json_build_object(
  'source_id', source_id, 'institution', institution, 'name', name)
  order by institution, name), '[]'::json)) as answer
from public.accounts
where user_id = '${userId}' and source in ('simplefin', 'plaid') and deleted_at is null;`;
}

/**
 * The two accounts `--link` names (BANK-15), deleted or not, so a refusal can say which is
 * which. Ids, names and sources: no balance.
 */
export function linkAccountsSql(userId: string, ids: readonly string[]): string {
  if (!UUID.test(userId)) throw new Error('linkAccountsSql: userId is not a uuid');
  if (!ids.every((id) => UUID.test(id))) throw new Error('linkAccountsSql: an id is not a uuid');
  const list = ids.map((id) => `'${id}'`).join(', ');
  return `select json_build_object('accounts', coalesce(json_agg(json_build_object(
  'id', id, 'source', source, 'source_id', source_id, 'institution', institution,
  'name', name, 'currency', currency, 'deleted_at', deleted_at)), '[]'::json)) as answer
from public.accounts
where user_id = '${userId}' and id in (${list});`;
}

/**
 * Every account the store would refuse, asked in one read before any is written (ACCT-07).
 * The store refuses one account at a time, each in its own transaction, so a refusal of the
 * fifth left the first four written on ACCT-05's first production run. These are the store's
 * own lookups, asked in advance: a link must name a live bank account in the same currency
 * with a `read` or `rebuilt` day, and a `history` account must not be one deleted in Dinora.
 */
export function unreadySql(userId: string, accounts: readonly PayloadAccount[]): string {
  if (!UUID.test(userId)) throw new Error('unreadySql: userId is not a uuid');
  const asked = accounts.map(({ monarch_name, link, currency }) => ({
    monarch_name,
    link,
    currency,
  }));
  return `with asked as (
  select * from jsonb_to_recordset(${literal(JSON.stringify(asked))}::jsonb)
    as a (monarch_name text, link text, currency text)
), checked as (
  select a.monarch_name, a.link,
    case when a.link is null then (
      select 'deleted' from public.accounts acc
      where acc.user_id = '${userId}' and acc.source = 'monarch'
        and acc.source_id = a.monarch_name and acc.deleted_at is not null
      limit 1)
    else coalesce((
      select case
        when bank.deleted_at is not null then 'deleted'
        when bank.currency <> a.currency then 'currency'
        when not exists (
          select 1 from public.balance_snapshots s
          where s.account_id = bank.id and s.kind in ('read', 'rebuilt')
            and s.deleted_at is null) then 'no_history'
        end
      from public.accounts bank
      where bank.user_id = '${userId}' and bank.source in ('simplefin', 'plaid')
        and bank.source_id = a.link
      order by bank.deleted_at nulls first
      limit 1), case when not exists (
        select 1 from public.accounts bank
        where bank.user_id = '${userId}' and bank.source in ('simplefin', 'plaid')
          and bank.source_id = a.link) then 'missing' end)
    end as why
  from asked a
)
select json_build_object('unready', coalesce(json_agg(json_build_object(
  'monarch_name', monarch_name, 'link', link, 'why', why) order by monarch_name)
  filter (where why is not null), '[]'::json)) as answer
from checked;`;
}

export function readUnready(output: string) {
  return parse(
    z.array(
      z.object({
        monarch_name: z.string(),
        link: z.string().nullable(),
        why: z.enum(UNREADY_WHY),
      }),
    ),
    findAnswer(output, 'unready'),
  );
}

/**
 * What a refused query said, from either road: the Supabase CLI's `{"_tag":"Error","error":
 * {"message"}}` on stdout (measured 27 Sep 2026 on CLI 2.117.0, `db query --output-format json`
 * against a local database, which kept a raise's DETAIL out of the message), or psql's `ERROR:`
 * line on stderr. Only the message, never the DETAIL, which can quote the failing row, merchant
 * and all (invariant 4). Null when neither is there.
 */
export function readRefusal(output: string): string | null {
  const envelope = parse(z.object({ message: z.string() }), findAnswer(output, 'error'));
  if (envelope.ok)
    return envelope.value.message.replace(/^failed to execute query: (?:error: )?/, '');
  for (const line of output.split('\n')) {
    const said = /\bERROR:\s+(.*)$/.exec(line)?.[1];
    if (said !== undefined) return said;
  }
  return null;
}

/** One account's import, as service_role, in its own transaction. */
export function storeSql(userId: string, payload: Payload): string {
  if (!UUID.test(userId)) throw new Error('storeSql: userId is not a uuid');
  return `begin;
set local role service_role;
select json_build_object('stored', public.monarch_store('${userId}'::uuid, ${literal(JSON.stringify(payload))}::jsonb)) as answer;
commit;
`;
}

/**
 * One asset's history (ACCT-06), in its own transaction, **as her**: `authenticated` with her
 * id in the claims, so the rows go through the same policy as a value she types, and the
 * nightly job's service_role needs no grant on her assets at all.
 *
 * The asset is found by `monarch_name`, which only an import sets and she cannot change, so a
 * rename in the app does not make a second import create it again. One she has removed is left
 * removed, and its values are not brought back. Monarch's values upsert on the day and write
 * nothing a second time.
 */
export function assetSql(userId: string, asset: AssetPayload): string {
  if (!UUID.test(userId)) throw new Error('assetSql: userId is not a uuid');
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  return `begin;
select set_config('request.jwt.claims', ${literal(claims)}, true);
set local role authenticated;
with payload as (
  select ${literal(JSON.stringify(asset))}::jsonb as p
),
existing as (
  select a.id, a.deleted_at from public.assets a, payload
  where a.user_id = '${userId}' and a.monarch_name = p->>'monarch_name'
),
made as (
  insert into public.assets (user_id, name, kind, monarch_name)
  select '${userId}', p->>'monarch_name', p->>'kind', p->>'monarch_name' from payload
  where not exists (select 1 from existing)
  returning id
),
target as (
  select id from made
  union all
  select id from existing where deleted_at is null
),
added as (
  insert into public.asset_values (user_id, asset_id, valued_on, amount_minor, source)
  select '${userId}', target.id, (v->>'valued_on')::date, (v->>'amount_minor')::bigint, 'monarch'
  from target, payload, jsonb_array_elements(p->'values') v
  on conflict (user_id, asset_id, valued_on) where source = 'monarch' and deleted_at is null
  do nothing
  returning 1
)
select json_build_object('asset', json_build_object(
  'added', (select count(*) from made) > 0,
  'removed', exists (select 1 from existing where deleted_at is not null),
  'values_added', (select count(*) from added))) as answer;
commit;
`;
}

/**
 * Every live decision (ACCT-18), for the mapping and for `--show`. Names and ids: no balance.
 * Read as the owner of the query, like her accounts above; written only as her, below.
 */
export function decisionsSql(userId: string): string {
  if (!UUID.test(userId)) throw new Error('decisionsSql: userId is not a uuid');
  return `select json_build_object('decisions', coalesce(json_agg(json_build_object(
  'monarch_name', monarch_name, 'goes', goes, 'link', link, 'link_is', link_is,
  'asset_kind', asset_kind, 'why', why, 'decided_at', decided_at)
  order by monarch_name, decided_at), '[]'::json)) as answer
from public.monarch_decisions
where user_id = '${userId}' and deleted_at is null;`;
}

/**
 * Decisions written in one transaction, **as her**, so they pass the same policy a page of
 * the app would (BANK-15's link from the home screen, when it makes its own). All or none.
 */
export function decideSql(userId: string, decisions: readonly Decision[]): string {
  if (!UUID.test(userId)) throw new Error('decideSql: userId is not a uuid');
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  return `begin;
select set_config('request.jwt.claims', ${literal(claims)}, true);
set local role authenticated;
with written as (
  insert into public.monarch_decisions
    (user_id, monarch_name, goes, link, link_is, asset_kind, why, decided_at)
  select '${userId}', d.monarch_name, d.goes, d.link, d.link_is, d.asset_kind, d.why, d.decided_at
  from jsonb_to_recordset(${literal(JSON.stringify(decisions))}::jsonb) as d (
    monarch_name text, goes text, link text, link_is text, asset_kind text, why text,
    decided_at timestamptz)
  returning 1
)
select json_build_object('decided', (select count(*) from written)) as answer;
commit;
`;
}

export function readDecisions(output: string) {
  return parse(z.array(decisionSchema), findAnswer(output, 'decisions'));
}

export function readDecisionsWritten(output: string) {
  return parse(z.int(), findAnswer(output, 'decided'));
}

const assetStoredSchema = z.object({
  added: z.boolean(),
  removed: z.boolean(),
  values_added: z.int(),
});

export type AssetStored = z.output<typeof assetStoredSchema>;

export function readAssetStored(output: string): AssetStored | null {
  const parsed = parse(assetStoredSchema, findAnswer(output, 'asset'));
  return parsed.ok ? parsed.value : null;
}

/**
 * The `answer` column, from either road: psql's bare text (one line of JSON), or the
 * Supabase CLI's JSON, whose envelope was not measured against the hosted project when this
 * was written (24 Sep 2026) — so the answer is looked for by its own key, wherever the
 * envelope puts it, rather than by a path guessed in advance.
 */
export function findAnswer(output: string, key: string): unknown {
  const found: unknown[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          visit(JSON.parse(trimmed));
        } catch {
          // Not JSON after all: a message, not an answer.
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === 'object' && value !== null) {
      if (key in value) found.push(Object.getOwnPropertyDescriptor(value, key)?.value);
      else Object.values(value).forEach(visit);
    }
  };
  for (const line of output.split('\n')) visit(line);
  if (found.length === 0) visit(output);
  return found[0];
}

export function readUserIds(output: string) {
  return parse(z.array(z.guid()), findAnswer(output, 'ids'));
}

export function readAccounts(output: string) {
  return parse(
    z.array(z.object({ source_id: z.string(), institution: z.string(), name: z.string() })),
    findAnswer(output, 'accounts'),
  );
}

export function readLinkAccounts(output: string) {
  return parse(
    z.array(
      z.object({
        id: z.string(),
        source: z.string(),
        source_id: z.string(),
        institution: z.string(),
        name: z.string(),
        currency: z.string(),
        deleted_at: z.string().nullable(),
      }),
    ),
    findAnswer(output, 'accounts'),
  );
}

export function readStored(output: string): Stored | null {
  const parsed = parseStored(findAnswer(output, 'stored'));
  return parsed.ok ? parsed.value : null;
}
