import type { NetCurrency } from '@dinora/core/rates';
import { NET_CURRENCIES } from '@dinora/core/rates';
import { useState } from 'react';

/**
 * What the dashboard totals in (DIN-10), as last chosen on this device (Nora, 8 Oct 2026):
 * reopening the app in euros keeps it in euros. A preference, not a row, so it is not the
 * row cache's and needs no owner (invariant 11). Dollars where storage is refused or holds
 * something else.
 */

const KEY = 'dinora.net-currency';

function read(): NetCurrency {
  try {
    const stored = localStorage.getItem(KEY);
    return NET_CURRENCIES.find((option) => option === stored) ?? 'USD';
  } catch {
    return 'USD';
  }
}

export function useNetCurrency(): readonly [NetCurrency, (currency: NetCurrency) => void] {
  const [currency, setCurrency] = useState<NetCurrency>(read);
  const choose = (next: NetCurrency) => {
    setCurrency(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Storage refused: the choice holds for as long as the page is open.
    }
  };
  return [currency, choose];
}
