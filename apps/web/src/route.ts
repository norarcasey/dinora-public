import { useSyncExternalStore } from 'react';

/**
 * Where in the app the page is: the dashboard, one account's details (ACCT-10), one thing she
 * owns (ACCT-06), one goal (GOAL-01), a month's budget (BUD-01), or activity and one payee
 * (ACCT-14).
 *
 * In the hash, not the path. The service worker precaches one shell and serves it for every
 * navigation, and `/api/…` is kept away from it; a hash never reaches the server or the worker,
 * so a new screen needs no rule in either, the phone's and the Mac window's back gestures work,
 * and a reload stays on the account.
 */
export type Route =
  | { readonly kind: 'dashboard' }
  | { readonly kind: 'account'; readonly accountId: string }
  /** Something she owns (ACCT-06). */
  | { readonly kind: 'asset'; readonly assetId: string }
  | { readonly kind: 'new-asset' }
  | { readonly kind: 'goal'; readonly goalId: string }
  | { readonly kind: 'new-goal' }
  /** A month's budget; null for this month, whichever month that is when it is read. */
  | { readonly kind: 'budget'; readonly month: string | null }
  /** One category's month (UI-11); null for this month. */
  | { readonly kind: 'category'; readonly categoryId: string; readonly month: string | null }
  /** Every category, and the way to the rules. */
  | { readonly kind: 'categories' }
  /** The rules in force, found by payee; with a category, only its rules. */
  | { readonly kind: 'rules'; readonly categoryId: string | null }
  /** A month's transactions with no category, one at a time. */
  | { readonly kind: 'categorize'; readonly month: string | null }
  /** Every transaction, searched; `query` is what was typed, empty for none. */
  | { readonly kind: 'activity'; readonly query: string }
  /** One payee, by its key as a rule matches it (`payeeOf`). */
  | { readonly kind: 'payee'; readonly payee: string };

export function parseRoute(hash: string): Route {
  if (hash === NEW_ASSET_HREF) return { kind: 'new-asset' };
  if (hash === NEW_GOAL_HREF) return { kind: 'new-goal' };
  if (hash === BUDGET_HREF) return { kind: 'budget', month: null };
  const budget = new RegExp(`^#/budget/(${MONTH})$`).exec(hash)?.[1];
  if (budget !== undefined) return { kind: 'budget', month: budget };
  if (hash === CATEGORIES_HREF) return { kind: 'categories' };
  if (hash === RULES_HREF) return { kind: 'rules', categoryId: null };
  if (hash === CATEGORIZE_HREF) return { kind: 'categorize', month: null };
  const categorize = new RegExp(`^${CATEGORIZE_HREF}/(${MONTH})$`).exec(hash)?.[1];
  if (categorize !== undefined) return { kind: 'categorize', month: categorize };
  const inCategory = new RegExp(`^#/category/([^/?#]+)(?:/(${MONTH}))?$`).exec(hash);
  const ruled = /^#\/rules\?category=([^#&]+)$/.exec(hash)?.[1];
  if (inCategory !== null || ruled !== undefined) {
    try {
      if (ruled !== undefined) return { kind: 'rules', categoryId: decodeURIComponent(ruled) };
      const [, id = '', month] = inCategory ?? [];
      return { kind: 'category', categoryId: decodeURIComponent(id), month: month ?? null };
    } catch {
      return { kind: 'dashboard' };
    }
  }
  if (hash === ACTIVITY_HREF) return { kind: 'activity', query: '' };
  const searched = /^#\/activity\?q=([^#]+)$/.exec(hash);
  const match = /^#\/(account|asset|goal|payee)\/([^/?#]+)$/.exec(hash);
  const [, screen, id] = searched === null ? (match ?? []) : ['', 'activity', searched[1]];
  if (id === undefined) return { kind: 'dashboard' };
  // A hand-typed `%` that is not an escape throws; it names nothing, so the dashboard.
  try {
    const decoded = decodeURIComponent(id);
    if (screen === 'activity') return { kind: 'activity', query: decoded };
    if (screen === 'payee') return { kind: 'payee', payee: decoded };
    if (screen === 'asset') return { kind: 'asset', assetId: decoded };
    if (screen === 'goal') return { kind: 'goal', goalId: decoded };
    return { kind: 'account', accountId: decoded };
  } catch {
    return { kind: 'dashboard' };
  }
}

export function accountHref(accountId: string): string {
  return `#/account/${encodeURIComponent(accountId)}`;
}

export function assetHref(assetId: string): string {
  return `#/asset/${encodeURIComponent(assetId)}`;
}

export function goalHref(goalId: string): string {
  return `#/goal/${encodeURIComponent(goalId)}`;
}

/** A month's budget; with no month, this one. */
export function budgetHref(month?: string): string {
  return month === undefined ? BUDGET_HREF : `${BUDGET_HREF}/${month}`;
}

export const BUDGET_HREF = '#/budget';

const MONTH = String.raw`\d{4}-(?:0[1-9]|1[0-2])`;

/** A category's month; with no month, this one. */
export function categoryHref(categoryId: string, month?: string): string {
  const at = `#/category/${encodeURIComponent(categoryId)}`;
  return month === undefined ? at : `${at}/${month}`;
}

export const CATEGORIES_HREF = '#/categories';

export const RULES_HREF = '#/rules';

/** The rules; with a category, only those filing into it. */
export function rulesHref(categoryId?: string): string {
  return categoryId === undefined
    ? RULES_HREF
    : `${RULES_HREF}?category=${encodeURIComponent(categoryId)}`;
}

export const CATEGORIZE_HREF = '#/categorize';

/** A month's transactions with no category, one at a time; with no month, this one's. */
export function categorizeHref(month?: string): string {
  return month === undefined ? CATEGORIZE_HREF : `${CATEGORIZE_HREF}/${month}`;
}

export const ACTIVITY_HREF = '#/activity';

/**
 * Activity with what was typed. The search is kept in the hash so the back gesture from a payee
 * returns to the results it was opened from, not an empty box.
 */
export function activityHref(query: string): string {
  return query === '' ? ACTIVITY_HREF : `${ACTIVITY_HREF}?q=${encodeURIComponent(query)}`;
}

export function payeeHref(payee: string): string {
  return `#/payee/${encodeURIComponent(payee)}`;
}

/** Not an id a row could have: ids are uuids. */
export const NEW_ASSET_HREF = '#/new-asset';

export const NEW_GOAL_HREF = '#/new-goal';

export const DASHBOARD_HREF = '#/';

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => '');
  return parseRoute(hash);
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

function snapshot(): string {
  return window.location.hash;
}
