/**
 * The scenario — a deploy landing under a tab open since the one before — needs two builds
 * and a service worker swapping between them, which no test here can stage. What can be
 * checked is the decision this module makes when Vite says a chunk has gone: reload once,
 * never twice, and never quietly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUILD } from '../build.ts';
import { watchForStaleChunks } from './staleChunks.ts';

const RELOADED_FOR = 'dinora.stale-chunk-reload';

let teardown: (() => void) | null = null;
const reload = vi.fn<() => void>();

function preloadError(): Event {
  const event = new Event('vite:preloadError', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

function install(): void {
  teardown = watchForStaleChunks(window, reload);
}

beforeEach(() => {
  window.sessionStorage.clear();
  reload.mockClear();
});

afterEach(() => {
  teardown?.();
  teardown = null;
});

describe('a chunk this build can no longer fetch', () => {
  it('reloads', () => {
    install();
    preloadError();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads once however many times the event arrives', () => {
    // One failed import dispatches per preload link and again for the module itself.
    install();
    preloadError();
    preloadError();
    preloadError();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not cancel the event', () => {
    // Cancelling makes Vite resolve the import with `undefined` rather than reject.
    install();
    expect(preloadError().defaultPrevented).toBe(false);
  });

  it('records which build reloaded', () => {
    install();
    preloadError();
    expect(window.sessionStorage.getItem(RELOADED_FOR)).toBe(BUILD);
  });
});

describe('the reload it has already tried', () => {
  it('is not tried again by the same build', () => {
    window.sessionStorage.setItem(RELOADED_FOR, BUILD);
    install();
    preloadError();
    expect(reload).not.toHaveBeenCalled();
  });

  it('is tried again by a different build', () => {
    window.sessionStorage.setItem(RELOADED_FOR, 'a1b2c3d');
    install();
    preloadError();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

it('does not reload when the guard cannot be written', () => {
  install();
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('denied', 'SecurityError');
  });
  try {
    preloadError();
    expect(reload).not.toHaveBeenCalled();
  } finally {
    setItem.mockRestore();
  }
});

it('stops listening when torn down', () => {
  install();
  teardown?.();
  teardown = null;
  preloadError();
  expect(reload).not.toHaveBeenCalled();
});
