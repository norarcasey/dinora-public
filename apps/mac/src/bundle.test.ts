import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BAKED_IN,
  DEFAULT_HOME,
  DEFAULT_IDENTIFIER,
  RESOURCES,
  SWIFT_SOURCES,
  identifierChange,
  identity,
  infoPlist,
  sourceHash,
} from './bundle.ts';
import type { Digester } from './bundle.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

function digester(): Digester {
  const hash = createHash('sha256');
  return { update: (chunk) => void hash.update(chunk), hex: () => hash.digest('hex') };
}

const plan = {
  root: '/r',
  sourceHash: 'abc',
  commit: '1234567',
  builtAt: '24 Sep',
  icon: true,
  identity: { home: 'https://money.someone.dev/', identifier: 'dev.someone.money' },
};

describe('what the bundle is built from', () => {
  it('stamps every file in apps/mac/shell and compiles every Swift file it stamps', () => {
    // Closed both ways: a file that exists and is not listed would be compiled in by nobody
    // or, worse, hand-added to swiftc and never hashed.
    const onDisk = readdirSync(join(root, 'apps/mac/shell')).map(
      (name) => `apps/mac/shell/${name}`,
    );
    expect(BAKED_IN.filter((p) => p.startsWith('apps/mac/shell/'))).toEqual([...onDisk].sort());
    expect(SWIFT_SOURCES).toContain('apps/mac/shell/main.swift');
    expect(SWIFT_SOURCES.every((p) => p.endsWith('.swift'))).toBe(true);
    expect(RESOURCES).toEqual(['apps/mac/shell/notify.js']);
  });

  it('changes the hash when a byte moves from one file to the next', () => {
    const files = (a: string, b: string) =>
      BAKED_IN.map((path, i) => ({
        path,
        bytes: new TextEncoder().encode(i === 0 ? a : i === 1 ? b : 'x'),
      }));
    expect(sourceHash(files('ab', 'c'), digester())).not.toBe(
      sourceHash(files('a', 'bc'), digester()),
    );
  });

  it('refuses a set that is not exactly what is stamped', () => {
    const some = BAKED_IN.slice(1).map((path) => ({ path, bytes: new Uint8Array() }));
    expect(() => sourceHash(some, digester())).toThrow(/expected/);
  });
});

describe('Info.plist', () => {
  it('exempts loopback from App Transport Security and nothing else', () => {
    const plist = infoPlist(plan);
    const exempt = [
      ...plist.matchAll(/<key>([^<]+)<\/key><dict><key>NSExceptionAllowsInsecure/g),
    ].map((m) => m[1]);
    expect(exempt).toEqual(['127.0.0.1', 'localhost']);
    expect(plist).not.toContain('NSAllowsArbitraryLoads');
  });

  it('declares no app-bound domains, which are inert on macOS', () => {
    expect(infoPlist(plan)).not.toContain('WKAppBoundDomains');
  });

  it('carries the stamp Provenance.swift reads, under the keys it reads', () => {
    const plist = infoPlist(plan);
    const swift = read('apps/mac/shell/Provenance.swift');
    for (const key of [
      'ShellSourceRoot',
      'ShellSourceHash',
      'ShellSourceFiles',
      'ShellBuiltFromCommit',
      'ShellBuiltAt',
    ]) {
      expect(plist).toContain(`<key>${key}</key>`);
      expect(swift).toContain(`"${key}"`);
    }
    for (const path of BAKED_IN) expect(plist).toContain(`<string>${path}</string>`);
  });

  it('carries the identity it was configured with, under the key App.swift reads', () => {
    const plist = infoPlist(plan);
    expect(plist).toContain('<key>CFBundleIdentifier</key><string>dev.someone.money</string>');
    expect(plist).toContain('<key>ShellHome</key><string>https://money.someone.dev/</string>');
    expect(read('apps/mac/shell/App.swift')).toContain('forInfoDictionaryKey: "ShellHome"');
  });

  it('names an icon only when one was rendered', () => {
    expect(infoPlist(plan)).toContain('CFBundleIconFile');
    expect(infoPlist({ ...plan, icon: false })).not.toContain('CFBundleIconFile');
  });

  it('escapes what it is given', () => {
    expect(infoPlist({ ...plan, root: '/a&b<c' })).toContain('/a&amp;b&lt;c');
  });
});

describe('the seam between the page and the shell', () => {
  const swift = read('apps/mac/shell/Notify.swift');
  const script = read('apps/mac/shell/notify.js');

  it('uses one channel name and one namespace on both sides', () => {
    const channel = /static let channel = "([^"]+)"/.exec(swift)?.[1];
    const namespace = /static let namespace = "([^"]+)"/.exec(swift)?.[1];
    expect(channel).toBeDefined();
    expect(namespace).toBeDefined();
    expect(script).toContain(`var CHANNEL = '${String(channel)}';`);
    expect(script).toContain(`var NAMESPACE = '${String(namespace)}';`);
  });

  it('sends nothing back into the page but integers and the three permission words', () => {
    // Every call the shell makes into the page's JavaScript, and what is interpolated into
    // each. A title, a body or a tag in this list would be page text becoming code.
    const calls = [...swift.matchAll(/tell\("([^"]*)"\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    const interpolated = new Set(
      calls.flatMap((call) => [...(call ?? '').matchAll(/\\\(([^)]*)\)/g)].map((m) => m[1])),
    );
    expect([...interpolated].sort()).toEqual(['handle', 'state']);
    // `state` is only ever one of the words `word(_:)` returns, or a literal.
    expect(swift).toMatch(/private static func word\(_ status: UNAuthorizationStatus\) -> String/);
  });
});

describe('who the bundle is', () => {
  const own = {
    DINORA_MAC_HOME: 'https://money.someone.dev',
    DINORA_MAC_IDENTIFIER: 'dev.someone.money',
  };

  it('takes both from the environment, and normalises the URL', () => {
    expect(identity(own)).toEqual({
      ok: true,
      value: { home: 'https://money.someone.dev/', identifier: 'dev.someone.money' },
    });
  });

  it('allows plain http on loopback only, as App Transport Security does', () => {
    expect(identity({ ...own, DINORA_MAC_HOME: 'http://localhost:5173/' }).ok).toBe(true);
    expect(identity({ ...own, DINORA_MAC_HOME: 'http://money.someone.dev/' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/https/),
    });
    expect(identity({ ...own, DINORA_MAC_HOME: 'ftp://money.someone.dev/' }).ok).toBe(false);
    expect(identity({ ...own, DINORA_MAC_HOME: 'not a url' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a URL/),
    });
  });

  it('refuses the placeholders a public copy carries, naming what to set', () => {
    // What the export's map puts in place of this deployment's names: a copy nobody
    // configured must refuse, not open a window onto a host that cannot exist.
    for (const home of ['https://dinora.example.com/', 'https://example.org/', 'https://a.test/']) {
      expect(identity({ ...own, DINORA_MAC_HOME: home })).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/DINORA_MAC_HOME is a placeholder/),
      });
    }
    expect(identity({ ...own, DINORA_MAC_IDENTIFIER: 'com.example.dinora' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/DINORA_MAC_IDENTIFIER is a placeholder/),
    });
    // Only the reserved names: a real domain that happens to contain the word is fine.
    expect(identity({ ...own, DINORA_MAC_HOME: 'https://example-money.dev/' }).ok).toBe(true);
    expect(identity({ ...own, DINORA_MAC_IDENTIFIER: 'com.examples.money' }).ok).toBe(true);
  });

  it('refuses an identifier that is not reverse-DNS', () => {
    for (const id of ['money', 'dev.someone money', 'dev..money', 'dev.someone/money']) {
      expect(identity({ ...own, DINORA_MAC_IDENTIFIER: id })).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/reverse-DNS/),
      });
    }
  });

  it('falls back to the defaults when nothing is set', () => {
    // Compared with the defaults passed by name, not with literals: the export swaps them for
    // placeholders, and this has to hold in that copy too, where both answers are a refusal.
    expect(identity({})).toEqual(
      identity({ DINORA_MAC_HOME: DEFAULT_HOME, DINORA_MAC_IDENTIFIER: DEFAULT_IDENTIFIER }),
    );
  });
});

describe('installing over an existing bundle', () => {
  it('goes ahead on a first install or the same identifier', () => {
    expect(identifierChange(null, 'dev.someone.money', false).ok).toBe(true);
    expect(identifierChange('dev.someone.money', 'dev.someone.money', false).ok).toBe(true);
  });

  it('refuses a new identifier unless asked, naming the store it would leave behind', () => {
    const refused = identifierChange('dev.someone.money', 'dev.someone.cash', false);
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) {
      expect(refused.reason).toContain('~/Library/WebKit/dev.someone.money');
      expect(refused.reason).toContain('--new-identifier');
    }
    expect(identifierChange('dev.someone.money', 'dev.someone.cash', true).ok).toBe(true);
  });
});
