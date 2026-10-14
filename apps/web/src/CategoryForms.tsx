import { formatMinor } from '@dinora/core/balances';
import type { CategoryKind, CategoryRow, Month, Unclaimed } from '@dinora/core/budgets';
import { budgetFor, CATEGORY_KINDS, describeMonth } from '@dinora/core/budgets';
import { averageSpent, spentBefore } from '@dinora/core/pace';
import { NET_CURRENCY } from '@dinora/core/rates';
import { parseLimit } from '@dinora/core/terms';
import { useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useState } from 'react';

import type { BudgetMonth } from './Budget.tsx';
import type { Problem } from './controls.tsx';
import {
  Actions,
  amountDraft,
  Check,
  CheckList,
  currencyAffix,
  errorFor,
  Field,
  formError,
  Segmented,
} from './controls.tsx';
import {
  addCategory,
  CATEGORIES,
  CATEGORY_BUDGETS,
  removeCategory,
  setBudget,
  updateCategory,
} from './queries/budgets.ts';
import { notDone } from './queries/writes.ts';
import { DangerZone } from './sheet.tsx';
import { LOCALE } from './time.tsx';

/*
 * The forms a category is changed with (UI-11), each in a sheet over the page it is about. They
 * were one form per category, open in a list at the foot of the budget page: every category a
 * second time, and its budget changed there, below every transaction of the month (Nora, 26 Sep:
 * "The form to update a budget items is burried in the list of things").
 */

export const KIND_NAMES: Readonly<Record<CategoryKind, string>> = {
  spend: 'Spending',
  income: 'Income',
  transfer: 'Transfer',
};

/** How many months of spending the budget sheet offers to set a budget from. */
const PAST_MONTHS = 3;

function KindField({
  name,
  kind,
  setKind,
  off,
}: {
  /** The radios' group: one per form, or two forms on a page share one choice. */
  readonly name: string;
  readonly kind: CategoryKind;
  readonly setKind: (kind: CategoryKind) => void;
  readonly off: boolean;
}) {
  return (
    <Segmented
      legend="Kind"
      name={name}
      options={CATEGORY_KINDS.map((option) => ({ value: option, label: KIND_NAMES[option] }))}
      value={kind}
      disabled={off}
      onChange={setKind}
    />
  );
}

/* ─── a new category ────────────────────────────────────────────────────────────────────── */

export function AddCategory({
  userId,
  online,
  onAdded,
}: {
  readonly userId: string;
  readonly online: boolean;
  readonly onAdded?: () => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CategoryKind>('spend');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem<CategoryField> | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > 100) {
      setProblem({ field: 'name', message: 'Give the category a name.' });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await addCategory(userId, { name: trimmed, kind, guessesFrom: [] });
      await client.invalidateQueries({ queryKey: CATEGORIES.queryKey });
      setName('');
      onAdded?.();
    } catch (error) {
      setProblem({ field: null, message: notDone(error, 'saved') });
    } finally {
      setBusy(false);
    }
  };

  const off = !online || busy;
  return (
    <form className="add-figure" onSubmit={(event) => void submit(event)}>
      <div className="fields">
        <Field label="Name" error={errorFor(problem, 'name')}>
          {(control) => (
            <input
              {...control}
              autoComplete="off"
              value={name}
              placeholder="Groceries"
              disabled={off}
              data-autofocus
              onChange={(event) => {
                setName(event.currentTarget.value);
                setProblem(null);
              }}
            />
          )}
        </Field>
        <KindField name="new-category-kind" kind={kind} setKind={setKind} off={off} />
      </div>
      <Actions problem={formError(problem)}>
        <button type="submit" disabled={off}>
          {busy ? 'Adding…' : 'Add category'}
        </button>
      </Actions>
    </form>
  );
}

/* ─── a category's name, kind and guesses ───────────────────────────────────────────────── */

type CategoryDraft = {
  readonly name: string;
  readonly kind: CategoryKind;
  readonly guessesFrom: readonly string[];
};

export type CategoryField = 'name';

export type ReadCategory =
  | {
      readonly ok: true;
      readonly name: string;
      readonly kind: CategoryKind;
      readonly guessesFrom: readonly string[];
    }
  | { readonly ok: false; readonly problem: Problem<CategoryField> };

/** The form's text as a category, or what is wrong with it. */
export function readCategory(draft: CategoryDraft): ReadCategory {
  const name = draft.name.trim();
  if (name === '' || name.length > 100) {
    return { ok: false, problem: { field: 'name', message: 'Give the category a name.' } };
  }
  return { ok: true, name, kind: draft.kind, guessesFrom: draft.guessesFrom };
}

export function EditCategory({
  category,
  unclaimed,
  online,
  onSaved,
  onRemoved,
}: {
  readonly category: CategoryRow;
  readonly unclaimed: readonly Unclaimed[];
  readonly online: boolean;
  readonly onSaved: () => void;
  readonly onRemoved: () => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<CategoryDraft>(() => ({
    name: category.name,
    kind: category.kind,
    guessesFrom: category.guesses_from,
  }));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem<CategoryField> | null>(null);
  const offered = [...category.guesses_from, ...unclaimed.map((u) => u.name)];
  const edit = (next: CategoryDraft) => {
    setDraft(next);
    setProblem(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = readCategory(draft);
    if (!read.ok) {
      setProblem(read.problem);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await updateCategory(category.id, {
        name: read.name,
        kind: read.kind,
        guessesFrom: read.guessesFrom,
      });
      await client.invalidateQueries({ queryKey: CATEGORIES.queryKey });
      onSaved();
    } catch (error) {
      setProblem({ field: null, message: notDone(error, 'saved') });
      setBusy(false);
    }
  };

  const off = !online || busy;
  const toggle = (name: string, on: boolean) =>
    edit({
      ...draft,
      guessesFrom: on ? [...draft.guessesFrom, name] : draft.guessesFrom.filter((n) => n !== name),
    });
  return (
    <>
      <form className="add-figure" onSubmit={(event) => void submit(event)}>
        <div className="fields">
          <Field label="Name" error={errorFor(problem, 'name')}>
            {(control) => (
              <input
                {...control}
                autoComplete="off"
                value={draft.name}
                disabled={off}
                onChange={(event) => edit({ ...draft, name: event.currentTarget.value })}
              />
            )}
          </Field>
          <KindField
            name={`category-kind-${category.id}`}
            kind={draft.kind}
            setKind={(kind) => edit({ ...draft, kind })}
            off={off}
          />
          {draft.kind !== category.kind && (
            <p className="muted small">
              A kind is changed for every month, not from this one: it was wrong all along.
            </p>
          )}
          {offered.length > 0 && (
            <CheckList legend="Takes Monarch’s guesses from" disabled={off}>
              {offered.map((name) => (
                <Check
                  key={name}
                  checked={draft.guessesFrom.includes(name)}
                  onChange={(on) => toggle(name, on)}
                  label={name}
                />
              ))}
            </CheckList>
          )}
        </div>
        <Actions problem={formError(problem)}>
          <button type="submit" disabled={off}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </Actions>
      </form>
      <DangerZone
        label={`Remove ${category.name}`}
        consequence="What it holds goes back to a rule, Monarch’s guess or uncategorized. Its months keep their history."
        online={online}
        onRemove={async () => {
          await removeCategory(category.id);
          await client.invalidateQueries({ queryKey: CATEGORIES.queryKey });
          onRemoved();
        }}
      />
    </>
  );
}

/* ─── a budget ──────────────────────────────────────────────────────────────────────────── */

export type ReadBudget =
  | { readonly ok: true; readonly minor: number | null }
  | { readonly ok: false; readonly problem: Problem<'budget'> };

/** A budget as typed: an amount, or empty for none. */
export function readBudget(text: string): ReadBudget {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, minor: null };
  const minor = parseLimit(trimmed, NET_CURRENCY);
  return minor === null
    ? {
        ok: false,
        problem: {
          field: 'budget',
          message: 'Enter the budget as a number, like 600, or leave it empty.',
        },
      }
    : { ok: true, minor };
}

/** "Aug". */
export function shortMonth(month: Month): string {
  return new Intl.DateTimeFormat(LOCALE, { month: 'short', timeZone: 'UTC' }).format(
    Date.parse(`${month}-01T00:00:00Z`),
  );
}

/**
 * A category's budget from `month` on, with what it spent in the months before to set it from:
 * set straight from the month's list, or from the category's own page (Nora, 26 Sep: "Let them
 * straight from the list"). A month already over offers none; its budget stays as it was.
 */
export function BudgetForm({
  category,
  month,
  data,
  userId,
  online,
  onSaved,
}: {
  readonly category: CategoryRow;
  readonly month: Month;
  readonly data: BudgetMonth;
  readonly userId: string;
  readonly online: boolean;
  readonly onSaved: () => void;
}) {
  const client = useQueryClient();
  const budget = budgetFor(category.id, month, data.budgets);
  const before = budget === null ? '' : amountDraft(budget.amountMinor, budget.row.currency);
  const [text, setText] = useState(before);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem<'budget'> | null>(null);
  const past = spentBefore(category.id, month, PAST_MONTHS, data.history);
  const average = averageSpent(past);
  const offers = [
    ...past.flatMap((p) =>
      p.spent.kind === 'summed'
        ? [{ label: shortMonth(p.month), minor: p.spent.minor > 0n ? p.spent.minor : 0n }]
        : [],
    ),
    ...(average === null ? [] : [{ label: 'Average', minor: average }]),
  ];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = readBudget(text);
    if (!read.ok) {
      setProblem(read.problem);
      return;
    }
    if (text.trim() === before.trim()) {
      onSaved();
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await setBudget(userId, category.id, month, read.minor, NET_CURRENCY, data.budgets);
      await client.invalidateQueries({ queryKey: CATEGORY_BUDGETS.queryKey });
      onSaved();
    } catch (error) {
      setProblem({ field: null, message: notDone(error, 'saved') });
      setBusy(false);
    }
  };

  const off = !online || busy;
  return (
    <form className="add-figure budget-form" onSubmit={(event) => void submit(event)}>
      <div className="fields">
        <Field
          label="Each month"
          hint={`From ${describeMonth(month, LOCALE)} on. Leave it empty for no budget.`}
          error={errorFor(problem, 'budget')}
          {...currencyAffix(NET_CURRENCY)}
        >
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              autoComplete="off"
              value={text}
              placeholder="None"
              disabled={off}
              data-autofocus
              onChange={(event) => {
                setText(event.currentTarget.value);
                setProblem(null);
              }}
            />
          )}
        </Field>
        {offers.length > 0 && (
          <div className="budget-offers" role="group" aria-label="What it spent">
            <p className="muted small">What it spent</p>
            <div className="budget-offer-list">
              {offers.map((offer) => (
                <button
                  key={offer.label}
                  type="button"
                  className="chip"
                  disabled={off}
                  aria-label={`Use ${offer.label === 'Average' ? 'the average' : offer.label}, ${formatMinor(offer.minor, NET_CURRENCY, LOCALE)}`}
                  onClick={() => {
                    setText(amountDraft(offer.minor, NET_CURRENCY));
                    setProblem(null);
                  }}
                >
                  <span className="chip-name">
                    {offer.label} {formatMinor(offer.minor, NET_CURRENCY, LOCALE)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <Actions problem={formError(problem)}>
        <button type="submit" disabled={off}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </Actions>
    </form>
  );
}
