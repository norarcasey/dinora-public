/**
 * Whether the app is running installed, and what that means for Web Push.
 *
 * iOS (16.4 and later) gives Web Push to a home-screen app and to nothing else: in a Safari
 * tab `PushManager` does not exist. So "can we ask for notifications" has three answers, not
 * two, and the middle one is an instruction rather than a refusal — add it to the Home
 * Screen first. Offering a prompt that cannot work, or hiding the feature from somebody one
 * tap away from it, are the two ways to get this wrong.
 *
 * Detected by capability, never by user agent. `navigator.standalone` exists only in iOS and
 * iPadOS WebKit, which is the one place the install-first answer applies.
 */

export type DisplayEnv = {
  /** `navigator.standalone`: a boolean on iOS WebKit, absent everywhere else. */
  readonly iosStandalone: boolean | null;
  /** `(display-mode: standalone)` — how every other browser says it is installed. */
  readonly standaloneDisplay: boolean;
  readonly hasPushManager: boolean;
  readonly hasNotification: boolean;
};

export function isInstalled(env: DisplayEnv): boolean {
  return env.iosStandalone === true || env.standaloneDisplay;
}

export type PushOffer =
  | { readonly kind: 'available' }
  /** iOS in a Safari tab: say how to install, then ask. */
  | { readonly kind: 'install-first' }
  | { readonly kind: 'unsupported' };

export function pushOffer(env: DisplayEnv): PushOffer {
  if (env.hasPushManager && env.hasNotification) return { kind: 'available' };
  if (env.iosStandalone === false) return { kind: 'install-first' };
  return { kind: 'unsupported' };
}

/** The one impure part: reads the environment. Everything above is decided from it. */
export function readDisplayEnv(win: Window = window): DisplayEnv {
  const standalone: unknown = Reflect.get(win.navigator, 'standalone');
  return {
    iosStandalone: typeof standalone === 'boolean' ? standalone : null,
    standaloneDisplay: win.matchMedia('(display-mode: standalone)').matches,
    hasPushManager: 'PushManager' in win,
    hasNotification: 'Notification' in win,
  };
}
