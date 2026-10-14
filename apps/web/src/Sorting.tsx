import type { AccountRow } from '@dinora/core/balances';
import { formatMinor } from '@dinora/core/balances';
import type {
  CategoryKind,
  CategoryRow,
  Entry,
  Filed,
  Month,
  TransactionRow,
} from '@dinora/core/budgets';
import {
  CATEGORY_KINDS,
  dayOf,
  describeMonth,
  makeFiler,
  payeeName,
  payeeOf,
} from '@dinora/core/budgets';
import {
  describeWeekday,
  findCategories,
  nextToSort,
  offersRule,
  recentCategories,
} from '@dinora/core/sorting';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';

import type { BudgetMonth } from './Budget.tsx';
import {
  CATEGORY_RULES,
  TRANSACTION_CATEGORIES,
  addRule,
  chooseCategory,
} from './queries/budgets.ts';
import { notDone } from './queries/writes.ts';
import { payeeHref } from './route.ts';
import { Sheet } from './sheet.tsx';
import { LOCALE } from './time.tsx';

/*
 * Sorting a month's transactions (UI-08). Each transaction wore a full-width select whose empty
 * option carried where it landed without her in brackets, *Groceries (Monarch’s)*: at 390px the
 * September page measured about 11,000px, 13 screens, nearly all of it selects (design audit,
 * 26 Sep). A chip says the same in a word and a mark, and opens the choice only when tapped.
 */

/** How a transaction came to be where it is, in words: a screen reader's half of the mark. */
const ORIGIN: Readonly<Record<Exclude<Filed['kind'], 'none'>, string>> = {
  chosen: 'yours',
  rule: 'by rule',
  paired: 'paired as a transfer',
  guess: 'Monarch’s guess',
};

const GROUP_NAMES: Readonly<Record<CategoryKind, string>> = {
  spend: 'Spending',
  income: 'Income',
  transfer: 'Transfers',
};

/** What filing a transaction needs to know: her categories, choices and rules, and the pairs. */
export type FilingData = Pick<BudgetMonth, 'categories' | 'choices' | 'rules' | 'pairs'>;

/** A transaction and where it is filed, from a month's entries or from Activity's search. */
export type Filable = Pick<Entry, 'transaction' | 'day' | 'filed' | 'currency'>;

/** How many of her recent choices the picker offers before the full list. */
export const RECENT = 6;

function describeFiled(filed: Filed): string {
  return filed.kind === 'none' ? 'uncategorized' : `${filed.category.name}, ${ORIGIN[filed.kind]}`;
}

/** The mark for where a filing came from; its meaning is said beside it in words. */
function OriginMark({ kind }: { readonly kind: Exclude<Filed['kind'], 'none'> }) {
  return <span className={`origin origin-${kind}`} aria-hidden="true" />;
}

/** The marks and what each means, once above the list rather than on every row. */
export function OriginKey() {
  return (
    <p className="origin-key muted small">
      <span>
        <OriginMark kind="chosen" /> {ORIGIN.chosen}
      </span>
      <span>
        <OriginMark kind="rule" /> {ORIGIN.rule}
      </span>
      <span>
        <OriginMark kind="paired" /> {ORIGIN.paired}
      </span>
      <span>
        <OriginMark kind="guess" /> {ORIGIN.guess}
      </span>
    </p>
  );
}

/** Where a transaction is filed, as a chip that opens the choice. */
export function CategoryChip({
  filed,
  payee,
  disabled,
  onOpen,
}: {
  readonly filed: Filed;
  readonly payee: string;
  readonly disabled: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={filed.kind === 'none' ? 'chip unsorted' : 'chip'}
      aria-label={`Category for ${payee}: ${describeFiled(filed)}`}
      disabled={disabled}
      onClick={onOpen}
    >
      {filed.kind !== 'none' && <OriginMark kind={filed.kind} />}
      <span className="chip-name">
        {filed.kind === 'none' ? 'Uncategorized' : filed.category.name}
      </span>
    </button>
  );
}

/* ─── choosing ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every listed category, found by typing, her recent choices first. What is picked is saved at
 * once, as the select was; the sheet closes on it. A transaction's and a rule's alike (UI-11).
 */
export function CategoryPicker({
  currentId,
  categories,
  recent,
  onPick,
  children,
}: {
  /** Where it is filed now, marked in the list; null for nowhere. */
  readonly currentId: string | null;
  readonly categories: readonly CategoryRow[];
  readonly recent: readonly CategoryRow[];
  readonly onPick: (categoryId: string) => void;
  /** Below the list: taking a transaction's choice back. */
  readonly children?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const found = findCategories(query, categories);
  const option = (category: CategoryRow) => (
    <li key={category.id}>
      <button
        type="button"
        aria-current={category.id === currentId ? 'true' : undefined}
        onClick={() => onPick(category.id)}
      >
        {category.name}
      </button>
    </li>
  );

  return (
    <div className="picker">
      <input
        type="search"
        aria-label="Find a category"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        placeholder={`Find one of ${categories.length} categories`}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {query.trim() !== '' ? (
        found.length === 0 ? (
          <p className="muted small">No category has “{query.trim()}” in its name.</p>
        ) : (
          <ul className="pick-list">{found.map(option)}</ul>
        )
      ) : (
        <>
          {recent.length > 0 && <PickGroup title="Recent">{recent.map(option)}</PickGroup>}
          {CATEGORY_KINDS.map((kind) => {
            const list = found.filter((c) => c.kind === kind);
            return (
              list.length > 0 && (
                <PickGroup key={kind} title={GROUP_NAMES[kind]}>
                  {list.map(option)}
                </PickGroup>
              )
            );
          })}
        </>
      )}
      {children}
    </div>
  );
}

function PickGroup({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="pick-group" aria-label={title}>
      <h3>{title}</h3>
      <ul className="pick-list">{children}</ul>
    </section>
  );
}

/**
 * What a pair is paired with, so a stranger matched by amount alone can be seen for one. Its
 * payee and day, not its account: the budget holds only the accounts it counts, and a card
 * payment's other side is often a loan's or a brokerage's.
 */
function PairedNote({ filed }: { readonly filed: Extract<Filed, { kind: 'paired' }> }) {
  const other = filed.partner;
  const on = other.transacted_at ?? other.posted_at;
  return (
    <p className="hint">
      Filed with its other side, {payeeName(other)}
      {on === null ? '' : ` on ${describeWeekday(dayOf(other, ''), LOCALE)}`}. A category that is
      not a transfer says it is not one, and neither side is paired.
    </p>
  );
}

/** Handing a transaction back from her choice to whatever files it without her. */
export function TakeBack({
  entry,
  data,
  onPick,
}: {
  readonly entry: Pick<Entry, 'transaction' | 'day'>;
  readonly data: FilingData;
  readonly onPick: (categoryId: string | null) => void;
}) {
  // Only while the picker is open, not once per row per render as the select's label was.
  // The day only decides which rule applies, and the entry's is known. The other side's choice
  // stays: it decides where a pair goes (BUD-05).
  const others = data.choices.filter((c) => c.transaction_id !== entry.transaction.id);
  const without = makeFiler(
    data.categories,
    others,
    data.rules,
    entry.day,
    data.pairs,
  )(entry.transaction);
  return (
    <div className="take-back">
      <button type="button" className="secondary" onClick={() => onPick(null)}>
        Take my choice back
      </button>
      <p className="hint">
        {without.kind === 'none'
          ? 'It goes back to uncategorized.'
          : `It goes back to ${without.category.name}, ${ORIGIN[without.kind]}.`}
      </p>
    </div>
  );
}

/* ─── saving a choice, and the rule question ────────────────────────────────────────────── */

type Filing = {
  readonly busy: boolean;
  readonly problem: string | null;
  /** The category the rule question is asked about, while it is. */
  readonly offer: CategoryRow | null;
  readonly ruled: boolean;
  /** Saves; says whether the rule question is now asked, or `failed`. */
  readonly choose: (categoryId: string | null) => Promise<'filed' | 'asked' | 'failed'>;
  readonly makeRule: () => Promise<boolean>;
  readonly decline: () => void;
};

/** One transaction's choice and the rule question after it, for a row and the queue alike. */
export function useFiling(
  entry: Pick<Entry, 'transaction'>,
  data: FilingData,
  current: Month,
  userId: string,
): Filing {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [offer, setOffer] = useState<CategoryRow | null>(null);
  const [ruled, setRuled] = useState(false);
  const key = payeeOf(entry.transaction);

  const choose = async (categoryId: string | null) => {
    setBusy(true);
    setProblem(null);
    setRuled(false);
    setOffer(null);
    try {
      await chooseCategory(userId, entry.transaction.id, categoryId, data.choices);
      await client.invalidateQueries({ queryKey: TRANSACTION_CATEGORIES.queryKey });
      const chosen = data.categories.find((c) => c.id === categoryId) ?? null;
      if (offersRule(chosen, key, data.rules, current)) {
        setOffer(chosen);
        return 'asked';
      }
      return 'filed';
    } catch (error) {
      setProblem(notDone(error, 'saved'));
      return 'failed';
    } finally {
      setBusy(false);
    }
  };

  const makeRule = async () => {
    if (offer === null) return false;
    setBusy(true);
    setProblem(null);
    try {
      await addRule(userId, key, offer.id, current);
      await client.invalidateQueries({ queryKey: CATEGORY_RULES.queryKey });
      setOffer(null);
      setRuled(true);
      return true;
    } catch (error) {
      setProblem(notDone(error, 'saved'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, problem, offer, ruled, choose, makeRule, decline: () => setOffer(null) };
}

/**
 * The rule question, its buttons on a row of their own: inline after the question they wrapped
 * into columns one word wide at 390px (design audit, 26 Sep).
 */
export function RuleOffer({
  payee,
  category,
  current,
  disabled,
  onRule,
  onDecline,
}: {
  readonly payee: string;
  readonly category: CategoryRow;
  readonly current: Month;
  readonly disabled: boolean;
  readonly onRule: () => void;
  readonly onDecline: () => void;
}) {
  return (
    <div className="rule-offer">
      <p>
        File every “{payee}” under {category.name} from {describeMonth(current, LOCALE)} on?
      </p>
      <div className="rule-offer-actions">
        <button
          type="button"
          className="secondary small-action"
          disabled={disabled}
          onClick={onRule}
        >
          Make it a rule
        </button>
        <button type="button" className="quiet" onClick={onDecline}>
          Just this one
        </button>
      </div>
    </div>
  );
}

export function ruledNote(payee: string, current: Month): string {
  return `Every “${payee}” from ${describeMonth(current, LOCALE)} on is filed by the rule. Earlier months are as they were.`;
}

/* ─── a transaction in a list ───────────────────────────────────────────────────────────── */

/**
 * Wherever "Uncategorized" is shown, it can be categorized there (Nora, 26 Sep: "If the word
 * uncategorized is displayed, we should have the ability to categorize it right then and
 * there"). One picker per page, opened with the row's own save, rather than one per row: UI-08
 * found ~65 dialogs in a month's list otherwise.
 */
export function usePicker(data: FilingData): {
  readonly open: (entry: Filable, pick: (categoryId: string | null) => void) => void;
  readonly sheet: ReactElement;
} {
  const [picking, setPicking] = useState<{
    readonly entry: Filable;
    readonly pick: (categoryId: string | null) => void;
  } | null>(null);
  const choose = (id: string | null) => {
    if (picking === null) return;
    setPicking(null);
    picking.pick(id);
  };
  const sheet = (
    <Sheet
      title={picking === null ? 'Category' : `Category for ${payeeName(picking.entry.transaction)}`}
      open={picking !== null}
      onClose={() => setPicking(null)}
    >
      {picking !== null && (
        <CategoryPicker
          currentId={picking.entry.filed.kind === 'none' ? null : picking.entry.filed.category.id}
          categories={data.categories}
          recent={recentCategories(data.choices, data.categories, RECENT)}
          onPick={choose}
        >
          {picking.entry.filed.kind === 'paired' && <PairedNote filed={picking.entry.filed} />}
          {picking.entry.filed.kind === 'chosen' && (
            <TakeBack entry={picking.entry} data={data} onPick={choose} />
          )}
        </CategoryPicker>
      )}
    </Sheet>
  );
  return { open: (entry, pick) => setPicking({ entry, pick }), sheet };
}

/** Beneath a payee in a month's list: its account, and whether it is still pending. */
export function accountMeta(
  account: AccountRow | undefined,
  transaction: TransactionRow,
): string[] {
  return [
    account === undefined ? null : account.name || 'Unnamed account',
    transaction.pending ? 'pending' : null,
  ].filter((part) => part !== null);
}

/**
 * A transaction on two lines: who, and what is said about it beneath; what, and where it is
 * filed, as a chip that opens the page's picker. The rule question and any refusal follow it.
 */
export function FilingRow({
  entry,
  meta,
  linkPayee = true,
  data,
  current,
  userId,
  online,
  onOpen,
  onFiled,
}: {
  readonly entry: Filable;
  /** Beneath the payee: the account, the day, whether it is pending. */
  readonly meta: readonly string[];
  readonly linkPayee?: boolean;
  readonly data: FilingData;
  readonly current: Month;
  readonly userId: string;
  readonly online: boolean;
  readonly onOpen: (entry: Filable, pick: (categoryId: string | null) => void) => void;
  /** Keeps the row where it is after it is filed elsewhere, where a list is by category. */
  readonly onFiled?: () => void;
}) {
  const { transaction, filed } = entry;
  const filing = useFiling(entry, data, current, userId);
  const payee = payeeName(transaction);
  const key = payeeOf(transaction);

  const pick = (categoryId: string | null) => {
    onFiled?.();
    void filing.choose(categoryId);
  };

  return (
    <li className="entry">
      <div className="account">
        {linkPayee && key !== '' ? <a href={payeeHref(key)}>{payee}</a> : <span>{payee}</span>}
        {meta.length > 0 && <span className="muted small">{meta.join(' · ')}</span>}
      </div>
      <div className="entry-side">
        <span className="amount">
          {formatMinor(transaction.amount_minor, entry.currency, LOCALE)}
        </span>
        <CategoryChip
          filed={filed}
          payee={payee}
          disabled={!online || filing.busy}
          onOpen={() => onOpen(entry, pick)}
        />
      </div>
      {filing.offer !== null && (
        <div className="note">
          <RuleOffer
            payee={payee}
            category={filing.offer}
            current={current}
            disabled={!online || filing.busy}
            onRule={() => void filing.makeRule()}
            onDecline={filing.decline}
          />
        </div>
      )}
      {filing.ruled && (
        <div className="note muted small" role="status">
          {ruledNote(payee, current)}
        </div>
      )}
      {filing.problem !== null && (
        <div className="note error small" role="alert">
          {filing.problem}
        </div>
      )}
    </li>
  );
}

/* ─── the Categorize queue ──────────────────────────────────────────────────────────────── */

type Cursor = { readonly at: number; readonly state: 'here' | 'moving' | 'done' };

/**
 * The month's uncategorized transactions one at a time, the rule question asked on each. The
 * queue is fixed when it opens: under the old Unsorted filter, choosing a category dropped the
 * row at once, and the rule question and any refusal went with it (design audit, 26 Sep).
 * "Categorize", not "Sort", from UI-11: Nora, 26 Sep, and "Sort" reads as reordering a list.
 */
export function CategorizeQueue({
  data,
  recent,
  current,
  userId,
  online,
  onDone,
}: {
  readonly data: BudgetMonth;
  readonly recent: readonly CategoryRow[];
  readonly current: Month;
  readonly userId: string;
  readonly online: boolean;
  readonly onDone: () => void;
}) {
  const [queue] = useState(() =>
    data.entries.filter((e) => e.filed.kind === 'none').map((e) => e.transaction.id),
  );
  const [cursor, setCursor] = useState<Cursor>({
    at: 0,
    state: queue.length === 0 ? 'done' : 'here',
  });
  const [said, setSaid] = useState<string | null>(null);
  const byId = new Map(data.entries.map((e) => [e.transaction.id, e]));
  const unsorted = (id: string) => byId.get(id)?.filed.kind === 'none';
  const id = queue[cursor.at];
  const entry = id === undefined ? undefined : byId.get(id);

  // Moving on waits for the choice to land in the rows, so a rule made with it has sorted the
  // rest of that payee's by then and the queue passes over them. A transaction gone from the
  // month (the sync removed it) is passed over too.
  if (
    cursor.state !== 'done' &&
    (entry === undefined || (cursor.state === 'moving' && entry.filed.kind !== 'none'))
  ) {
    const next = nextToSort(queue, cursor.at, unsorted);
    setCursor(next === null ? { at: cursor.at, state: 'done' } : { at: next, state: 'here' });
  }

  if (cursor.state === 'done' || entry === undefined) {
    return (
      <div className="queue-done">
        {said !== null && (
          <p className="muted small" role="status">
            {said}
          </p>
        )}
        <p>Nothing is left to categorize in {describeMonth(data.month, LOCALE)}.</p>
        <button type="button" className="secondary" onClick={onDone}>
          Back to the budget
        </button>
      </div>
    );
  }

  const skipTo = nextToSort(queue, cursor.at, unsorted);
  return (
    <>
      {said !== null && (
        <p className="muted small" role="status">
          {said}
        </p>
      )}
      <QueueCard
        // A fresh card per transaction, so no rule question outlives the one it was about.
        key={entry.transaction.id}
        entry={entry}
        account={data.accounts.get(entry.transaction.account_id)}
        data={data}
        recent={recent}
        current={current}
        userId={userId}
        online={online}
        moving={cursor.state === 'moving'}
        position={`${cursor.at + 1} of ${queue.length}`}
        onFiled={(note) => {
          setSaid(note);
          setCursor({ at: cursor.at, state: 'moving' });
        }}
        onBack={cursor.at > 0 ? () => setCursor({ at: cursor.at - 1, state: 'here' }) : null}
        onSkip={
          skipTo !== null
            ? () => {
                setSaid(null);
                setCursor({ at: skipTo, state: 'here' });
              }
            : entry.filed.kind !== 'none'
              ? () => setCursor({ at: cursor.at, state: 'done' })
              : null
        }
      />
    </>
  );
}

function QueueCard({
  entry,
  account,
  data,
  recent,
  current,
  userId,
  online,
  moving,
  position,
  onFiled,
  onBack,
  onSkip,
}: {
  readonly entry: Entry;
  readonly account: AccountRow | undefined;
  readonly data: BudgetMonth;
  readonly recent: readonly CategoryRow[];
  readonly current: Month;
  readonly userId: string;
  readonly online: boolean;
  /** Filed, and waiting for the rows to say so before the next. */
  readonly moving: boolean;
  readonly position: string;
  readonly onFiled: (note: string) => void;
  readonly onBack: (() => void) | null;
  readonly onSkip: (() => void) | null;
}) {
  const filing = useFiling(entry, data, current, userId);
  const [picking, setPicking] = useState(false);
  const { transaction, filed } = entry;
  const payee = payeeName(transaction);
  const key = payeeOf(transaction);
  const bankText = transaction.description.trim();
  const off = !online || filing.busy || moving;

  const pick = async (categoryId: string | null) => {
    setPicking(false);
    const chosen = data.categories.find((c) => c.id === categoryId);
    const result = await filing.choose(categoryId);
    if (result === 'filed' && chosen !== undefined) {
      onFiled(`${payee} is filed under ${chosen.name}.`);
    }
  };

  return (
    <article className="queue-card" aria-labelledby={`queue-${transaction.id}`}>
      <p className="queue-position muted small">{position}</p>
      <div className="queue-head">
        <h4 id={`queue-${transaction.id}`}>
          {key === '' ? payee : <a href={payeeHref(key)}>{payee}</a>}
        </h4>
        <div className="queue-amount">
          {formatMinor(transaction.amount_minor, entry.currency, LOCALE)}
        </div>
      </div>
      <p className="muted small">
        {describeWeekday(entry.day, LOCALE)}
        {account !== undefined && ` · ${account.name || 'Unnamed account'}`}
        {transaction.pending && ' · pending'}
      </p>
      {/* What the bank said and what Monarch called it: the two clues to what it was. */}
      {bankText !== '' && bankText !== payee && <p className="muted small">“{bankText}”</p>}
      {transaction.source_category !== null && (
        <p className="muted small">Monarch called it {transaction.source_category}.</p>
      )}

      {filing.offer !== null ? (
        <>
          {/* The save said before the question about the rest: the question alone read as if
              nothing had been filed yet. */}
          <p className="saved small">Filed under {filing.offer.name}.</p>
          <RuleOffer
            payee={payee}
            category={filing.offer}
            current={current}
            disabled={!online || filing.busy}
            onRule={() => {
              void filing.makeRule().then((made) => {
                if (made) onFiled(ruledNote(payee, current));
              });
            }}
            onDecline={() => {
              const category = filing.offer;
              filing.decline();
              if (category !== null) onFiled(`${payee} is filed under ${category.name}.`);
            }}
          />
        </>
      ) : (
        <>
          {filed.kind !== 'none' && (
            <p className="small">
              <OriginMark kind={filed.kind} /> {filed.category.name}, {ORIGIN[filed.kind]}.
            </p>
          )}
          <div className="queue-choices" role="group" aria-label={`File ${payee} under`}>
            {recent.map((category) => (
              <button
                key={category.id}
                type="button"
                className="chip"
                aria-pressed={filed.kind !== 'none' && filed.category.id === category.id}
                disabled={off}
                onClick={() => void pick(category.id)}
              >
                <span className="chip-name">{category.name}</span>
              </button>
            ))}
            <button
              type="button"
              className="chip more"
              disabled={off}
              onClick={() => setPicking(true)}
            >
              {recent.length > 0 ? 'Another category…' : 'Choose a category…'}
            </button>
          </div>
        </>
      )}
      {!online && <p className="muted small">Categorizing waits for a signal.</p>}
      {filing.problem !== null && (
        <p className="error small" role="alert">
          {filing.problem}
        </p>
      )}
      <div className="queue-nav">
        <button
          type="button"
          className="quiet"
          disabled={onBack === null}
          onClick={() => onBack?.()}
        >
          Back
        </button>
        <button
          type="button"
          className="quiet"
          disabled={onSkip === null || filing.offer !== null}
          onClick={() => onSkip?.()}
        >
          {filed.kind === 'none' ? 'Skip' : 'Next'}
        </button>
      </div>
      <Sheet title={`Category for ${payee}`} open={picking} onClose={() => setPicking(false)}>
        <CategoryPicker
          currentId={filed.kind === 'none' ? null : filed.category.id}
          categories={data.categories}
          recent={recent}
          onPick={(categoryId) => void pick(categoryId)}
        />
      </Sheet>
    </article>
  );
}
