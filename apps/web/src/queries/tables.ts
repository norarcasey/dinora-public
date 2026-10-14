import type { CacheableTable } from '../device/cache.ts';
import { ASSET_VALUES, ASSETS, CRYPTO_PRICES, METAL_PRICES } from './assets.ts';
import { ACCOUNTS, BANK_PULLS, FX_RATES } from './balances.ts';
import {
  CATEGORIES,
  CATEGORY_BUDGETS,
  CATEGORY_RULES,
  TRANSACTION_CATEGORIES,
  TRANSACTIONS,
} from './budgets.ts';
import { GOAL_ACCOUNTS, GOAL_PLANS, GOALS } from './goals.ts';
import { ACCOUNT_GROUPS } from './groups.ts';
import { BALANCE_SNAPSHOTS } from './history.ts';
import { ACCOUNT_TERMS } from './terms.ts';

/**
 * Every table kept on the device. A table defined with `defineSynced` and not listed here is
 * still read and shown, but not remembered: a cold open without signal shows nothing for it.
 */
export const SYNCED_TABLES: readonly CacheableTable[] = [
  ACCOUNTS,
  BANK_PULLS,
  FX_RATES,
  BALANCE_SNAPSHOTS,
  ACCOUNT_GROUPS,
  ACCOUNT_TERMS,
  ASSETS,
  ASSET_VALUES,
  METAL_PRICES,
  CRYPTO_PRICES,
  GOALS,
  GOAL_ACCOUNTS,
  GOAL_PLANS,
  TRANSACTIONS,
  CATEGORIES,
  CATEGORY_BUDGETS,
  TRANSACTION_CATEGORIES,
  CATEGORY_RULES,
];
