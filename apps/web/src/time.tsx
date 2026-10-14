import { describeAge } from '@dinora/core/balances';
import { useEffect, useState } from 'react';

/** The browser's own: amounts and ages read the way the rest of the device does. */
export const LOCALE = undefined;

export function Age({ at, now }: { readonly at: string; readonly now: number }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString(LOCALE)}>
      {describeAge(at, now, LOCALE)}
    </time>
  );
}

/**
 * The time, once a minute and whenever the app comes back into view: a phone suspends
 * timers in the background, and "3 hours ago" read the next morning must not still say 3.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return now;
}

/**
 * Her day on this device, `YYYY-MM-DD`. A card's terms change on a calendar day where she is,
 * not in UTC: read at 8pm in Springfield, UTC is already tomorrow.
 */
export function localDay(now: number): string {
  const at = new Date(now);
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}
