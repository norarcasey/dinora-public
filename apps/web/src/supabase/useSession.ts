import { useEffect, useState } from 'react';

import { auth } from './client.ts';
import type { SessionUser } from './remembered.ts';
import { judge, readStoredSession, rememberedUser, sessionUserOf } from './remembered.ts';

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly user: SessionUser };

/**
 * Who is signed in, answered from this device first and the server second. See
 * `remembered.ts` for why the order matters.
 *
 * The first render comes from the stored session — no spinner, no network. `getSession()`
 * then runs: a server that says no signs you out, a server that cannot be reached changes
 * nothing.
 */
export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>(() => {
    const user = rememberedUser(readStoredSession());
    return user === null ? { status: 'loading' } : { status: 'signed-in', user };
  });

  useEffect(() => {
    let active = true;
    const settleEmpty = (current: SessionState): SessionState =>
      current.status === 'loading' ? { status: 'signed-out' } : current;

    auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return;
        const verdict = judge({ session: data.session, error });
        setState((current) => {
          if (verdict.kind === 'signed-in') return { status: 'signed-in', user: verdict.user };
          if (verdict.kind === 'signed-out') return { status: 'signed-out' };
          // No answer: whatever was remembered stands.
          return settleEmpty(current);
        });
      })
      .catch(() => {
        // Storage or the cross-tab lock threw — not an answer from anybody.
        if (active) setState(settleEmpty);
      });

    const { data } = auth.onAuthStateChange((event, session) => {
      // Answered above, with the error this event drops — and the error is the whole
      // difference between a server saying no and no server at all.
      if (event === 'INITIAL_SESSION') return;
      setState(
        session === null
          ? { status: 'signed-out' }
          : { status: 'signed-in', user: sessionUserOf(session.user) },
      );
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return state;
}
