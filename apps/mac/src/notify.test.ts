import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `notify.js` against a fake page, run as a classic script with a supplied `globalThis`,
 * exactly as WebKit runs it.
 *
 * The failure worth hunting is not a broken notification, which somebody notices; it is one
 * that reports itself sent and reaches nobody, or one posted for somebody who never agreed.
 * Both look like success from the page. So what was posted is asserted by content, and the
 * permission tests run in both directions — "nothing was posted" is a state a completely
 * broken script satisfies just as well.
 */
const SOURCE = readFileSync(join(import.meta.dirname, '..', 'shell', 'notify.js'), 'utf8');

type Posted = Record<string, unknown>;

/** The page's side of one notification: the few members `notify.js` promises. */
type PageNotification = {
  onerror: unknown;
  onclick: unknown;
  close: () => void;
  addEventListener: (type: string, listener: () => void) => void;
};

function isPageNotification(value: unknown): value is PageNotification {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'close') === 'function' &&
    typeof Reflect.get(value, 'addEventListener') === 'function'
  );
}

function run(options: { bridge?: boolean; engineHasOne?: boolean; frozen?: boolean } = {}) {
  const posted: Posted[] = [];
  const world: Record<string, unknown> = {
    Promise,
    setTimeout,
    Event: class {
      constructor(readonly type: string) {}
    },
  };
  if (options.engineHasOne === true) world.Notification = function engineOwn() {};
  if (options.frozen === true) {
    Object.defineProperty(world, 'Notification', {
      configurable: false,
      writable: false,
      value: () => {},
    });
  }
  if (options.bridge !== false) {
    world.webkit = {
      messageHandlers: { shellNotify: { postMessage: (m: Posted) => posted.push(m) } },
    };
  }
  // The shipped file, with a parameter NAMED globalThis shadowing node's own.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('globalThis', SOURCE)(world);

  const api = world.Notification;
  const shell = (name: string, ...args: unknown[]): void => {
    const target: unknown = world.__shellNotifier;
    if (typeof target !== 'object' || target === null) throw new Error('no __shellNotifier');
    const fn: unknown = Reflect.get(target, name);
    if (typeof fn !== 'function') throw new Error(`no ${name}`);
    Reflect.apply(fn, target, args);
  };
  const create = (title: string, options?: Record<string, unknown>): PageNotification => {
    if (typeof api !== 'function') throw new Error('no Notification');
    const made: unknown = Reflect.construct(api, [title, options]);
    if (!isPageNotification(made)) throw new Error('not a notification');
    return made;
  };
  return { posted, world, api, shell, create };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('outside the shell', () => {
  it('defines nothing when the channel is not registered', () => {
    const { world } = run({ bridge: false });
    expect(world.Notification).toBeUndefined();
    expect(world.__shellNotifier).toBeUndefined();
  });
});

describe('the permission', () => {
  it('starts at default and asks the shell what macOS says', () => {
    const { api, posted } = run();
    expect(Reflect.get(api ?? {}, 'permission')).toBe('default');
    expect(posted).toEqual([{ kind: 'permission' }]);
  });

  it('takes only the three words from the shell', () => {
    const { api, shell } = run();
    shell('permission', 'granted');
    expect(Reflect.get(api ?? {}, 'permission')).toBe('granted');
    shell('permission', 'yes please');
    expect(Reflect.get(api ?? {}, 'permission')).toBe('granted');
  });

  it('resolves requestPermission with what macOS answered, both shapes', async () => {
    const { api, shell, posted } = run();
    const heard: string[] = [];
    const promise = Reflect.apply(Reflect.get(api ?? {}, 'requestPermission'), api, [
      (s: string) => heard.push(s),
    ]);
    const request = posted.find((m) => m.kind === 'request');
    expect(request).toEqual({ kind: 'request', handle: expect.any(Number) });
    shell('resolve', request?.handle, 'denied');
    await expect(promise).resolves.toBe('denied');
    expect(heard).toEqual(['denied']);
    expect(Reflect.get(api ?? {}, 'permission')).toBe('denied');
  });
});

describe('showing one', () => {
  it('posts the page’s own title, body and tag when granted', () => {
    const { shell, create, posted } = run();
    shell('permission', 'granted');
    create('Sync finished', { body: '3 accounts', tag: 'sync' });
    expect(posted.at(-1)).toEqual({
      kind: 'show',
      handle: expect.any(Number),
      title: 'Sync finished',
      body: '3 accounts',
      tag: 'sync',
      silent: false,
    });
  });

  it.each(['default', 'denied'])('posts nothing and fires error when %s', async (state) => {
    const { shell, create, posted } = run();
    shell('permission', state);
    const n = create('x');
    let errored = false;
    n.onerror = () => (errored = true);
    await settle();
    expect(errored).toBe(true);
    expect(posted.some((m) => m.kind === 'show')).toBe(false);
  });

  it('fires show when macOS took it, not when it was posted', async () => {
    const { shell, create, posted } = run();
    shell('permission', 'granted');
    const n = create('x');
    let shown = 0;
    n.addEventListener('show', () => (shown += 1));
    await settle();
    expect(shown).toBe(0);
    shell('shown', posted.at(-1)?.handle);
    await settle();
    expect(shown).toBe(1);
  });

  it('runs the click handler once, after which close is a no-op', async () => {
    const { shell, create, posted } = run();
    shell('permission', 'granted');
    const n = create('x', { tag: 't' });
    let clicks = 0;
    n.onclick = () => {
      clicks += 1;
      n.close();
    };
    shell('clicked', posted.at(-1)?.handle);
    await settle();
    expect(clicks).toBe(1);
    expect(posted.some((m) => m.kind === 'close')).toBe(false);
  });

  it('passes silent through rather than dropping it', () => {
    const { shell, create, posted } = run();
    shell('permission', 'granted');
    create('x', { silent: true });
    expect(posted.at(-1)?.silent).toBe(true);
  });
});

describe('the engine’s own Notification', () => {
  it('is replaced, and the replacement reported', () => {
    const { world, posted } = run({ engineHasOne: true });
    expect(Reflect.get(world.Notification ?? {}, 'name')).toBe('Notification');
    expect(posted).toContainEqual({ kind: 'displaced' });
  });

  it('says so when it cannot be replaced, and installs nothing else', () => {
    const { world, posted } = run({ frozen: true });
    expect(posted).toContainEqual({ kind: 'notDefined' });
    expect(world.__shellNotifier).toBeUndefined();
  });
});
