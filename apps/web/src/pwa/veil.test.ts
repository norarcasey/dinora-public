import { afterEach, describe, expect, it } from 'vitest';

import { watchVisibility } from './veil.ts';

let state: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });

function become(next: DocumentVisibilityState): void {
  state = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

const veiled = (): boolean => document.documentElement.hasAttribute('data-veiled');

let teardown: (() => void) | null = null;
afterEach(() => {
  teardown?.();
  teardown = null;
  state = 'visible';
});

describe('the veil', () => {
  it('covers when the app is hidden and lifts when it is back', () => {
    teardown = watchVisibility();
    expect(veiled()).toBe(false);
    become('hidden');
    expect(veiled()).toBe(true);
    become('visible');
    expect(veiled()).toBe(false);
  });

  it('covers on pagehide even while still visible', () => {
    teardown = watchVisibility();
    window.dispatchEvent(new Event('pagehide'));
    expect(veiled()).toBe(true);
    window.dispatchEvent(new Event('pageshow'));
    expect(veiled()).toBe(false);
  });

  it('stays covered on a pageshow that is not visible', () => {
    teardown = watchVisibility();
    become('hidden');
    window.dispatchEvent(new Event('pageshow'));
    expect(veiled()).toBe(true);
  });

  it('lifts and stops listening when torn down', () => {
    teardown = watchVisibility();
    become('hidden');
    teardown();
    teardown = null;
    expect(veiled()).toBe(false);
    become('hidden');
    expect(veiled()).toBe(false);
  });
});
