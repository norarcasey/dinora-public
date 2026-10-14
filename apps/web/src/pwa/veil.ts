/**
 * Covers the page while it is hidden, so what the lock decides on the way back is decided
 * before anything is drawn.
 *
 * It does not hide the app switcher's card, which is what it was first written for. The
 * belief was that iOS takes that snapshot after `visibilitychange`; nobody had measured it.
 * On 27 Sep 2026 Nora looked, in the installed iPhone app: the card showed her balances.
 * `SEC-03` then also covered the page when the window lost focus, the one other signal a page
 * gets, deployed it, and the card still showed them. So a page cannot hide its switcher card
 * on iOS, and the protection for someone else holding the phone is the lock
 * (`device/lock.ts`), not this.
 *
 * What it still does: while hidden, `#root` is not drawn, and it is lifted by the same event
 * in which the lock notices the time away and marks `<html data-locked>`. So on the way back
 * after five minutes there is no frame of the app before the lock screen. Reasoned from the
 * order of the events, not seen on the phone. `pagehide` too, because a suspended PWA does not
 * always fire the first.
 */

const ATTRIBUTE = 'data-veiled';

export function watchVisibility(doc: Document = document, win: Window = window): () => void {
  const root = doc.documentElement;
  const cover = (): void => root.setAttribute(ATTRIBUTE, '');
  const onVisibility = (): void => {
    if (doc.visibilityState === 'visible') root.removeAttribute(ATTRIBUTE);
    else cover();
  };
  // Back from the bfcache: the page is shown without a visibilitychange to say so.
  const onPageShow = (): void => {
    if (doc.visibilityState === 'visible') root.removeAttribute(ATTRIBUTE);
  };

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', cover);
  win.addEventListener('pageshow', onPageShow);

  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', cover);
    win.removeEventListener('pageshow', onPageShow);
    root.removeAttribute(ATTRIBUTE);
  };
}
