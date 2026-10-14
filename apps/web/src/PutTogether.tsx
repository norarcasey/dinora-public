import type { Double, JoinAnswer } from '@dinora/core/doubles';
import { joinAnswerSchema } from '@dinora/core/doubles';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { callSigned } from './call.ts';
import { ACCOUNTS } from './queries/balances.ts';
import { TRANSACTIONS } from './queries/budgets.ts';
import { BALANCE_SNAPSHOTS } from './queries/history.ts';

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'asking' }
  | { readonly kind: 'working' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * One pair of the *may be counted twice* flag, put together from here (BANK-17) rather than
 * with `pnpm monarch:import --link` on the Mac (BANK-15). Two taps: the first says what will
 * happen, naming both accounts, and the second does it. It is the one thing in Dinora that
 * moves years of history, and a wrong pair is fixed only by hand, so it never happens on one.
 *
 * On success nothing is said here: the copy is retired, so once the rows are read again the
 * pair is no longer a double, and the flag, or this line of it, is gone.
 */
export function PutTogether({
  pair,
  goals,
  online,
}: {
  readonly pair: Double;
  /** The goals that count the Monarch copy, which the join cannot move. */
  readonly goals: readonly string[];
  readonly online: boolean;
}) {
  const client = useQueryClient();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const bankName = pair.bank.name || 'the bank’s account';

  async function join() {
    setState({ kind: 'working' });
    const answer = await ask(pair.monarch.id, pair.bank.id);
    if (answer.kind === 'refused') {
      setState({ kind: 'failed', message: `Not put together: ${answer.reason}.` });
      return;
    }
    await Promise.all(
      [ACCOUNTS, BALANCE_SNAPSHOTS, TRANSACTIONS].map((table) =>
        client.invalidateQueries({ queryKey: table.queryKey }),
      ),
    );
    setState({ kind: 'idle' });
  }

  if (!online) return <p className="muted small">Putting them together needs a connection.</p>;
  if (state.kind === 'asking' || state.kind === 'working') {
    return (
      <div className="danger-zone">
        <p className="danger-question">
          Monarch’s history of {pair.monarch.name} moves onto {bankName}, for the days before the
          bank’s own, and the Monarch copy is retired. Your categories go with the transactions.
          Undoing it is a fix by hand.
          {goals.length > 0 &&
            ` ${goals.join(', ')} ${goals.length === 1 ? 'counts' : 'count'} the Monarch copy: add ${bankName} to ${goals.length === 1 ? 'it' : 'them'} afterwards.`}
        </p>
        <button
          type="button"
          aria-label={`Yes, put ${pair.monarch.name} and ${bankName} together`}
          disabled={state.kind === 'working'}
          onClick={() => void join()}
        >
          {state.kind === 'working' ? 'Putting together…' : 'Put together'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={state.kind === 'working'}
          onClick={() => setState({ kind: 'idle' })}
        >
          Keep both
        </button>
      </div>
    );
  }
  return (
    <div className="sign-in-again">
      <button type="button" onClick={() => setState({ kind: 'asking' })}>
        Put these together
      </button>
      {state.kind === 'failed' && (
        <p className="error small" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}

/** `/api/monarch/join`, as the signed-in session. */
function ask(monarch: string, bank: string): Promise<JoinAnswer> {
  return callSigned('/api/monarch/join', { monarch, bank }, joinAnswerSchema);
}
