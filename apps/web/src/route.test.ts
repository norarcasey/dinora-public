import { describe, expect, it } from 'vitest';

import {
  accountHref,
  activityHref,
  assetHref,
  budgetHref,
  CATEGORIES_HREF,
  categorizeHref,
  categoryHref,
  goalHref,
  NEW_ASSET_HREF,
  NEW_GOAL_HREF,
  parseRoute,
  payeeHref,
  rulesHref,
} from './route.ts';

describe('parseRoute', () => {
  it('reads an account and returns its href unchanged', () => {
    expect(parseRoute(accountHref('a b/c'))).toEqual({ kind: 'account', accountId: 'a b/c' });
    expect(parseRoute('#/account/1234')).toEqual({ kind: 'account', accountId: '1234' });
  });

  it('reads an asset, and the page for a new one', () => {
    expect(parseRoute(assetHref('a b'))).toEqual({ kind: 'asset', assetId: 'a b' });
    expect(parseRoute(NEW_ASSET_HREF)).toEqual({ kind: 'new-asset' });
    expect(parseRoute('#/asset/%E0%A4%A')).toEqual({ kind: 'dashboard' });
  });

  it('reads a goal, and the page for a new one', () => {
    expect(parseRoute(goalHref('g 1'))).toEqual({ kind: 'goal', goalId: 'g 1' });
    expect(parseRoute(NEW_GOAL_HREF)).toEqual({ kind: 'new-goal' });
    expect(parseRoute('#/goal/%E0%A4%A')).toEqual({ kind: 'dashboard' });
  });

  it('reads a month’s budget, and this month’s', () => {
    expect(parseRoute(budgetHref())).toEqual({ kind: 'budget', month: null });
    expect(parseRoute(budgetHref('2026-08'))).toEqual({ kind: 'budget', month: '2026-08' });
    expect(parseRoute('#/budget/2026-13')).toEqual({ kind: 'dashboard' });
    expect(parseRoute('#/budget/2026-8')).toEqual({ kind: 'dashboard' });
  });

  it('reads a category’s month, the categories, the rules and the queue (UI-11)', () => {
    expect(parseRoute(categoryHref('a b'))).toEqual({
      kind: 'category',
      categoryId: 'a b',
      month: null,
    });
    expect(parseRoute(categoryHref('eat', '2026-08'))).toEqual({
      kind: 'category',
      categoryId: 'eat',
      month: '2026-08',
    });
    expect(parseRoute('#/category/eat/2026-13')).toEqual({ kind: 'dashboard' });
    expect(parseRoute('#/category/%E0')).toEqual({ kind: 'dashboard' });
    expect(parseRoute(CATEGORIES_HREF)).toEqual({ kind: 'categories' });
    expect(parseRoute(rulesHref())).toEqual({ kind: 'rules', categoryId: null });
    expect(parseRoute(rulesHref('a&b'))).toEqual({ kind: 'rules', categoryId: 'a&b' });
    expect(parseRoute('#/rules?category=%E0')).toEqual({ kind: 'dashboard' });
    expect(parseRoute(categorizeHref())).toEqual({ kind: 'categorize', month: null });
    expect(parseRoute(categorizeHref('2026-08'))).toEqual({
      kind: 'categorize',
      month: '2026-08',
    });
  });

  it('reads activity with what was typed, and a payee', () => {
    expect(parseRoute(activityHref(''))).toEqual({ kind: 'activity', query: '' });
    expect(parseRoute(activityHref('café & 12.50 #2'))).toEqual({
      kind: 'activity',
      query: 'café & 12.50 #2',
    });
    expect(parseRoute(payeeHref('whole foods/365'))).toEqual({
      kind: 'payee',
      payee: 'whole foods/365',
    });
    expect(parseRoute('#/activity?q=%E0%A4%A')).toEqual({ kind: 'dashboard' });
    expect(parseRoute('#/activityx')).toEqual({ kind: 'dashboard' });
  });

  it('is the dashboard for anything else, a broken escape included', () => {
    expect(parseRoute('')).toEqual({ kind: 'dashboard' });
    expect(parseRoute('#/')).toEqual({ kind: 'dashboard' });
    expect(parseRoute('#/account/')).toEqual({ kind: 'dashboard' });
    expect(parseRoute('#/account/%E0%A4%A')).toEqual({ kind: 'dashboard' });
  });
});
