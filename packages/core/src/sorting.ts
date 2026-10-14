import type { CategoryRow, ChoiceRow, Entry, Month, RuleRow } from './budgets.ts';
import { compareCategories, monthOf, rulesIn } from './budgets.ts';

/*
 * Sorting a month's transactions on a phone (UI-08). The design audit of 26 Sep measured the
 * budget page at 390px over about 180 fixture transactions: about 11,000px, 13 screens, nearly
 * all of it one full-width select per transaction. What replaced it: a chip per transaction
 * opening a searchable picker, recent choices first; a header per day in place of a date on
 * every row; and an Unsorted queue that shows one at a time.
 */

/**
 * The categories of her newest choices, newest first, each once: what the picker offers above
 * the full list. Only choices still in force count — one she took back was not a choice — and
 * only categories still listed.
 */
export function recentCategories(
  choices: readonly ChoiceRow[],
  categories: readonly CategoryRow[],
  limit: number,
): CategoryRow[] {
  const live = new Map(
    categories.filter((c) => c.deleted_at === null).map((c) => [c.id, c] as const),
  );
  const newest = choices
    .filter((c) => c.deleted_at === null)
    .sort(
      (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id.localeCompare(a.id),
    );
  const recent: CategoryRow[] = [];
  const seen = new Set<string>();
  for (const choice of newest) {
    if (recent.length >= limit) break;
    const category = live.get(choice.category_id);
    if (category === undefined || seen.has(category.id)) continue;
    seen.add(category.id);
    recent.push(category);
  }
  return recent;
}

/** Lower case and without accents, so "cafe" finds *Café* and "ejemplo" finds *EJEMPLO*. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

/**
 * The listed categories whose names hold `query`, names that start with it first, then by name.
 * An empty query is every one, by name.
 */
export function findCategories(query: string, categories: readonly CategoryRow[]): CategoryRow[] {
  const wanted = fold(query);
  const byName = (a: CategoryRow, b: CategoryRow) =>
    a.name.localeCompare(b.name) || compareCategories(a, b);
  const live = categories.filter((c) => c.deleted_at === null);
  if (wanted === '') return live.sort(byName);
  const starts: CategoryRow[] = [];
  const holds: CategoryRow[] = [];
  for (const category of live) {
    const name = fold(category.name);
    if (name.startsWith(wanted)) starts.push(category);
    else if (name.includes(wanted)) holds.push(category);
  }
  return [...starts.sort(byName), ...holds.sort(byName)];
}

export type Day = { readonly day: string; readonly entries: readonly Entry[] };

/** Entries in their order, under one heading per day. `entriesIn` gives them newest first. */
export function byDay(entries: readonly Entry[]): Day[] {
  const days: { day: string; entries: Entry[] }[] = [];
  for (const entry of entries) {
    const last = days.at(-1);
    if (last !== undefined && last.day === entry.day) last.entries.push(entry);
    else days.push({ day: entry.day, entries: [entry] });
  }
  return days;
}

/** "Thu, Sep 24", for a day's heading: the month's page already says the year. */
export function describeWeekday(isoDate: string, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(Date.parse(`${isoDate}T00:00:00Z`));
}

/**
 * Whether choosing `chosen` for a payee should ask to make it a rule from `month` on: not for
 * taking a choice away, not for a transaction with no payee to match, and not when the rule in
 * force already files it there.
 */
export function offersRule(
  chosen: CategoryRow | null,
  payee: string,
  rules: readonly RuleRow[],
  month: Month,
): chosen is CategoryRow {
  if (chosen === null || payee === '') return false;
  const governing = rulesIn(month, rules).find((r) => r.payee === payee);
  return governing?.category_id !== chosen.id;
}

/**
 * Where the Unsorted queue goes after `at`: the next transaction still unsorted, or null once
 * none is left. The queue is the month's unsorted transactions as they were when it opened, so
 * one sorted stays in place to go back to, and one a new rule sorted is passed over.
 */
export function nextToSort(
  queue: readonly string[],
  at: number,
  unsorted: (id: string) => boolean,
): number | null {
  for (let i = at + 1; i < queue.length; i += 1) {
    const id = queue[i];
    if (id !== undefined && unsorted(id)) return i;
  }
  for (let i = 0; i < at && i < queue.length; i += 1) {
    const id = queue[i];
    if (id !== undefined && unsorted(id)) return i;
  }
  return null;
}

/* ─── rules, when there are hundreds ────────────────────────────────────────────────────── */

/*
 * Nora, 26 Sep: she travels, so most payees she meets are new, and she will make a rule for most
 * of them: "this list needs to handle a large number of Rules gracefully, given that I will
 * almost never look at them except to fix the occasional one." So rules are a count on the pages
 * that use them and a list found by typing, never every rule down a page. A rule holds a payee, a
 * category and the month it starts, so there is no place or last use to group or sort them by.
 */

/** The rules in force in `month`, the newest made first: the one to fix is usually recent. */
export function rulesNewestFirst(month: Month, rules: readonly RuleRow[]): RuleRow[] {
  return rulesIn(month, rules).sort(
    (a, b) =>
      Date.parse(b.created_at) - Date.parse(a.created_at) ||
      b.starts_on.localeCompare(a.starts_on) ||
      a.payee.localeCompare(b.payee),
  );
}

/** Those whose payee holds `query`, accents and case aside; with a category, only its rules. */
export function findRules(
  query: string,
  categoryId: string | null,
  rules: readonly RuleRow[],
): RuleRow[] {
  const wanted = fold(query);
  return rules.filter(
    (rule) =>
      (categoryId === null || rule.category_id === categoryId) &&
      (wanted === '' || fold(rule.payee).includes(wanted)),
  );
}

/** How many were made in `month`: a rule starts on the first of the month it was made in. */
export function rulesMadeIn(month: Month, rules: readonly RuleRow[]): number {
  return rules.filter((rule) => monthOf(rule.starts_on) === month).length;
}
