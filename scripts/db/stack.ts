/**
 * Which local stack this checkout talks to.
 *
 * The main checkout runs the stack `supabase/config.toml` describes. A worktree runs its own.
 * Measured 24 Sep 2026 with CLI 2.115: a second `supabase start` from a worktree with the same
 * `project_id` does not start anything — it finds the main checkout's containers running and
 * attaches to them, so a `db:reset` in any worktree silently resets everyone's database to that
 * branch's migrations. So a worktree gets its own `project_id` and its own ports, passed to the
 * CLI as environment overrides (`SUPABASE_PROJECT_ID`, `SUPABASE_API_PORT`, …, which the CLI
 * reads over config.toml), and config.toml — a tracked file — is never edited per checkout.
 *
 * **Ports.** An app owns a block of a hundred, `<block>00`–`<block>99`; config.toml uses the
 * `x2x` tens, the CLI's own layout (54321 → 54621). A worktree takes another tens digit in the
 * same block, so it can never land on another app's ports, and the slot it took is written to
 * `supabase/.worktree` so it keeps it. Nine at once, which is more than one laptop has the
 * memory for: a stack held 480–490 MiB idle.
 *
 * **A worktree's database is disposable.** It is rebuilt from migrations and the seed by
 * `db:reset`, so `db:stop` there discards its volume rather than keeping a backup that a later
 * worktree of the same name would start from. A worktree removed with its stack still running
 * leaves containers nothing will stop; `db:start` reports them and `pnpm db:orphans --stop`
 * removes them.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';

/** The CLI's layout within a tens slot: 54321 API, 54322 database, and so on. */
const DIGITS = {
  shadow: 0,
  api: 1,
  db: 2,
  studio: 3,
  smtp: 4,
  analytics: 7,
  pooler: 9,
} as const;

export type Ports = { readonly [K in keyof typeof DIGITS]: number };

/** The main checkout's tens digit, config.toml's own. */
export const MAIN_SLOT = 2;
/** The others, in the order a worktree is given one. */
export const WORKTREE_SLOTS: readonly number[] = [3, 4, 5, 6, 7, 8, 9, 0, 1];

export function portsFor(block: number, slot: number): Ports {
  const base = block * 100 + slot * 10;
  return {
    shadow: base + DIGITS.shadow,
    api: base + DIGITS.api,
    db: base + DIGITS.db,
    studio: base + DIGITS.studio,
    smtp: base + DIGITS.smtp,
    analytics: base + DIGITS.analytics,
    pooler: base + DIGITS.pooler,
  };
}

export type Config = { readonly projectId: string; readonly block: number };

/** Reads `project_id` and the block from the `[api]` port, or says what is missing. */
export function readConfig(toml: string): Config | string {
  const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (projectId === undefined) return 'supabase/config.toml has no project_id.';
  const api = /^\[api\][^[]*?^port\s*=\s*(\d+)/ms.exec(toml)?.[1];
  if (api === undefined) return 'supabase/config.toml has no [api] port.';
  const port = Number(api);
  if (Math.floor(port / 10) % 10 !== MAIN_SLOT) {
    return `supabase/config.toml's API port ${port} is not in the x2x slot this script assumes.`;
  }
  return { projectId, block: Math.floor(port / 100) };
}

/**
 * A worktree's project id: the app's, then `-wt-` and the worktree's directory name, which is
 * what Docker names its containers and volume after. Unique per worktree rather than per slot:
 * a slot is reused, and a stack found under a reused id would be another branch's database.
 */
export function worktreeProjectId(projectId: string, directory: string): string {
  const name = directory
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${projectId}-wt-${name || 'unnamed'}`;
}

/** The first slot no other worktree holds and none of whose ports is in use; null if none. */
export function chooseSlot(held: ReadonlySet<number>, busy: ReadonlySet<number>): number | null {
  return WORKTREE_SLOTS.find((slot) => !held.has(slot) && !busy.has(slot)) ?? null;
}

export function overrides(projectId: string, ports: Ports): Record<string, string> {
  return {
    SUPABASE_PROJECT_ID: projectId,
    SUPABASE_API_PORT: String(ports.api),
    SUPABASE_DB_PORT: String(ports.db),
    SUPABASE_DB_SHADOW_PORT: String(ports.shadow),
    SUPABASE_DB_POOLER_PORT: String(ports.pooler),
    SUPABASE_STUDIO_PORT: String(ports.studio),
    SUPABASE_LOCAL_SMTP_PORT: String(ports.smtp),
    SUPABASE_ANALYTICS_PORT: String(ports.analytics),
  };
}

/**
 * Worktree project ids with a database container on this machine and no worktree behind them.
 * Only this app's (`<projectId>-wt-`), and never the main checkout's own.
 */
export function orphans(
  containers: readonly string[],
  projectId: string,
  live: ReadonlySet<string>,
): string[] {
  const prefix = `supabase_db_${projectId}-wt-`;
  return containers
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice('supabase_db_'.length))
    .filter((id) => !live.has(id));
}

// ---------------------------------------------------------------------------------------
// The effectful half: git, the filesystem, sockets, Docker.

export type Stack = {
  readonly root: string;
  readonly worktree: boolean;
  readonly projectId: string;
  /** The app's own id, which every worktree's id starts from. */
  readonly appId: string;
  readonly ports: Ports;
  readonly env: Record<string, string>;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const SLOT_FILE = join('supabase', '.worktree');

function heldSlot(worktree: string): number | null {
  const path = join(worktree, SLOT_FILE);
  if (!existsSync(path)) return null;
  const slot = Number(readFileSync(path, 'utf8').trim());
  return WORKTREE_SLOTS.includes(slot) ? slot : null;
}

function worktrees(root: string): string[] {
  return git(root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
  });
}

async function busySlots(block: number): Promise<Set<number>> {
  const busy = new Set<number>();
  for (const slot of WORKTREE_SLOTS) {
    const free = await Promise.all(Object.values(portsFor(block, slot)).map(portFree));
    if (free.includes(false)) busy.add(slot);
  }
  return busy;
}

/** The checkout's root and the app's own project id, whichever checkout this is. */
export function app(cwd: string): { readonly root: string; readonly appId: string } {
  const root = git(cwd, 'rev-parse', '--show-toplevel');
  const config = readConfig(readFileSync(join(root, 'supabase', 'config.toml'), 'utf8'));
  if (typeof config === 'string') fail(config);
  return { root, appId: config.projectId };
}

/**
 * Resolves the stack for the checkout at `cwd`. In a worktree with no slot yet, `claim` decides
 * whether to take one (starting a stack) or to report that there is none (anything else).
 */
export async function stack(cwd: string, claim: boolean): Promise<Stack> {
  const root = git(cwd, 'rev-parse', '--show-toplevel');
  const gitDir = git(cwd, 'rev-parse', '--path-format=absolute', '--git-dir');
  const commonDir = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const config = readConfig(readFileSync(join(root, 'supabase', 'config.toml'), 'utf8'));
  if (typeof config === 'string') fail(config);

  if (gitDir === commonDir) {
    return {
      root,
      worktree: false,
      projectId: config.projectId,
      appId: config.projectId,
      ports: portsFor(config.block, MAIN_SLOT),
      env: {},
    };
  }

  const projectId = worktreeProjectId(config.projectId, basename(root));
  let slot = heldSlot(root);
  if (slot === null) {
    if (!claim) {
      fail(
        `This worktree has no local stack of its own yet. Start one with \`pnpm db:start\` —\n` +
          `it will not use the main checkout's.`,
      );
    }
    const held = new Set(
      worktrees(root)
        .filter((path) => path !== root)
        .map(heldSlot)
        .filter((s) => s !== null),
    );
    slot = chooseSlot(held, await busySlots(config.block));
    if (slot === null) {
      fail(
        `Every worktree slot in the ${config.block}xx block is held or in use. ` +
          `\`pnpm db:orphans\` lists stacks left behind by removed worktrees.`,
      );
    }
    writeFileSync(join(root, SLOT_FILE), `${slot}\n`);
  }
  const ports = portsFor(config.block, slot);
  return {
    root,
    worktree: true,
    projectId,
    appId: config.projectId,
    ports,
    env: overrides(projectId, ports),
  };
}

type Target = Pick<Stack, 'root' | 'env'>;

/** Runs this checkout's Supabase CLI against its own stack, inheriting the terminal. */
export function supabase(s: Target, args: readonly string[]): number {
  const bin = join(s.root, 'node_modules', '.bin', 'supabase');
  if (!existsSync(bin)) fail('No Supabase CLI in node_modules. Run `pnpm install`.');
  const result = spawnSync(bin, args, { stdio: 'inherit', env: { ...process.env, ...s.env } });
  return result.status ?? 1;
}

/** Like `supabase`, but returns what it printed. Throws when the CLI fails. */
export function supabaseOutput(s: Target, args: readonly string[]): string {
  const bin = join(s.root, 'node_modules', '.bin', 'supabase');
  return execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...s.env },
  });
}

/** This app's worktree stacks that have no worktree left, or null when Docker cannot be asked. */
export function findOrphans(root: string, appId: string): string[] | null {
  let names: string;
  try {
    names = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const live = new Set(worktrees(root).map((path) => worktreeProjectId(appId, basename(path))));
  return orphans(names.split('\n'), appId, live);
}
