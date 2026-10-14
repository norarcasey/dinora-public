import type { AccountRow } from '@dinora/core/balances';
import { formatMinor } from '@dinora/core/balances';
import type { GoalAccountRow, GoalKind, GoalRow, Pace, Progress } from '@dinora/core/goals';
import {
  accountsOf,
  defaultStart,
  formatShare,
  PACE_MIN_DAYS,
  PACE_WINDOW_DAYS,
  progressOf,
} from '@dinora/core/goals';
import type { Placed } from '@dinora/core/groups';
import { placeAccounts, sideOf } from '@dinora/core/groups';
import type { SnapshotRow } from '@dinora/core/history';
import type { DayKind } from '@dinora/core/networth';
import { describeDay, describeShortDay } from '@dinora/core/networth';
import type { GoalPath } from '@dinora/core/projection';
import { goalPath } from '@dinora/core/projection';
import { NET_CURRENCY } from '@dinora/core/rates';
import { parseLimit } from '@dinora/core/terms';
import { useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useState } from 'react';

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
import { useOnline } from './device/useOnline.ts';
import { ACCOUNTS, FX_RATES } from './queries/balances.ts';
import type { GoalDetails as Details } from './queries/goals.ts';
import {
  addGoal,
  GOAL_ACCOUNTS,
  GOALS,
  removeGoal,
  setAccounts,
  updateGoal,
} from './queries/goals.ts';
import { ACCOUNT_GROUPS } from './queries/groups.ts';
import { BALANCE_SNAPSHOTS } from './queries/history.ts';
import { useSynced } from './queries/synced.ts';
import { notDone } from './queries/writes.ts';
import { ProjectionChart, wholeUnits } from './Projection.tsx';
import { DASHBOARD_HREF, goalHref } from './route.ts';
import { DangerZone, Sheet } from './sheet.tsx';
import { localDay, LOCALE, useNow } from './time.tsx';

const KIND_NAMES: Readonly<Record<GoalKind, string>> = {
  save: 'Savings goal',
  payoff: 'Loan payoff',
};

/** Where a start balance came from, when it is not Dinora's own reading. */
const SURENESS_NOTES: Readonly<Record<DayKind, string>> = {
  read: '',
  monarch: ' (Monarch’s balance)',
  statement: ' (the lender’s statement)',
  rebuilt: ' (rebuilt from transactions)',
};

/**
 * One goal (GOAL-01): how far along it is, at what pace, whether that pace makes its date, and
 * the accounts it counts. Everything shown is computed from the accounts' own rows, so it moves
 * each night the banks are read. Edits are off with no signal (PLAT-02).
 */
export function GoalDetails({
  goalId,
  userId,
}: {
  readonly goalId: string;
  readonly userId: string;
}) {
  const goals = useSynced(GOALS);
  const links = useSynced(GOAL_ACCOUNTS);
  const accounts = useSynced(ACCOUNTS);
  const groups = useSynced(ACCOUNT_GROUPS);
  const snapshots = useSynced(BALANCE_SNAPSHOTS);
  const rates = useSynced(FX_RATES);
  const online = useOnline();
  const now = useNow();
  const [editing, setEditing] = useState(false);

  if (goals.status === 'waiting') return <section aria-busy="true" />;
  const goal =
    goals.status === 'held'
      ? goals.rows.find((row) => row.id === goalId && row.deleted_at === null)
      : undefined;
  if (goal === undefined) {
    return (
      <section className="details">
        <Back />
        <p className="muted">
          {goals.status === 'failed'
            ? 'Dinora could not be reached, and this device has no goals saved from before.'
            : 'This goal is not in Dinora.'}
        </p>
      </section>
    );
  }

  const today = localDay(now);
  const heldLinks = links.status === 'held' ? links.rows : [];
  const heldAccounts = accounts.status === 'held' ? accounts.rows : [];
  const heldSnapshots = snapshots.status === 'held' ? snapshots.rows : [];
  const heldRates = rates.status === 'held' ? rates.rows : [];
  const progress = progressOf(goal, heldLinks, heldAccounts, heldSnapshots, heldRates, today);
  const path = goalPath(goal, progress, heldLinks, heldAccounts, heldSnapshots, heldRates, today);
  const placed = placeAccounts(heldAccounts, groups.status === 'held' ? groups.rows : []);
  const counted = accountsOf(goal.id, heldLinks, heldAccounts);

  return (
    <section className="details" aria-labelledby="goal-title">
      <Back />
      <h2 id="goal-title">{goal.name}</h2>
      <p className="muted small">{KIND_NAMES[goal.kind]}</p>
      <Along goal={goal} progress={progress} />
      <PathChart goal={goal} path={path} />
      <p>
        <button
          type="button"
          className="secondary small-action"
          disabled={!online}
          onClick={() => setEditing(true)}
        >
          Edit goal
        </button>
      </p>
      {!online && <p className="muted small">It can be changed when this device is back online.</p>}
      <Counted accounts={counted} />

      <Sheet title={`Edit ${goal.name}`} open={editing} onClose={() => setEditing(false)}>
        <EditGoal
          goal={goal}
          links={heldLinks}
          choices={choicesFor(goal.kind, placed, counted)}
          snapshots={heldSnapshots}
          userId={userId}
          online={online}
          onDone={() => setEditing(false)}
        />
        <Remove goal={goal} online={online} />
      </Sheet>
    </section>
  );
}

function Back() {
  return (
    <a className="back small" href={DASHBOARD_HREF}>
      ← Overview
    </a>
  );
}

function Day({ on }: { readonly on: string }) {
  return <time dateTime={on}>{describeDay(on, LOCALE)}</time>;
}

/**
 * What a goal can count: a payoff, the debts; a saving, everything else. And whatever it counts
 * now, so an account she has since regrouped is not dropped from it silently.
 */
function choicesFor(
  kind: GoalKind,
  placed: readonly Placed[],
  counted: readonly AccountRow[],
): AccountRow[] {
  const now = new Set(counted.map((account) => account.id));
  return placed
    .filter(
      (p) => (sideOf(p.placement) === 'debt') === (kind === 'payoff') || now.has(p.account.id),
    )
    .map((p) => p.account);
}

/* ─── how far along ─────────────────────────────────────────────────────────────────────── */

/** The share as a bar, full at the line. A saving past its target stays full. */
export function GoalBar({ tenths, label }: { readonly tenths: number; readonly label: string }) {
  return (
    <progress className="goal-bar" max={1000} value={Math.min(tenths, 1000)} aria-label={label}>
      {formatShare(tenths)}
    </progress>
  );
}

function Along({ goal, progress }: { readonly goal: GoalRow; readonly progress: Progress }) {
  const money = (minor: bigint) => formatMinor(minor, goal.currency, LOCALE);
  switch (progress.kind) {
    case 'no-accounts':
      return <p className="muted">It counts no accounts yet. Choose some below.</p>;
    case 'unrated':
      return (
        <p className="muted">
          Not worked out: an account it counts is in a currency with no rate into {goal.currency}{' '}
          yet.
        </p>
      );
    case 'save':
      return (
        <>
          <div className="hero-value">{money(progress.balanceMinor)}</div>
          <p className="muted small">of {money(progress.targetMinor)}</p>
          <GoalBar tenths={progress.tenths} label={`${goal.name}, saved`} />
          <p>
            {progress.reached
              ? `Reached: ${formatShare(progress.tenths)} of the target.`
              : `${formatShare(progress.tenths)} there, ${money(progress.gapMinor)} to go.`}
          </p>
          <PaceLine pace={progress.pace} reached={progress.reached} currency={goal.currency} />
          <DeadlineLine progress={progress} currency={goal.currency} />
        </>
      );
    case 'payoff': {
      const { start } = progress;
      return (
        <>
          <div className="hero-value">{money(progress.owedMinor)}</div>
          <p className="muted small">owed</p>
          {progress.tenths !== null && (
            <GoalBar tenths={progress.tenths} label={`${goal.name}, paid off`} />
          )}
          {progress.reached ? (
            <p>Paid off.</p>
          ) : start.kind === 'owed' && progress.paidMinor !== null && progress.tenths !== null ? (
            <p>
              {formatShare(progress.tenths)} paid off:{' '}
              {progress.paidMinor >= 0n
                ? `${money(progress.paidMinor)} since `
                : `it owes ${money(-progress.paidMinor)} more than on `}
              <Day on={start.on} />, when it owed {money(start.owedMinor)}
              {SURENESS_NOTES[start.sureness]}.
            </p>
          ) : start.kind === 'nothing-owed' ? (
            <p className="muted">
              It owed nothing on <Day on={start.on} />, so there is no share to measure from then.
              Choose a later start.
            </p>
          ) : (
            <p className="muted">Dinora has no balance for it yet to measure from.</p>
          )}
          {start.kind === 'owed' && start.moved && (
            <p className="muted small">
              Dinora’s history starts on <Day on={start.on} />, after the day you chose, so it is
              measured from then.
            </p>
          )}
          <PaceLine pace={progress.pace} reached={progress.reached} currency={goal.currency} />
          <DeadlineLine progress={progress} currency={goal.currency} />
        </>
      );
    }
  }
}

/**
 * Where it has been since its start and where its pace takes it (GOAL-02): the sentence above
 * it, drawn. The broken line is that same pace, so the chart can never promise a date the words
 * do not.
 */
function PathChart({ goal, path }: { readonly goal: GoalRow; readonly path: GoalPath }) {
  if (path.kind === 'none' || (path.past.length < 2 && path.finish === null)) return null;
  const payoff = goal.kind === 'payoff';
  return (
    <>
      <ProjectionChart
        past={path.past}
        ahead={
          path.finish === null
            ? []
            : [{ ...path.finish, lowMinor: path.finish.minor, highMinor: path.finish.minor }]
        }
        series=""
        currency={goal.currency}
        label={`${goal.name}, ${payoff ? 'owed' : 'saved'} since its start${path.finish === null ? '' : `, and at its pace ${payoff ? 'paid off' : 'reached'} on ${describeDay(path.finish.on, LOCALE)}`}. Use the arrow keys to read each month.`}
        {...(payoff
          ? {}
          : {
              line: {
                minor: path.lineMinor,
                label: `Target ${wholeUnits(path.lineMinor, goal.currency)}`,
              },
            })}
        {...(goal.target_on === null
          ? {}
          : { marker: { on: goal.target_on, label: 'Reach it by' } })}
      />
      {path.finish !== null && (
        <p className="muted small">
          The broken line goes on at that pace until{' '}
          {payoff ? 'nothing is owed' : 'it meets the target'}: a guess from the pace, not a
          promise.
        </p>
      )}
    </>
  );
}

/** "the last 90 days", or "since 1 Aug" when the goal is younger than that. */
function paceSpan(from: string, today: string): string {
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
  return days >= PACE_WINDOW_DAYS
    ? `the last ${PACE_WINDOW_DAYS} days`
    : `since ${describeShortDay(from, LOCALE)}`;
}

function PaceLine({
  pace,
  reached,
  currency,
}: {
  readonly pace: Pace;
  readonly reached: boolean;
  readonly currency: string;
}) {
  const today = localDay(useNow());
  if (reached) return null;
  switch (pace.kind) {
    case 'too-early':
      return (
        <p className="muted small">
          Too soon to tell a pace: {pace.days} {pace.days === 1 ? 'day' : 'days'} of history, and a
          pace needs {PACE_MIN_DAYS}.
        </p>
      );
    case 'unknown':
      return <p className="muted small">No pace: there is no balance to measure it from.</p>;
    case 'stalled':
      return (
        <p className="small">
          It has not moved toward the goal {paceSpan(pace.from, today)}, so no date can be drawn
          from its pace.
        </p>
      );
    case 'moving':
      return (
        <p className="small">
          At the pace of {paceSpan(pace.from, today)}, about{' '}
          {formatMinor(pace.perMonthMinor, currency, LOCALE)} a month,{' '}
          {pace.finishOn === null ? (
            'it is more than a century away.'
          ) : (
            <>
              it gets there on <Day on={pace.finishOn} />.
            </>
          )}
        </p>
      );
  }
}

/**
 * "98 days away", "7 months away", "14 years away". Days past two months read as a figure to
 * work out, not a distance: the mortgage's 2040 was "4846 days away" (seen 25 Sep).
 */
export function describeAway(days: number): string {
  const unit = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`} away`;
  if (days < 60) return unit(days, 'day');
  const months = Math.floor((days * 12) / 365);
  return months < 24 ? unit(months, 'month') : unit(Math.floor(days / 365), 'year');
}

function DeadlineLine({
  progress,
  currency,
}: {
  readonly progress: Extract<Progress, { kind: 'save' | 'payoff' }>;
  readonly currency: string;
}) {
  const { deadline, reached } = progress;
  if (deadline === null || reached) return null;
  if (deadline.daysLeft <= 0) {
    return (
      <p className="small error">
        It was due on <Day on={deadline.on} />.
      </p>
    );
  }
  const away = describeAway(deadline.daysLeft);
  return (
    <p className={deadline.onPace === false ? 'small error' : 'small'}>
      {deadline.onPace === true
        ? 'On pace for '
        : deadline.onPace === false
          ? 'Behind for '
          : 'Due '}
      <Day on={deadline.on} />, {away}.
      {deadline.onPace === false &&
        deadline.perMonthNeededMinor !== null &&
        ` Making it would take about ${formatMinor(deadline.perMonthNeededMinor, currency, LOCALE)} a month from now.`}
    </p>
  );
}

/**
 * The dashboard's one line for a goal: its share and, when it can be told, when it gets there.
 * Months, not days: a line this short is read at a glance, and the page has the day.
 */
export function shortLine(progress: Progress): string {
  if (progress.kind === 'no-accounts') return 'Counts no accounts yet';
  if (progress.kind === 'unrated') return 'Not worked out yet';
  const share =
    progress.tenths === null
      ? null
      : `${formatShare(progress.tenths)}${progress.kind === 'payoff' ? ' paid off' : ''}`;
  if (progress.reached) return progress.kind === 'payoff' ? 'Paid off' : 'Reached';
  const month = (on: string) =>
    new Intl.DateTimeFormat(LOCALE, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
      Date.parse(`${on}T00:00:00Z`),
    );
  const { pace, deadline } = progress;
  const when =
    deadline !== null && deadline.daysLeft <= 0
      ? `was due ${month(deadline.on)}`
      : deadline !== null && deadline.onPace === true
        ? `on pace for ${month(deadline.on)}`
        : deadline !== null && deadline.onPace === false
          ? `behind for ${month(deadline.on)}`
          : pace.kind === 'moving' && pace.finishOn !== null
            ? `about ${month(pace.finishOn)} at this pace`
            : pace.kind === 'stalled'
              ? 'not moving'
              : null;
  return [share, when].filter((part) => part !== null).join(' · ');
}

function Counted({ accounts }: { readonly accounts: readonly AccountRow[] }) {
  if (accounts.length === 0) return null;
  return (
    <div className="goal-counted">
      <h3>{accounts.length === 1 ? 'The account it counts' : 'The accounts it counts'}</h3>
      <ul className="accounts">
        {accounts.map((account) => (
          <li key={account.id}>
            <div className="account">
              <span>{account.name || 'Unnamed account'}</span>
              <span className="muted small">{account.institution}</span>
            </div>
            <div className="amount">
              {formatMinor(account.balance_minor, account.currency, LOCALE)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ─── the form ──────────────────────────────────────────────────────────────────────────── */

type Draft = {
  readonly name: string;
  readonly target: string;
  /** Null until she sets one: the start then follows the accounts chosen (`defaultStart`). */
  readonly startsOn: string | null;
  readonly targetOn: string;
  readonly accountIds: readonly string[];
};

function draftOf(goal: GoalRow | null, accountIds: readonly string[]): Draft {
  return {
    name: goal?.name ?? '',
    target:
      goal === null || goal.target_minor === null
        ? ''
        : amountDraft(goal.target_minor, goal.currency),
    startsOn: goal?.starts_on ?? null,
    targetOn: goal?.target_on ?? '',
    accountIds,
  };
}

export type GoalField = 'name' | 'accounts' | 'target' | 'startsOn' | 'targetOn';

export type ReadGoal =
  | { readonly ok: true; readonly details: Details; readonly accountIds: readonly string[] }
  | { readonly ok: false; readonly problem: Problem<GoalField> };

const wrong = (field: GoalField, message: string) =>
  ({ ok: false, problem: { field, message } }) as const;

/** The form's text as a goal, or what is wrong with it, in the order the fields are read. */
export function readGoal(
  draft: Draft,
  kind: GoalKind,
  currency: string,
  startsOn: string,
  today: string,
): ReadGoal {
  const name = draft.name.trim();
  if (name === '' || name.length > 200) return wrong('name', 'Give the goal a name.');
  if (draft.accountIds.length === 0) {
    return wrong('accounts', 'Choose at least one account for it to count.');
  }
  let targetMinor: number | null = null;
  if (kind === 'save') {
    targetMinor = parseLimit(draft.target, currency);
    if (targetMinor === null || targetMinor === 0) {
      return wrong('target', 'Enter the target as a number, like 20,000.');
    }
  }
  if (startsOn === '' || startsOn > today) {
    return wrong('startsOn', 'Say the day to measure from, today or before.');
  }
  if (draft.targetOn !== '' && draft.targetOn <= startsOn) {
    return wrong('targetOn', 'The day to reach it has to be after the day it starts.');
  }
  return {
    ok: true,
    details: {
      name,
      targetMinor,
      startsOn,
      targetOn: draft.targetOn === '' ? null : draft.targetOn,
    },
    accountIds: draft.accountIds,
  };
}

/**
 * A goal is in dollars unless every account it counts is in one other currency: a euro saving
 * for the Ejemplo account is a euro target, and anything mixed is summed in dollars, as net
 * worth is.
 */
export function currencyFor(accounts: readonly AccountRow[]): string {
  const currencies = new Set(accounts.map((account) => account.currency));
  const [only] = currencies;
  return currencies.size === 1 && only !== undefined ? only : NET_CURRENCY;
}

function GoalFields({
  kind,
  draft,
  setDraft,
  choices,
  currency,
  startsOn,
  problem,
  off,
}: {
  readonly kind: GoalKind;
  readonly draft: Draft;
  readonly setDraft: (next: Draft) => void;
  readonly choices: readonly AccountRow[];
  readonly currency: string;
  readonly startsOn: string;
  readonly problem: Problem<GoalField> | null;
  readonly off: boolean;
}) {
  const toggle = (id: string, on: boolean) =>
    setDraft({
      ...draft,
      accountIds: on ? [...draft.accountIds, id] : draft.accountIds.filter((a) => a !== id),
    });
  return (
    <>
      <Field label="Name" error={errorFor(problem, 'name')} wide>
        {(control) => (
          <input
            {...control}
            autoComplete="off"
            value={draft.name}
            placeholder={kind === 'save' ? 'Emergency fund' : 'Civic paid off'}
            disabled={off}
            onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
          />
        )}
      </Field>
      <CheckList
        legend={kind === 'save' ? 'Accounts it counts' : 'Loans it pays off'}
        error={errorFor(problem, 'accounts')}
        disabled={off}
      >
        {choices.length === 0 ? (
          <p className="muted small">
            {kind === 'save'
              ? 'No cash or investment accounts are linked.'
              : 'No loans or cards are linked. An account’s group is set on its own page.'}
          </p>
        ) : (
          choices.map((account) => (
            <Check
              key={account.id}
              checked={draft.accountIds.includes(account.id)}
              onChange={(on) => toggle(account.id, on)}
              label={account.name || 'Unnamed account'}
              detail={account.institution}
            />
          ))
        )}
      </CheckList>
      {kind === 'save' && (
        <Field label="Target" error={errorFor(problem, 'target')} {...currencyAffix(currency)}>
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              autoComplete="off"
              value={draft.target}
              placeholder="20,000"
              disabled={off}
              onChange={(event) => setDraft({ ...draft, target: event.currentTarget.value })}
            />
          )}
        </Field>
      )}
      <Field
        label={kind === 'save' ? 'Measure its pace from' : 'Measure from'}
        error={errorFor(problem, 'startsOn')}
      >
        {(control) => (
          <input
            {...control}
            type="date"
            value={startsOn}
            disabled={off}
            onChange={(event) => setDraft({ ...draft, startsOn: event.currentTarget.value })}
          />
        )}
      </Field>
      <Field label="Reach it by" hint="Optional" error={errorFor(problem, 'targetOn')}>
        {(control) => (
          <input
            {...control}
            type="date"
            value={draft.targetOn}
            disabled={off}
            onChange={(event) => setDraft({ ...draft, targetOn: event.currentTarget.value })}
          />
        )}
      </Field>
    </>
  );
}

function EditGoal({
  goal,
  links,
  choices,
  snapshots,
  userId,
  online,
  onDone,
}: {
  readonly goal: GoalRow;
  readonly links: readonly GoalAccountRow[];
  readonly choices: readonly AccountRow[];
  readonly snapshots: readonly SnapshotRow[];
  readonly userId: string;
  readonly online: boolean;
  /** Saved or cancelled: the sheet closes, and the page shows the goal as saved. */
  readonly onDone: () => void;
}) {
  const client = useQueryClient();
  const now = useNow();
  const [draft, setDraft] = useState(() =>
    draftOf(
      goal,
      links
        .filter((link) => link.goal_id === goal.id && link.deleted_at === null)
        .map((link) => link.account_id),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem<GoalField> | null>(null);
  const today = localDay(now);
  const startsOn = draft.startsOn ?? defaultStart(draft.accountIds, snapshots, today);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = readGoal(draft, goal.kind, goal.currency, startsOn, today);
    if (!read.ok) {
      setProblem(read.problem);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await updateGoal(goal.id, read.details);
      await setAccounts(userId, goal.id, links, read.accountIds);
      await client.invalidateQueries({ queryKey: GOALS.queryKey });
      await client.invalidateQueries({ queryKey: GOAL_ACCOUNTS.queryKey });
      onDone();
    } catch (error) {
      setProblem({ field: null, message: notDone(error, 'saved') });
      setSaving(false);
    }
  };

  const off = !online || saving;
  return (
    <form className="add-figure" onSubmit={(event) => void submit(event)}>
      {!online && <p className="muted small">It can be changed when this device is back online.</p>}
      <div className="fields">
        <GoalFields
          kind={goal.kind}
          draft={draft}
          setDraft={(next) => {
            setDraft(next);
            setProblem(null);
          }}
          choices={choices}
          currency={goal.currency}
          startsOn={startsOn}
          problem={problem}
          off={off}
        />
      </div>
      <Actions problem={formError(problem)}>
        <button type="submit" disabled={off}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </Actions>
    </form>
  );
}

/** Reached and done with, or given up: at the foot of its edit sheet. */
function Remove({ goal, online }: { readonly goal: GoalRow; readonly online: boolean }) {
  const client = useQueryClient();
  return (
    <DangerZone
      label={`Remove ${goal.name}`}
      consequence="It leaves the dashboard. Its accounts stay as they are."
      online={online}
      onRemove={async () => {
        await removeGoal(goal.id);
        await client.invalidateQueries({ queryKey: GOALS.queryKey });
        window.location.hash = DASHBOARD_HREF;
      }}
    />
  );
}

/* ─── a new goal ────────────────────────────────────────────────────────────────────────── */

export function NewGoal({ userId }: { readonly userId: string }) {
  const client = useQueryClient();
  const accounts = useSynced(ACCOUNTS);
  const groups = useSynced(ACCOUNT_GROUPS);
  const snapshots = useSynced(BALANCE_SNAPSHOTS);
  const online = useOnline();
  const now = useNow();
  const today = localDay(now);
  const [kind, setKind] = useState<GoalKind>('save');
  const [draft, setDraft] = useState(() => draftOf(null, []));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem<GoalField> | null>(null);
  const edit = (next: Draft) => {
    setDraft(next);
    setProblem(null);
  };

  const heldAccounts = accounts.status === 'held' ? accounts.rows : [];
  const placed = placeAccounts(heldAccounts, groups.status === 'held' ? groups.rows : []);
  const choices = choicesFor(kind, placed, []);
  const chosen = heldAccounts.filter((account) => draft.accountIds.includes(account.id));
  const currency = currencyFor(chosen);
  const startsOn =
    draft.startsOn ??
    defaultStart(draft.accountIds, snapshots.status === 'held' ? snapshots.rows : [], today);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = readGoal(draft, kind, currency, startsOn, today);
    if (!read.ok) {
      setProblem(read.problem);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const id = await addGoal(userId, kind, currency, read.details, read.accountIds);
      await client.invalidateQueries({ queryKey: GOALS.queryKey });
      await client.invalidateQueries({ queryKey: GOAL_ACCOUNTS.queryKey });
      window.location.hash = goalHref(id);
    } catch (error) {
      setProblem({ field: null, message: notDone(error, 'saved') });
      setSaving(false);
    }
  };

  const off = !online || saving;
  return (
    <section className="details" aria-labelledby="new-goal-title">
      <Back />
      <h2 id="new-goal-title">A goal</h2>
      <p className="muted small">
        A saving counts its accounts’ whole balance against a target. A payoff counts down what its
        loans owe from the day you measure from, which can reach back into Monarch’s history.
      </p>
      {!online && <p className="muted small">It can be added when this device is back online.</p>}
      <form className="add-figure" onSubmit={(event) => void submit(event)}>
        <div className="fields">
          <Segmented
            legend="Kind"
            name="goal-kind"
            options={[
              { value: 'save', label: 'Save toward a target' },
              { value: 'payoff', label: 'Pay off a loan' },
            ]}
            value={kind}
            disabled={off}
            onChange={(option) => {
              setKind(option);
              // The other kind chooses from other accounts.
              edit({ ...draft, accountIds: [] });
            }}
          />
          <GoalFields
            kind={kind}
            draft={draft}
            setDraft={edit}
            choices={choices}
            currency={currency}
            startsOn={startsOn}
            problem={problem}
            off={off}
          />
        </div>
        <Actions problem={formError(problem)}>
          <button type="submit" disabled={off}>
            {saving ? 'Adding…' : 'Add goal'}
          </button>
        </Actions>
      </form>
    </section>
  );
}
