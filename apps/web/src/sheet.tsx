import type { ReactNode } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import { notDone } from './queries/writes.ts';

/**
 * Where a change is made (UI-03): a page shows the facts, and editing them opens this over it,
 * from the bottom on a phone and from the side on the Mac. The design audit (26 Sep) found the
 * asset and goal pages were more than half open forms, filled in, under what they were for.
 *
 * The browser's own modal dialog, so the page behind is inert, focus stays inside, and Escape
 * closes it, all without code here that could get them wrong. What it holds is rendered only
 * while it is open, so every opening starts from the row as it stands, not a stale draft.
 */
export function Sheet({
  title,
  variant = 'sheet',
  open,
  onClose,
  children,
}: {
  readonly title: string;
  /**
   * A palette (UI-10) is a box to type in, not a form to fill: it drops from the top on the Mac,
   * where the eye already is, rather than covering the side of the page.
   */
  readonly variant?: 'sheet' | 'palette';
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // The dialog gives focus to the first thing it can, which is Close. React never writes
      // `autofocus` to the page, so what is to be typed in first says so here instead.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={variant === 'palette' ? 'sheet palette' : 'sheet'}
      aria-labelledby={titleId}
      // Escape closes the dialog itself; this keeps the state that says it is open in step.
      onClose={onClose}
      // The dialog fills its box edge to edge, so a click that lands on it and not on anything
      // inside is a click on the dimmed page around it.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="quiet" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="sheet-body">{open && children}</div>
    </dialog>
  );
}

/**
 * Taking a whole thing away, at the foot of its sheet and apart from the form above it. Two
 * steps, since a slip of the thumb should not remove it; the second says what removing does and
 * is the only red button in the app. The row is kept in its table all the same (invariant 2).
 * It was an underlined link beside Keep, the two the same size and 21px tall (26 Sep).
 */
export function DangerZone({
  label,
  consequence,
  online,
  onRemove,
}: {
  /** "Remove Civic". */
  readonly label: string;
  /** What removing does, said before it is done. */
  readonly consequence: string;
  readonly online: boolean;
  readonly onRemove: () => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await onRemove();
    } catch (error) {
      setFailed(notDone(error, 'removed'));
      setBusy(false);
    }
  };

  return (
    <div className="danger-zone">
      {asking ? (
        <>
          <p className="danger-question">{consequence}</p>
          <button
            type="button"
            className="danger"
            aria-label={`Yes, ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
            disabled={!online || busy}
            onClick={() => void remove()}
          >
            {busy ? 'Removing…' : 'Remove'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setAsking(false)}
          >
            Keep
          </button>
        </>
      ) : (
        <button
          type="button"
          className="quiet danger"
          disabled={!online}
          onClick={() => setAsking(true)}
        >
          {label}
        </button>
      )}
      {failed !== null && (
        <p className="error form-error" role="alert">
          {failed}
        </p>
      )}
    </div>
  );
}
