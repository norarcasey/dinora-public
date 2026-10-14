/**
 * Builds the Mac shell and installs it into ~/Applications.
 *
 *   pnpm app:install     build, install, and reopen it if it was running
 *   pnpm app:check       is the installed bundle what this checkout builds?
 *   pnpm app:uninstall   remove it
 *
 * Where the window opens and the bundle's identifier come from `DINORA_MAC_HOME` and
 * `DINORA_MAC_IDENTIFIER`, in the environment or the root `.env.mac` (see `identity` in
 * `bundle.ts`). An install that would change the identifier refuses without
 * `--new-identifier`, because the old one's data store is left behind.
 *
 * Needs the Swift toolchain (Xcode or `xcode-select --install`), so CI never runs it: a macOS
 * runner bills ten times the minutes. `app:check` and the stamp are what replace a CI build.
 *
 * Three details are measured, not stylistic, and each cost an evening in Noradar or Kinora:
 *
 * 1. **Open it with `open`, never by running the executable.** A binary started from a shell
 *    has no LaunchServices context: notification permission is refused with no prompt, which
 *    reads exactly like a refusal somebody made (Noradar, 14 Sep 2026), and in Kinora the
 *    notification centre trapped outright.
 * 2. **Signed, ad hoc, and in ~/Applications.** An unsigned bundle, or one run from a build
 *    directory, is refused notifications. Ad hoc is enough: nothing here is distributed.
 * 3. **The running copy is ended before the new one lands.** `open` detaches, so a process
 *    started by it belongs to nobody, and replacing the bundle under it left Noradar's old
 *    binary drawing the old icon (22 Sep 2026). It is reopened afterwards if it was running.
 *
 * Install and uninstall refuse in a linked git worktree. There is one ~/Applications/<Name>.app,
 * and a session in a worktree replacing it would end the copy somebody is using and leave a
 * branch's build behind, stamped as if it were main's. `--check` is only a read, so it runs
 * anywhere.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  BAKED_IN,
  FRAMEWORKS,
  ICON_SIZES,
  NAME,
  RESOURCES,
  SWIFT_SOURCES,
  identifierChange,
  identity,
  infoPlist,
  sourceHash,
} from './bundle.ts';
import type { Digester, Identity, SourceFile } from './bundle.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const installed = join(homedir(), 'Applications', `${NAME}.app`);
const executable = join(installed, 'Contents', 'MacOS', NAME);
const favicon = join(root, 'apps', 'web', 'public', 'favicon.svg');
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function run(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, [...args], { stdio: 'pipe' }).toString();
}

function digester(): Digester {
  const hash = createHash('sha256');
  return { update: (chunk) => void hash.update(chunk), hex: () => hash.digest('hex') };
}

function sources(): SourceFile[] {
  return BAKED_IN.map((path) => ({ path, bytes: readFileSync(join(root, path)) }));
}

/** The short sha, marked when the tree did not match it: a dirty tree has no commit. */
function builtFrom(): string {
  try {
    const sha = run('git', ['-C', root, 'rev-parse', '--short', 'HEAD']).trim();
    const dirty = run('git', ['-C', root, 'status', '--porcelain']).trim() !== '';
    return dirty ? `${sha}+local` : sha;
  } catch {
    return 'unknown';
  }
}

/** A key of the installed bundle's Info.plist: null with no bundle, `unstamped` without the key. */
function installedKey(key: string): string | null {
  const plist = join(installed, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return null;
  try {
    return run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim();
  } catch {
    return 'unstamped';
  }
}

/** `.env.mac` first if there is one; a variable already in the environment wins over it. */
function configured(): Identity {
  const file = join(root, '.env.mac');
  if (existsSync(file)) process.loadEnvFile(file);
  const decided = identity(process.env);
  if (!decided.ok) {
    console.error(decided.reason);
    console.error('Set it in the environment or in .env.mac at the repository root.');
    process.exit(2);
  }
  return decided.value;
}

function running(): boolean {
  try {
    run('pgrep', ['-f', executable]);
    return true;
  } catch {
    // pgrep exits 1 when nothing matched.
    return false;
  }
}

/**
 * EXIT STATUS IS NOT VALIDATION. `sips` answers 0 for a great deal, and an icon that came out
 * empty is not a crash, it is an app with the generic icon. So each file is checked for the
 * PNG magic and for its width, read back by a second call rather than assumed from the first.
 */
function rasterised(out: string, pixels: number): void {
  const written = readFileSync(out);
  if (!written.subarray(0, 4).equals(PNG_MAGIC)) throw new Error(`${out}: sips wrote no PNG`);
  const width = /pixelWidth:\s*(\d+)/.exec(run('sips', ['-g', 'pixelWidth', out]))?.[1];
  if (width !== String(pixels)) {
    throw new Error(`${out}: ${width ?? 'no'} pixels wide, wanted ${String(pixels)}`);
  }
}

/**
 * The Dock icon, from the same `favicon.svg` the `pwa` layer builds the web icons from, so
 * the Mac app and the installed phone app cannot wear two different marks. `sips` renders SVG
 * natively, so nothing here needs a browser. Without the file there is no icon, said out loud.
 */
function icon(into: string): boolean {
  if (!existsSync(favicon)) {
    console.log(`  no icon: ${favicon} does not exist, so the Dock shows the generic app icon`);
    return false;
  }
  const set = join(mkdtempSync(join(tmpdir(), 'mac-icon-')), `${NAME}.iconset`);
  mkdirSync(set);
  try {
    for (const { pixels, name } of ICON_SIZES) {
      const out = join(set, name);
      run('sips', [
        '-s',
        'format',
        'png',
        '-z',
        String(pixels),
        String(pixels),
        favicon,
        '--out',
        out,
      ]);
      rasterised(out, pixels);
    }
    run('iconutil', ['-c', 'icns', set, '-o', join(into, `${NAME}.icns`)]);
  } finally {
    rmSync(dirname(set), { recursive: true, force: true });
  }
  console.log(`  icon: ${String(ICON_SIZES.length)} sizes from apps/web/public/favicon.svg`);
  return true;
}

function install(newIdentifier: boolean): void {
  const who = configured();
  const change = identifierChange(
    installedKey('CFBundleIdentifier'),
    who.identifier,
    newIdentifier,
  );
  if (!change.ok) {
    console.error(change.reason);
    process.exit(1);
  }
  try {
    run('swiftc', ['--version']);
  } catch {
    console.error('swiftc is not on PATH. Install Xcode or the Command Line Tools:');
    console.error('  xcode-select --install');
    process.exit(2);
  }
  // Read before the staging directory exists: it is untracked, and asked afterwards git
  // reported every build as coming from a dirty tree.
  const commit = builtFrom();
  const hash = sourceHash(sources(), digester());

  const staging = join(root, 'apps', 'mac', 'build', `${NAME}.app`);
  rmSync(dirname(staging), { recursive: true, force: true });
  const resources = join(staging, 'Contents', 'Resources');
  mkdirSync(join(staging, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(resources, { recursive: true });

  run('swiftc', [
    '-O',
    '-o',
    join(staging, 'Contents', 'MacOS', NAME),
    ...SWIFT_SOURCES.map((path) => join(root, path)),
    ...FRAMEWORKS.flatMap((framework) => ['-framework', framework]),
  ]);
  for (const path of RESOURCES) cpSync(join(root, path), join(resources, basename(path)));
  const hasIcon = icon(resources);

  const builtAt = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const plist = join(staging, 'Contents', 'Info.plist');
  writeFileSync(
    plist,
    infoPlist({ root, sourceHash: hash, commit, builtAt, icon: hasIcon, identity: who }),
  );
  run('/usr/bin/plutil', ['-lint', plist]);

  const wasRunning = running();
  if (wasRunning) {
    run('pkill', ['-f', executable]);
    for (let i = 0; i < 50 && running(); i += 1) run('sleep', ['0.1']);
  }

  rmSync(installed, { recursive: true, force: true });
  mkdirSync(dirname(installed), { recursive: true });
  cpSync(staging, installed, { recursive: true });
  rmSync(dirname(staging), { recursive: true, force: true });
  try {
    run('xattr', ['-cr', installed]);
  } catch {
    // Nothing to clear on a bundle that was never downloaded.
  }
  run('codesign', ['--force', '--deep', '--sign', '-', installed]);
  try {
    run(LSREGISTER, ['-f', installed]);
  } catch {
    // Not fatal: `open` finds a bundle in ~/Applications on the next launch anyway.
  }

  console.log(`${NAME}.app installed to ${installed}`);
  console.log(`  ${who.identifier}, opening ${who.home}`);
  console.log(`  built from ${commit}, source ${hash.slice(0, 12)}`);
  if (wasRunning) {
    run('open', ['-a', installed]);
    console.log('  it was running, so the old copy was ended and the new one opened');
  } else {
    console.log(`Open it with: open -a ${NAME}`);
  }
  // localhost, not 127.0.0.1: Vite listens on what localhost resolves to first, [::1] alone here.
  console.log(`A dev server: quit it, then open -a ${NAME} --args --url http://localhost:5173/`);
  console.log('  at the port pnpm dev printed; a plain open -a keeps that URL, so quit to go back');
}

function check(): void {
  const who = configured();
  const want = sourceHash(sources(), digester());
  const have = installedKey('ShellSourceHash');
  if (have === null) {
    console.log(`No ${NAME}.app in ~/Applications. Run pnpm app:install.`);
    process.exit(1);
  }
  if (have !== want) {
    console.log(
      `${NAME}.app is STALE: it holds ${have.slice(0, 12)}, this checkout builds ${want.slice(0, 12)}.`,
    );
    console.log('Run pnpm app:install.');
    process.exit(1);
  }
  // The stamp covers the source, not the configuration it was built with, so those are
  // compared on their own: a home changed in .env.mac is a stale app with an unchanged hash.
  for (const [key, value] of [
    ['ShellHome', who.home],
    ['CFBundleIdentifier', who.identifier],
  ] as const) {
    const built = installedKey(key);
    if (built !== value) {
      console.log(`${NAME}.app is STALE: built with ${key} ${String(built)}, configured ${value}.`);
      console.log('Run pnpm app:install.');
      process.exit(1);
    }
  }
  console.log(`${NAME}.app is current (${want.slice(0, 12)}, ${who.home}).`);
}

function uninstall(): void {
  const identifier = installedKey('CFBundleIdentifier');
  if (running()) run('pkill', ['-f', executable]);
  rmSync(installed, { recursive: true, force: true });
  console.log(`${NAME}.app removed. Its web data (the session, the cache) stays in`);
  console.log(`~/Library/WebKit/${identifier ?? '<its identifier>'} until that is removed too.`);
}

const argv = process.argv.slice(2);
const FLAGS = ['--check', '--uninstall', '--new-identifier'];
const unknown = argv.filter((arg) => !FLAGS.includes(arg));
if (unknown.length > 0) {
  console.error(`unknown argument: ${unknown.join(' ')}`);
  process.exit(2);
}
if (!argv.includes('--check')) {
  const dir = (flag: string): string =>
    execFileSync('git', ['rev-parse', '--path-format=absolute', flag], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  if (dir('--git-dir') !== dir('--git-common-dir')) {
    console.error(
      `Refusing from a worktree: ~/Applications/${NAME}.app is the one copy everybody uses.\n` +
        'Merge the branch, then run this from the main checkout.',
    );
    process.exit(1);
  }
}
if (argv.includes('--uninstall')) uninstall();
else if (argv.includes('--check')) check();
else install(argv.includes('--new-identifier'));
