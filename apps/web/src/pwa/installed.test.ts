import { describe, expect, it } from 'vitest';

import type { DisplayEnv } from './installed.ts';
import { isInstalled, pushOffer, readDisplayEnv } from './installed.ts';

const desktop: DisplayEnv = {
  iosStandalone: null,
  standaloneDisplay: false,
  hasPushManager: true,
  hasNotification: true,
};
const iosTab: DisplayEnv = {
  iosStandalone: false,
  standaloneDisplay: false,
  hasPushManager: false,
  hasNotification: false,
};
const iosInstalled: DisplayEnv = {
  iosStandalone: true,
  standaloneDisplay: true,
  hasPushManager: true,
  hasNotification: true,
};

describe('isInstalled', () => {
  it('is false in a tab', () => {
    expect(isInstalled(desktop)).toBe(false);
    expect(isInstalled(iosTab)).toBe(false);
  });

  it('is true from either signal', () => {
    expect(isInstalled(iosInstalled)).toBe(true);
    expect(isInstalled({ ...desktop, standaloneDisplay: true })).toBe(true);
    expect(isInstalled({ ...iosTab, iosStandalone: true })).toBe(true);
  });
});

describe('pushOffer', () => {
  it('is available where the APIs are', () => {
    expect(pushOffer(desktop)).toEqual({ kind: 'available' });
    expect(pushOffer(iosInstalled)).toEqual({ kind: 'available' });
  });

  it('asks an iOS tab to install first rather than refusing', () => {
    expect(pushOffer(iosTab)).toEqual({ kind: 'install-first' });
  });

  it('is unsupported elsewhere without the APIs', () => {
    expect(pushOffer({ ...desktop, hasPushManager: false })).toEqual({ kind: 'unsupported' });
    expect(pushOffer({ ...desktop, hasNotification: false })).toEqual({ kind: 'unsupported' });
  });
});

it('reads jsdom as a desktop tab with no push', () => {
  // jsdom has neither API nor `navigator.standalone`, and no matchMedia of its own.
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
  expect(readDisplayEnv(window)).toEqual({
    iosStandalone: null,
    standaloneDisplay: false,
    hasPushManager: false,
    hasNotification: false,
  });
});
