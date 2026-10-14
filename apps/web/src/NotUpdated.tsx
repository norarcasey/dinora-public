import type { StaleBank } from '@dinora/core/balances';
import { lastReads, sourceName, staleBanks } from '@dinora/core/balances';
import { readSource } from '@dinora/core/reading';
import { useEffect, useState } from 'react';

import { useOnline } from './device/useOnline.ts';
import { ACCOUNTS, BANK_PULLS } from './queries/balances.ts';
import { useSynced } from './queries/synced.ts';
import { ReadAgain } from './ReadAgain.tsx';
import { accountHref } from './route.ts';
import { Sheet } from './sheet.tsx';
import { Age, useNow } from './time.tsx';

/**
 * Banks whose balances have missed a night with nothing said about them (BANK-18): one amber
 * mark in the header, counting them, and a drawer with the banks, their accounts and *Read
 * again* for each source, since a read is a source's and never one bank's.
 *
 * It was a block at the top of the home screen. Nora, 28 Sep, seeing four banks and nine
 * account links spread across the page above her balances: *"The UI is awful. Let's just have
 * a warning icon in the header, click it and that opens the drawer to update the accounts."*
 * So the page says only that something wants looking at, and the looking happens in the
 * drawer. When nothing is stale there is no mark at all: a header that always carries a
 * warning slot teaches the eye to skip it.
 *
 * A bank a warning names is not counted here; its fix is under the warning on the home screen.
 */
export function NotUpdated() {
  const accounts = useSynced(ACCOUNTS);
  const pulls = useSynced(BANK_PULLS);
  const online = useOnline();
  const now = useNow();
  const [open, setOpen] = useState(false);

  // Going anywhere closes it: an account's link in the drawer opens that account's page.
  useEffect(() => {
    const onMove = () => setOpen(false);
    window.addEventListener('hashchange', onMove);
    return () => window.removeEventListener('hashchange', onMove);
  }, []);

  if (accounts.status !== 'held') return null;
  const warnings =
    pulls.status === 'held'
      ? lastReads(pulls.rows).flatMap((r) => (r.read.kind === 'read' ? r.read.warnings : []))
      : [];
  const stale = staleBanks(accounts.rows, warnings, now);
  if (stale.length === 0) return null;

  const label = `${stale.length} ${stale.length === 1 ? 'bank' : 'banks'} not updated in over a day`;
  return (
    <>
      <button
        type="button"
        className="quiet not-updated"
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <WarningIcon />
        {stale.length}
      </button>
      <Sheet title="Not updated" open={open} onClose={() => setOpen(false)}>
        <StaleBanks stale={stale} online={online} now={now} />
      </Sheet>
    </>
  );
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 2 20h20z" />
      <path d="M12 10v4M12 17v.01" />
    </svg>
  );
}

/**
 * By source: each bank named and dated by when its aggregator last heard from it, its accounts
 * under it as links, then one *Read again* for the source.
 */
function StaleBanks({
  stale,
  online,
  now,
}: {
  readonly stale: readonly StaleBank[];
  readonly online: boolean;
  readonly now: number;
}) {
  const sources = [...new Set(stale.map((bank) => bank.source))].sort();
  return (
    <>
      {sources.map((source) => {
        const banks = stale.filter((bank) => bank.source === source);
        const readable = readSource(source);
        return (
          <section className="stale-source" key={source}>
            <p>
              {sourceName(source)} has not updated{' '}
              {banks.length === 1 ? 'a bank' : `${banks.length} banks`} in over a day.
            </p>
            <ul className="stale-banks">
              {banks.map((bank) => (
                <li key={bank.institution}>
                  <span className="age stale">
                    {bank.institution || 'A bank with no name'}, not updated since{' '}
                    <Age at={bank.since} now={now} />
                  </span>
                  <ul className="warned">
                    {bank.accounts.map((a) => (
                      <li key={a.id}>
                        <a href={accountHref(a.id)}>{a.name || 'Unnamed account'}</a>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {readable !== null && (
              <ReadAgain
                source={readable}
                still={banks.length === 1 ? 'it' : 'them'}
                online={online}
              />
            )}
          </section>
        );
      })}
    </>
  );
}
