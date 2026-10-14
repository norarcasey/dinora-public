import { useEffect, useRef, useState } from 'react';

import { Field } from './controls.tsx';
import { deviceCanVerify, enrollLock } from './device/lock.ts';
import { auth } from './supabase/client.ts';

type Stage = { readonly step: 'email' } | { readonly step: 'code'; readonly email: string };

/**
 * Sign-in by a code typed into the app, never by following the emailed link. An installed
 * PWA and the Mac window each keep their own storage, and a link opens in the browser — so it
 * signs in the browser and leaves the app signed out (Nora Bene found this first, 2026).
 *
 * No password path and no invitation code, unlike Nora Bene: Dinora has one user, made by hand
 * in the dashboard, and no end-to-end suite that cannot read a mailbox.
 *
 * Face ID first where the device has it (SEC-01): a passkey, turned on from Account, signs in
 * without leaving the app at all. The code stays for a new device and for the Mac app, whose
 * web view cannot use one.
 */
export function SignIn() {
  const [stage, setStage] = useState<Stage>({ step: 'email' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [canVerify, setCanVerify] = useState(false);
  // Not the email field's error: that field had nothing to do with it (UI-02).
  const [faceIdError, setFaceIdError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void deviceCanVerify().then((can) => {
      if (active) setCanVerify(can);
    });
    return () => {
      active = false;
    };
  }, []);

  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (stage.step === 'code') codeRef.current?.focus();
  }, [stage.step]);

  const signInWithFaceId = async () => {
    setBusy(true);
    setError(null);
    setFaceIdError(null);
    const { data, error: passkeyError } = await auth.signInWithPasskey();
    setBusy(false);
    if (passkeyError !== null || data.user === null) {
      setFaceIdError('Face ID did not sign you in. Try again, or use an emailed code.');
      return;
    }
    // Face ID just worked here, so the lock after idle can use it too.
    enrollLock(data.user.id);
    void navigator.storage?.persist?.().catch(() => undefined);
  };

  const requestCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    // `shouldCreateUser: false` is the message, not the lock: the lock is signup switched off
    // on the project, which `pnpm auth:closed` checks before every deploy. This only makes a
    // stranger's request fail with words instead of an account.
    const { error: otpError } = await auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false },
    });
    setBusy(false);
    if (otpError !== null) {
      setError(requestMessage(otpError.message));
      return;
    }
    setStage({ step: 'code', email: email.trim() });
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (stage.step !== 'code') return;
    setBusy(true);
    setError(null);
    const { error: verifyError } = await auth.verifyOtp({
      email: stage.email,
      token: code.trim(),
      type: 'email',
    });
    setBusy(false);
    if (verifyError !== null) {
      setError('That code did not work. Check it, or send a new one.');
      setCode('');
      codeRef.current?.focus();
      return;
    }
    // The session and the cached rows live in this origin's storage; ask the browser not to
    // evict it under pressure, which would sign out and empty the offline copy.
    void navigator.storage?.persist?.().catch(() => undefined);
  };

  return (
    <main className="page narrow">
      <h1>
        Din<span className="brand-o">o</span>ra
      </h1>
      <p className="muted">Every account in one place, read-only.</p>

      {/* One field a step, so whatever went wrong is that field's (UI-02). */}
      {stage.step === 'email' ? (
        <form className="stack" onSubmit={(event) => void requestCode(event)}>
          <Field label="Email" error={error}>
            {(control) => (
              <input
                {...control}
                type="email"
                required
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          <button type="submit" disabled={busy} className={canVerify ? 'secondary' : undefined}>
            {busy ? 'Sending…' : 'Email me a code'}
          </button>
          {canVerify && (
            <button type="button" disabled={busy} onClick={() => void signInWithFaceId()}>
              Sign in with Face ID
            </button>
          )}
          {faceIdError !== null && (
            <p className="error small" role="alert">
              {faceIdError}
            </p>
          )}
        </form>
      ) : (
        <form className="stack" onSubmit={(event) => void submitCode(event)}>
          <p className="muted">
            A code is on its way to <strong>{stage.email}</strong>. Type it here rather than
            following the link in the email, which signs in the browser instead of this app.
          </p>
          <Field label="Sign-in code" error={error}>
            {(control) => (
              <input
                {...control}
                ref={codeRef}
                className="code"
                required
                // Lets iOS offer the digits straight from the notification.
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]*"
                // The length is a project setting — a local stack issues six digits, a hosted
                // project may issue eight — so neither the field nor the copy promises a number.
                maxLength={10}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              />
            )}
          </Field>
          <button type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
          <button
            type="button"
            className="quiet"
            onClick={() => {
              setStage({ step: 'email' });
              setCode('');
              setError(null);
            }}
          >
            Use a different email
          </button>
        </form>
      )}
    </main>
  );
}

/**
 * GoTrue answers an address with no account "Signups not allowed for otp", which reads as a
 * fault. With signup closed it only ever means this address is not the one account.
 */
export function requestMessage(message: string): string {
  if (/signups? not allowed/i.test(message)) {
    return 'There is no Dinora account for that address.';
  }
  if (/rate limit|too many/i.test(message)) {
    return 'Too many codes asked for just now. Wait a minute and try again.';
  }
  return message;
}
