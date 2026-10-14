import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library unmounts after each test by itself only when Vitest's globals are on, and
// they are off here so every test imports what it uses. Without this, the second test in a
// file queries a DOM still holding the first one's render.
afterEach(cleanup);

// jsdom 30 has <dialog> but not its methods. The sheet (UI-03) opens one; what a browser adds
// on top of `open` — the inert page, the focus trap — is the browser's, and is not what these
// tests are about.
if (typeof HTMLDialogElement !== 'undefined' && !('showModal' in HTMLDialogElement.prototype)) {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      value(this: HTMLDialogElement) {
        if (!this.open) return;
        this.open = false;
        this.dispatchEvent(new Event('close'));
      },
    },
  });
}

// Nor has it scrolling. The budget page brings its list into view when a filter opens it
// (UI-08); where it scrolls to is the browser's, and is not what these tests are about.
if (typeof Element !== 'undefined' && !('scrollIntoView' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value() {} });
}
