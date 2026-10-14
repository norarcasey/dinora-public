import { sourceName } from '@dinora/core/balances';
import { readAnswerSchema } from '@dinora/core/reading';
import type { ReadAnswer, ReadSource } from '@dinora/core/reading';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { Refused } from './call.ts';
import { callSigned } from './call.ts';
import { ACCOUNTS, BANK_PULLS } from './queries/balances.ts';

/**
 * The Bridge's own page, where her connections are listed and each one that wants attention
 * says so. Not one connection's page: the Bridge's answer gives no address for one (BANK-13).
 */
export const BRIDGE_HOME = 'https://beta-bridge.simplefin.org/';

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'read' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * A source read again from here, now (BANK-18): a night's read, when a bank's balances have
 * missed a night and nothing says why. Sits under the banks it is about, on the home screen
 * and on an account's page, and both take it away once the read has moved them.
 *
 * So this is still on screen after a read only when the read changed nothing, and then it
 * says so, and where to look next. Dinora reads the aggregator; the aggregator asks the bank
 * on its own schedule, and Dinora cannot hurry it. Measured 28 Sep 2026: SUMMIT's balances were
 * 40 hours old at the Bridge itself, which answered a fresh request in 3 s with nothing newer
 * and no complaint. A bank the Bridge does complain of is offered its sign-in elsewhere.
 */
export function ReadAgain({
  source,
  still,
  online,
}: {
  readonly source: ReadSource;
  /** What the read left as it was, when it did: "it" or "them". */
  readonly still: string;
  readonly online: boolean;
}) {
  const client = useQueryClient();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const name = sourceName(source);

  async function read() {
    setState({ kind: 'reading' });
    const answer = await callSigned('/api/bank/read', { source }, readAnswerSchema);
    if (answer.kind === 'read') {
      // Awaited, so what is on screen when this says "still" is what the read stored.
      await client.invalidateQueries({ queryKey: BANK_PULLS.queryKey });
      await client.invalidateQueries({ queryKey: ACCOUNTS.queryKey });
      setState({ kind: 'read' });
    } else {
      setState({ kind: 'failed', message: said(answer, name) });
    }
  }

  if (!online) {
    return <p className="muted small">Reading again needs a connection.</p>;
  }
  if (state.kind === 'reading') {
    return (
      <p className="muted small" role="status">
        Reading {name} again…
      </p>
    );
  }
  return (
    <div className="read-again">
      <button type="button" onClick={() => void read()}>
        Read {name} again
      </button>
      {state.kind === 'read' && (
        <p className="small">
          {name} was read just now and still has {still} as{' '}
          {still === 'it' ? 'it was' : 'they were'}.{' '}
          {source === 'simplefin' ? (
            <>
              SimpleFIN asks each bank on its own, about once a day. If this keeps up, check the
              connection at{' '}
              <a href={BRIDGE_HOME} target="_blank" rel="noopener noreferrer">
                SimpleFIN
              </a>
              .
            </>
          ) : (
            'Plaid asks the bank on its own. If it needs signing in again, Plaid will say so here.'
          )}
        </p>
      )}
      {state.kind === 'failed' && (
        <p className="error small" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}

function said(answer: ReadAnswer | Refused, name: string): string {
  if (answer.kind === 'failed') return `The ${name} read failed: ${answer.reason}.`;
  if (answer.kind === 'refused') return `Not read: ${answer.reason}.`;
  return 'Not read: Dinora answered something unexpected.';
}
