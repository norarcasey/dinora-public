import { useEffect, useState } from 'react';

import { AccountDetails } from './AccountDetails.tsx';
import { Activity } from './Activity.tsx';
import { AssetDetails, NewAsset } from './AssetDetails.tsx';
import './app.css';
import { Budget } from './Budget.tsx';
import { Categories } from './Categories.tsx';
import { Category } from './Category.tsx';
import { Categorize } from './Categorize.tsx';
import { Dashboard } from './Dashboard.tsx';
import {
  deviceCanVerify,
  turnOffLock,
  turnOnLock,
  unlockWithDevice,
  useLock,
} from './device/lock.ts';
import { GoalDetails, NewGoal } from './GoalDetails.tsx';
import { JumpTo } from './Jump.tsx';
import { NotUpdated } from './NotUpdated.tsx';
import { Payee } from './Payee.tsx';
import { UpdateNotice } from './pwa/UpdateNotice.tsx';
import type { Route } from './route.ts';
import { Rules } from './Rules.tsx';
import { ACTIVITY_HREF, BUDGET_HREF, DASHBOARD_HREF, useRoute } from './route.ts';
import { Sheet } from './sheet.tsx';
import { SignIn } from './SignIn.tsx';
import { auth } from './supabase/client.ts';
import { useSession } from './supabase/useSession.ts';

export function App() {
  const session = useSession();
  const lock = useLock();
  const route = useRoute();
  const screen =
    route.kind === 'account'
      ? route.accountId
      : route.kind === 'asset'
        ? route.assetId
        : route.kind === 'goal'
          ? route.goalId
          : route.kind === 'budget' || route.kind === 'categorize'
            ? `${route.kind}:${route.month ?? ''}`
            : route.kind === 'category'
              ? `category:${route.categoryId}:${route.month ?? ''}`
              : route.kind === 'payee'
                ? `payee:${route.payee}`
                : route.kind;

  // A new screen opens at its top. The browser restores the scroll on back, but going forward
  // into an account from far down the dashboard would otherwise land halfway down its page.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

  // Only when nothing is remembered and the server has not answered yet. A remembered session
  // renders at once (`remembered.ts`), so this is the first visit, never the morning after.
  if (session.status === 'loading') return <main className="page" aria-busy="true" />;
  if (session.status === 'signed-out') return <SignIn />;
  if (lock.locked && lock.owner === session.user.id) return <Locked />;

  return (
    <main className="page">
      <UpdateNotice />
      <header className="bar">
        <h1 className="brand">
          Din<span className="brand-o">o</span>ra
        </h1>
        <Tabs route={route} />
        <NotUpdated />
        <JumpTo />
        <Account email={session.user.email} userId={session.user.id} />
      </header>
      <Screen route={route} userId={session.user.id} />
    </main>
  );
}

function Screen({ route, userId }: { readonly route: Route; readonly userId: string }) {
  switch (route.kind) {
    case 'dashboard':
      return <Dashboard />;
    case 'account':
      return <AccountDetails accountId={route.accountId} userId={userId} />;
    case 'asset':
      return <AssetDetails assetId={route.assetId} userId={userId} />;
    case 'new-asset':
      return <NewAsset userId={userId} />;
    case 'goal':
      return <GoalDetails goalId={route.goalId} userId={userId} />;
    case 'new-goal':
      return <NewGoal userId={userId} />;
    case 'budget':
      return <Budget month={route.month} userId={userId} />;
    case 'category':
      return <Category categoryId={route.categoryId} month={route.month} userId={userId} />;
    case 'categories':
      return <Categories userId={userId} />;
    case 'rules':
      return <Rules categoryId={route.categoryId} userId={userId} />;
    case 'categorize':
      return <Categorize month={route.month} userId={userId} />;
    case 'activity':
      return <Activity query={route.query} userId={userId} />;
    case 'payee':
      return <Payee payee={route.payee} userId={userId} />;
  }
}

/**
 * The way around (UI-04). The design audit (26 Sep) found none: Budget was a link inside the
 * dashboard's Budget card, and every page's way back said *All accounts*, the budget's too.
 *
 * One list of links, placed by CSS alone: along the bottom on a phone, where a thumb is, and
 * across the header on anything wider, the Mac window included, so the Mac app decides nothing
 * here (invariant 13). Links, not buttons, since each tab is a place with an address. An
 * account, an asset or a goal is opened from the overview, so the overview's tab stays lit
 * there; a payee is opened from activity (ACCT-14), so activity's does.
 */
function Tabs({ route }: { readonly route: Route }) {
  const lit =
    route.kind === 'budget' ||
    route.kind === 'category' ||
    route.kind === 'categories' ||
    route.kind === 'rules' ||
    route.kind === 'categorize'
      ? 'budget'
      : route.kind === 'activity' || route.kind === 'payee'
        ? 'activity'
        : 'overview';
  const current = (tab: typeof lit) => (lit === tab ? 'page' : undefined);
  return (
    <nav className="tabs" aria-label="Sections">
      <a href={DASHBOARD_HREF} aria-current={current('overview')}>
        <OverviewIcon />
        Overview
      </a>
      <a href={BUDGET_HREF} aria-current={current('budget')}>
        <BudgetIcon />
        Budget
      </a>
      <a href={ACTIVITY_HREF} aria-current={current('activity')}>
        <ActivityIcon />
        Activity
      </a>
    </nav>
  );
}

function ActivityIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" />
    </svg>
  );
}

function OverviewIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 17l5-5 4 3 8-8" />
      <path d="M3 21h18" />
    </svg>
  );
}

function BudgetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5V12l6 6" />
    </svg>
  );
}

/**
 * Who is signed in, and the way out, behind one button: the email and Sign out took the top of
 * every screen for something done about once a device.
 */
function Account({ email, userId }: { readonly email: string; readonly userId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="quiet account" onClick={() => setOpen(true)}>
        Account
      </button>
      <Sheet title="Account" open={open} onClose={() => setOpen(false)}>
        <p>
          Signed in as <strong>{email}</strong>.
        </p>
        <div className="stack">
          <FaceId userId={userId} />
          <SignOut />
        </div>
      </Sheet>
    </>
  );
}

/**
 * Asked for after five minutes away (SEC-01). A button rather than asking the moment the screen
 * appears: iOS shows Face ID for a page only in answer to a tap. The way out is signing out,
 * which empties this device (invariant 11) — the email code then gets back in.
 */
function Locked() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async () => {
    setBusy(true);
    setError(null);
    const outcome = await unlockWithDevice();
    setBusy(false);
    if (!outcome.ok) setError(outcome.message);
  };

  return (
    <main className="page narrow lock">
      <h1>Dinora</h1>
      <p className="muted">Locked after five minutes away.</p>
      <div className="stack">
        <button type="button" disabled={busy} onClick={() => void unlock()}>
          Unlock with Face ID
        </button>
        {error !== null && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <SignOut />
      </div>
    </main>
  );
}

/**
 * Face ID for this account on this device: a passkey to sign in with instead of the emailed
 * code, and the lock after idle. Offered only where the device can do it, so not in the Mac
 * app's window. Turning it off stops the lock here; the passkey stays, for signing in.
 */
function FaceId({ userId }: { readonly userId: string }) {
  const lock = useLock();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void deviceCanVerify().then((can) => {
      if (active) setAvailable(can);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!available) return null;
  const on = lock.owner === userId;

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    const outcome = await turnOnLock(userId);
    setBusy(false);
    if (!outcome.ok) setError(outcome.message);
  };

  return (
    <div className="stack">
      <p className="muted small">
        {on
          ? 'Face ID signs you in here, and is asked for after five minutes away.'
          : 'Sign in with Face ID instead of an emailed code, and lock the app after five minutes away.'}
      </p>
      {on ? (
        <button type="button" className="secondary" onClick={turnOffLock}>
          Turn off Face ID lock
        </button>
      ) : (
        <button type="button" disabled={busy} onClick={() => void turnOn()}>
          Use Face ID
        </button>
      )}
      {error !== null && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function SignOut() {
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    // Everywhere first, so the refresh token dies on the server too. Offline that request
    // fails and auth-js keeps the session — so fall back to this device alone: somebody
    // signing out on a train still means it, and the local sign-out is what empties the
    // cached rows (`device/start.ts`, invariant 11).
    const { error } = await auth.signOut();
    if (error !== null) await auth.signOut({ scope: 'local' });
    setBusy(false);
  };

  return (
    <button type="button" className="secondary" disabled={busy} onClick={() => void signOut()}>
      Sign out
    </button>
  );
}
