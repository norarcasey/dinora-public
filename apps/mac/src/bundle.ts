/**
 * What goes into the Mac bundle, as pure functions.
 *
 * The imperative half — swiftc, sips, codesign, copying into ~/Applications — is in
 * `install.ts` and needs a Mac. The decisions are here, so this is what CI tests: a bundle
 * nobody builds in CI is still a bundle whose Info.plist can be wrong, and whose stamp can
 * cover fewer files than it compiles.
 */

export const NAME = 'Dinora';

/**
 * Where the window opens and who the bundle is, read at install rather than written into the
 * Swift (DIN-16): someone running their own copy sets `DINORA_MAC_HOME` and
 * `DINORA_MAC_IDENTIFIER` in the root `.env.mac`, or the environment, and edits no code.
 *
 * The defaults are this deployment's, so the installed copy on this Mac keeps the identifier
 * its web data store is filed under. The public export swaps both for reserved `example`
 * names, which `identity` refuses, so a copy nobody configured says what to set instead of
 * opening a window onto a host that cannot exist.
 */
export const DEFAULT_HOME = 'https://dinora.example.com/';
export const DEFAULT_IDENTIFIER = 'com.example.dinora';

export type Identity = { readonly home: string; readonly identifier: string };

export type Decided<T> = { ok: true; value: T } | { ok: false; reason: string };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** RFC 2606 reserves these for examples, so a name under one is a placeholder nobody set. */
const RESERVED = /(^|\.)(example|test|invalid)$|(^|\.)example\.(com|net|org)$/;

export function identity(env: Readonly<Record<string, string | undefined>>): Decided<Identity> {
  const home = env['DINORA_MAC_HOME'] ?? DEFAULT_HOME;
  const identifier = env['DINORA_MAC_IDENTIFIER'] ?? DEFAULT_IDENTIFIER;
  let url: URL;
  try {
    url = new URL(home);
  } catch {
    return { ok: false, reason: `DINORA_MAC_HOME is not a URL: ${home}` };
  }
  // The same rule as the bundle's App Transport Security: plain http only on loopback.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return { ok: false, reason: `DINORA_MAC_HOME must be https, or http on localhost: ${home}` };
  }
  if (RESERVED.test(url.hostname)) {
    return {
      ok: false,
      reason: `DINORA_MAC_HOME is a placeholder (${url.hostname}): set it to where your web app is deployed`,
    };
  }
  // What CFBundleIdentifier allows: reverse-DNS, letters, digits, hyphens and dots.
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(identifier)) {
    return { ok: false, reason: `DINORA_MAC_IDENTIFIER is not a reverse-DNS name: ${identifier}` };
  }
  if (/^(com|net|org)\.example(\.|$)/.test(identifier)) {
    return {
      ok: false,
      reason: `DINORA_MAC_IDENTIFIER is a placeholder (${identifier}): set it to a reverse-DNS name of your own`,
    };
  }
  return { ok: true, value: { home: url.href, identifier } };
}

/**
 * Whether installing over what is there keeps its data. WebKit files the window's store —
 * the session, the row cache, the service worker — under the bundle identifier, so a new one
 * starts signed out with nothing cached and leaves the old store behind, unreachable. That is
 * sometimes wanted, never by accident.
 */
export function identifierChange(
  installed: string | null,
  wanted: string,
  allowed: boolean,
): Decided<null> {
  if (installed === null || installed === wanted || allowed) return { ok: true, value: null };
  return {
    ok: false,
    reason:
      `The installed app is ${installed}; this would install ${wanted}. Its session and ` +
      `cached rows stay in ~/Library/WebKit/${installed}, where the new one cannot read them. ` +
      'Pass --new-identifier to install it anyway.',
  };
}

/**
 * The files whose bytes ARE the app: stamped into it, and the only Swift compiled into it.
 *
 * Not the repository's HEAD: a commit to `apps/web` leaves the bundle correct — the window
 * loads the page from the server — and an alarm that fires on every commit is ignored by the
 * third day. `bundle.test.ts` scans `apps/mac/shell` and fails on a file that exists and is
 * not listed, so a new Swift file cannot be compiled in unhashed or hashed and not compiled.
 *
 * The icon is left out knowingly: it is rendered at install from `apps/web/public/favicon.svg`,
 * and stamping that would fire on every change to the web app's mark. The code that renders
 * it is stamped, so only the picture can drift, and a picture is something you can see.
 */
export const BAKED_IN: readonly string[] = [
  'apps/mac/shell/App.swift',
  'apps/mac/shell/Boundary.swift',
  'apps/mac/shell/Menus.swift',
  'apps/mac/shell/Notify.swift',
  'apps/mac/shell/Provenance.swift',
  'apps/mac/shell/Shell.swift',
  'apps/mac/shell/StatusItem.swift',
  'apps/mac/shell/main.swift',
  'apps/mac/shell/notify.js',
  'apps/mac/src/bundle.ts',
  'apps/mac/src/install.ts',
].sort();

/** Derived from the stamp, never listed beside it: two lists are one list and a way to differ. */
export const SWIFT_SOURCES: readonly string[] = BAKED_IN.filter((p) => p.endsWith('.swift'));

/** Copied into `Contents/Resources` under their own names, and read from there at launch. */
export const RESOURCES: readonly string[] = BAKED_IN.filter((p) => p.endsWith('.js'));

/** What swiftc links. Named even where Swift would autolink, so a missing one says which. */
export const FRAMEWORKS: readonly string[] = [
  'Cocoa',
  'WebKit',
  'UserNotifications',
  'Network',
  'CryptoKit',
];

export type SourceFile = { readonly path: string; readonly bytes: Uint8Array };
export type Digester = {
  update: (chunk: string | Uint8Array) => void;
  hex: () => string;
};

/**
 * A digest over exactly `BAKED_IN`, path and length before each file so that moving a byte
 * from one file to the next changes it. `Provenance.swift` computes the same thing at runtime.
 * Refuses any other set: a stamp over a subset says "unchanged" about a file it never read.
 */
export function sourceHash(files: readonly SourceFile[], digest: Digester): string {
  const got = files.map((f) => f.path).sort();
  if (got.length !== BAKED_IN.length || got.some((p, i) => p !== BAKED_IN[i])) {
    throw new Error(`sourceHash: expected [${BAKED_IN.join(', ')}], got [${got.join(', ')}]`);
  }
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    digest.update(`${file.path}\n${String(file.bytes.length)}\n`);
    digest.update(file.bytes);
  }
  return digest.hex();
}

/**
 * The icon sizes `iconutil` expects in an `.iconset`, each rendered straight from the SVG
 * rather than scaled from a bitmap.
 */
export const ICON_SIZES: readonly { readonly pixels: number; readonly name: string }[] = [
  { pixels: 16, name: 'icon_16x16.png' },
  { pixels: 32, name: 'icon_16x16@2x.png' },
  { pixels: 32, name: 'icon_32x32.png' },
  { pixels: 64, name: 'icon_32x32@2x.png' },
  { pixels: 128, name: 'icon_128x128.png' },
  { pixels: 256, name: 'icon_128x128@2x.png' },
  { pixels: 256, name: 'icon_256x256.png' },
  { pixels: 512, name: 'icon_256x256@2x.png' },
  { pixels: 512, name: 'icon_512x512.png' },
  { pixels: 1024, name: 'icon_512x512@2x.png' },
];

export type BundlePlan = {
  /** The checkout the stamp's paths are relative to. */
  readonly root: string;
  readonly sourceHash: string;
  /** The short sha, `+local` when the tree was dirty, or `unknown` — never a guess. */
  readonly commit: string;
  /** Passed in, so this reads no clock. */
  readonly builtAt: string;
  readonly icon: boolean;
  readonly identity: Identity;
};

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The bundle's Info.plist.
 *
 * App Transport Security is relaxed for loopback only — `127.0.0.1` and `localhost`, where a
 * dev server runs over http — so pointing the window at any other plain-http host still fails.
 *
 * There is no `WKAppBoundDomains`. Kinora measured (`MAC-01`) that app-bound domains is inert
 * on macOS: asked for, it reads back false. Declaring hosts there would look like a guarantee
 * covering nothing; the window's hosts are kept by `Boundary.swift` instead.
 */
export function infoPlist(plan: BundlePlan): string {
  const exempt = ['127.0.0.1', 'localhost']
    .map(
      (host) =>
        `    <key>${host}</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${xml(NAME)}</string>
  <key>CFBundleDisplayName</key><string>${xml(NAME)}</string>
  <key>CFBundleIdentifier</key><string>${xml(plan.identity.identifier)}</string>
  <key>CFBundleExecutable</key><string>${xml(NAME)}</string>
${plan.icon ? `  <key>CFBundleIconFile</key><string>${xml(NAME)}</string>\n` : ''}  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>ShellHome</key><string>${xml(plan.identity.home)}</string>
  <key>ShellSourceRoot</key><string>${xml(plan.root)}</string>
  <key>ShellSourceHash</key><string>${xml(plan.sourceHash)}</string>
  <key>ShellSourceFiles</key>
  <array>${BAKED_IN.map((p) => `<string>${xml(p)}</string>`).join('')}</array>
  <key>ShellBuiltFromCommit</key><string>${xml(plan.commit)}</string>
  <key>ShellBuiltAt</key><string>${xml(plan.builtAt)}</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSExceptionDomains</key><dict>
${exempt}
  </dict></dict>
</dict>
</plist>
`;
}
