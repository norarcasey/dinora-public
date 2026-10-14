import type { RelinkAnswer } from '@dinora/core/plaid';
import { relinkAnswerSchema } from '@dinora/core/plaid';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useState } from 'react';

import { callSigned } from './call.ts';
import { ACCOUNTS, BANK_PULLS } from './queries/balances.ts';

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'asking' }
  | { readonly kind: 'open'; readonly bank: string; readonly url: string; readonly gone: boolean }
  | { readonly kind: 'reading'; readonly bank: string | null }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * A Plaid bank that wants signing in, signed in from here (BANK-12) rather than from the Mac's
 * terminal (`pnpm plaid:relink`, BANK-11). The server finds the bank and answers with Plaid's
 * Hosted Link; the page never holds a token that could read the bank.
 *
 * Plaid's page opens from a real link she taps, not `window.open` after the answer arrives: a
 * window opened once a request has come back is no longer the tap's, and a phone blocks it.
 * So the first tap asks, and the second opens. Coming back to Dinora reads Plaid again by
 * itself; *Read again* is there for when it does not.
 */
export function SignInAgain({ online }: { readonly online: boolean }) {
  const client = useQueryClient();
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function read(bank: string | null) {
    setState({ kind: 'reading', bank });
    const answer = await ask('read');
    if (answer.kind === 'read') {
      // The failure this sits under gives way to the read, and this with it.
      await client.invalidateQueries({ queryKey: BANK_PULLS.queryKey });
      await client.invalidateQueries({ queryKey: ACCOUNTS.queryKey });
      setState({ kind: 'idle' });
    } else {
      setState({ kind: 'failed', message: said(answer) });
    }
  }

  async function start() {
    setState({ kind: 'asking' });
    const answer = await ask('start');
    if (answer.kind === 'open') setState({ ...answer, gone: false });
    else if (answer.kind === 'none') await read(null);
    else setState({ kind: 'failed', message: said(answer) });
  }

  // Back from Plaid's page: the tab is seen again, and only after she went.
  const back = state.kind === 'open' && state.gone ? state.bank : null;
  const returned = useEffectEvent((bank: string) => void read(bank));
  useEffect(() => {
    if (back === null) return;
    const seen = () => {
      if (document.visibilityState === 'visible') returned(back);
    };
    document.addEventListener('visibilitychange', seen);
    return () => document.removeEventListener('visibilitychange', seen);
  }, [back]);

  if (!online) {
    return <p className="muted small">Signing in again needs a connection.</p>;
  }
  if (state.kind === 'open') {
    return (
      <div className="sign-in-again">
        <a
          className="button-link"
          href={state.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setState({ ...state, gone: true })}
        >
          Sign in to {state.bank} with Plaid
        </a>
        <p className="muted small">
          Plaid's page opens on its own. Come back here when it says you are done.
        </p>
        {state.gone && (
          <button type="button" className="quiet" onClick={() => void read(state.bank)}>
            Read {state.bank} again
          </button>
        )}
      </div>
    );
  }
  if (state.kind === 'asking' || state.kind === 'reading') {
    return (
      <p className="muted small" role="status">
        {state.kind === 'asking'
          ? 'Asking Plaid…'
          : `Reading ${state.bank ?? 'the Plaid banks'} again…`}
      </p>
    );
  }
  return (
    <div className="sign-in-again">
      <button type="button" onClick={() => void start()}>
        Sign in again
      </button>
      {state.kind === 'failed' && (
        <p className="error small" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}

function said(answer: RelinkAnswer): string {
  if (answer.kind === 'failed') return `Plaid still refuses: ${answer.reason}.`;
  if (answer.kind === 'refused') return `Not signed in again: ${answer.reason}.`;
  return 'Not signed in again: Dinora answered something unexpected.';
}

/** One step of `/api/plaid/relink`, as the signed-in session. */
function ask(step: 'start' | 'read'): Promise<RelinkAnswer> {
  return callSigned('/api/plaid/relink', { step }, relinkAnswerSchema);
}
