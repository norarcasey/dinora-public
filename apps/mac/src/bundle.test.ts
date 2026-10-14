import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BAKED_IN, RESOURCES, SWIFT_SOURCES, infoPlist, sourceHash } from './bundle.ts';
import type { Digester } from './bundle.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

function digester(): Digester {
  const hash = createHash('sha256');
  return { update: (chunk) => void hash.update(chunk), hex: () => hash.digest('hex') };
}

const plan = { root: '/r', sourceHash: 'abc', commit: '1234567', builtAt: '24 Sep', icon: true };

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
