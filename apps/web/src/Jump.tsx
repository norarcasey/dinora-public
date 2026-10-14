import type { Jump } from '@dinora/core/jump';
import { findJumps, jumpTargets } from '@dinora/core/jump';
import { useEffect, useId, useMemo, useState } from 'react';

import { ASSETS } from './queries/assets.ts';
import { ACCOUNTS } from './queries/balances.ts';
import { TRANSACTIONS } from './queries/budgets.ts';
import { GOALS } from './queries/goals.ts';
import { useSynced } from './queries/synced.ts';
import { accountHref, activityHref, assetHref, budgetHref, goalHref, payeeHref } from './route.ts';
import { Sheet } from './sheet.tsx';
import { localDay, LOCALE, useNow } from './time.tsx';

/** Enough to find the one meant; past it, another letter is quicker than scrolling. */
export const JUMPS_SHOWN = 8;

export function jumpHref(jump: Jump): string {
  switch (jump.kind) {
    case 'account':
      return accountHref(jump.id);
    case 'goal':
      return goalHref(jump.id);
    case 'asset':
      return assetHref(jump.id);
    case 'payee':
      return payeeHref(jump.id);
    case 'month':
      return budgetHref(jump.id);
  }
}

/** ⌘K on a Mac, Ctrl+K anywhere else, as every app that has one does. */
function isJumpKey(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'k'
  );
}

const ON_A_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

/**
 * ⌘K anywhere (UI-10): from any screen, one keystroke and a few letters go to any account,
 * payee, goal, thing she owns or month. The Mac's form of Activity's search (ACCT-14), and web
 * code, so the Mac window has it with no line of Swift (invariant 13); an iPad with a keyboard
 * has it too.
 *
 * The button says the key exists, and is there only where there is room: a phone has Activity's
 * search one tab away and no keyboard to press it with.
 */
export function JumpTo() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isJumpKey(event)) return;
      // Not over another sheet: a second dialog on a half-made change hides the change.
      if (document.querySelector('dialog[open]:not(.palette)') !== null) return;
      event.preventDefault();
      setOpen((was) => !was);
    };
    // Going anywhere closes it, whether by a result, Enter, or the back gesture.
    const onMove = () => setOpen(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onMove);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onMove);
    };
  }, []);

  return (
    <>
      <button type="button" className="quiet jump" onClick={() => setOpen(true)}>
        Jump to <kbd>{ON_A_MAC ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <Sheet title="Jump to" variant="palette" open={open} onClose={() => setOpen(false)}>
        <JumpSearch onGo={() => setOpen(false)} />
      </Sheet>
    </>
  );
}

type Option = {
  readonly key: string;
  readonly href: string;
  readonly label: string;
  readonly detail: string;
};

// One array for every "not held", so the memo below does not see a new one on each render.
const EMPTY: readonly never[] = [];

/**
 * Rendered only while the sheet is open, so the targets are built when it opens, from the rows
 * on the device then, and nothing is worked out on pages where it is never opened.
 */
function JumpSearch({ onGo }: { readonly onGo: () => void }) {
  const today = localDay(useNow());
  const accounts = useSynced(ACCOUNTS);
  const goals = useSynced(GOALS);
  const assets = useSynced(ASSETS);
  const transactions = useSynced(TRANSACTIONS);
  const accountRows = accounts.status === 'held' ? accounts.rows : EMPTY;
  const goalRows = goals.status === 'held' ? goals.rows : EMPTY;
  const assetRows = assets.status === 'held' ? assets.rows : EMPTY;
  const txnRows = transactions.status === 'held' ? transactions.rows : EMPTY;

  const targets = useMemo(
    () =>
      jumpTargets({
        accounts: accountRows,
        goals: goalRows,
        assets: assetRows,
        transactions: txnRows,
        today,
        locale: LOCALE,
      }),
    [accountRows, goalRows, assetRows, txnRows, today],
  );

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const typed = query.trim();

  const options = useMemo((): Option[] => {
    if (typed === '') return [];
    const found: Option[] = findJumps(typed, targets, JUMPS_SHOWN).map((jump) => ({
      key: `${jump.kind}:${jump.id}`,
      href: jumpHref(jump),
      label: jump.label,
      detail: jump.detail,
    }));
    // Always last, so a word that names no place still gets somewhere: its transactions.
    found.push({
      key: 'activity',
      href: activityHref(typed),
      label: `Search transactions for “${typed}”`,
      detail: 'Activity',
    });
    return found;
  }, [typed, targets]);

  const chosen = Math.min(active, options.length - 1);
  const optionId = (index: number) => `${listId}-${index}`;

  const go = (option: Option | undefined) => {
    if (option === undefined) return;
    onGo();
    window.location.hash = option.href;
  };

  return (
    <div className="jump-search">
      <input
        data-autofocus
        role="combobox"
        aria-label="Jump to"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={options.length > 0 ? optionId(chosen) : undefined}
        type="text"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        placeholder="An account, payee, goal or month"
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (options.length === 0) return;
            const by = event.key === 'ArrowDown' ? 1 : -1;
            setActive((chosen + by + options.length) % options.length);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            go(options[chosen]);
          }
        }}
      />
      <ul id={listId} role="listbox" aria-label="Places">
        {options.map((option, index) => (
          <li
            key={option.key}
            id={optionId(index)}
            role="option"
            aria-selected={index === chosen}
            onMouseMove={() => setActive(index)}
            onClick={() => go(option)}
          >
            <span>{option.label}</span>
            <span className="muted small">{option.detail}</span>
          </li>
        ))}
      </ul>
      {typed === '' && (
        <p className="muted small">
          Type a few letters of a name, or a month like <em>March</em>. ↑ and ↓ to choose, Return to
          go.
        </p>
      )}
    </div>
  );
}
