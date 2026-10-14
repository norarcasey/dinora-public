/**
 * The scenario, a deploy landing under a page left open, needs two builds and a real service
 * worker. What can be checked is what this module does with the container's events: ask for
 * an update when the page is seen, say so once a newer worker takes control, and not mistake
 * the first worker's arrival for a newer build.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateNotice } from './UpdateNotice.tsx';
import { CHECK_EVERY_MS, forgetUpdate, watchForUpdates } from './updates.ts';

class FakeContainer extends EventTarget {
  controller: object | null;
  readonly update = vi.fn<() => Promise<void>>(() => Promise.resolve());
  registered = true;

  constructor(controlled: boolean) {
    super();
    this.controller = controlled ? {} : null;
  }

  getRegistration(): Promise<{ update: () => Promise<void> } | undefined> {
    return Promise.resolve(this.registered ? { update: this.update } : undefined);
  }

  takeOver(): void {
    this.controller = {};
    this.dispatchEvent(new Event('controllerchange'));
  }
}

let visibility: DocumentVisibilityState = 'visible';
let teardown: (() => void) | null = null;

function install(container: FakeContainer | undefined): void {
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: container,
  });
  teardown = watchForUpdates(window);
}

function show(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  forgetUpdate();
});

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('looking for a new build', () => {
  it('asks when the page comes back into view, and not when it goes', async () => {
    const container = new FakeContainer(true);
    install(container);
    show('hidden');
    await Promise.resolve();
    expect(container.update).not.toHaveBeenCalled();
    show('visible');
    await vi.waitFor(() => expect(container.update).toHaveBeenCalledTimes(1));
  });

  it('asks every half hour while the page is seen, and not while it is hidden', async () => {
    const container = new FakeContainer(true);
    install(container);
    vi.advanceTimersByTime(CHECK_EVERY_MS);
    await vi.waitFor(() => expect(container.update).toHaveBeenCalledTimes(1));
    visibility = 'hidden';
    vi.advanceTimersByTime(CHECK_EVERY_MS);
    await Promise.resolve();
    expect(container.update).toHaveBeenCalledTimes(1);
  });

  it('shrugs off a check that fails, or a page with no worker registered', async () => {
    const container = new FakeContainer(true);
    container.update.mockRejectedValueOnce(new Error('offline'));
    install(container);
    show('visible');
    await vi.waitFor(() => expect(container.update).toHaveBeenCalledTimes(1));
    container.registered = false;
    show('visible');
    await Promise.resolve();
    expect(container.update).toHaveBeenCalledTimes(1);
  });

  it('does nothing where there is no service worker', () => {
    install(undefined);
    show('visible');
    render(<UpdateNotice reload={vi.fn()} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stops asking once torn down', async () => {
    const container = new FakeContainer(true);
    install(container);
    teardown?.();
    teardown = null;
    show('visible');
    vi.advanceTimersByTime(CHECK_EVERY_MS);
    await Promise.resolve();
    expect(container.update).not.toHaveBeenCalled();
  });
});

describe('a newer build taking over', () => {
  it('says so and offers a reload, and reloads only when asked', () => {
    const container = new FakeContainer(true);
    install(container);
    const reload = vi.fn<() => void>();
    render(<UpdateNotice reload={reload} />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => container.takeOver());
    expect(screen.getByRole('status').textContent).toContain('Dinora has been updated.');
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not take the first worker arriving for a newer build', () => {
    const container = new FakeContainer(false);
    install(container);
    render(<UpdateNotice reload={vi.fn()} />);
    act(() => container.takeOver());
    expect(screen.queryByRole('status')).toBeNull();
    act(() => container.takeOver());
    expect(screen.getByRole('status')).toBeDefined();
  });
});
