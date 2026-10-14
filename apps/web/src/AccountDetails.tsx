import type { AccountRow } from '@dinora/core/balances';
import { formatMinor, isStale } from '@dinora/core/balances';
import type { Group, Placement } from '@dinora/core/groups';
import { GROUPS, placeAccounts } from '@dinora/core/groups';
import { describeDay } from '@dinora/core/networth';
import { readSource } from '@dinora/core/reading';
import type { CardTerms, Figure, TermKind, TermRow } from '@dinora/core/terms';
import {
  cardTerms,
  formatRate,
  formatTenths,
  headroom,
  limitOf,
  parseLimit,
  parseRate,
  promoState,
  TERM_KINDS,
} from '@dinora/core/terms';
import { monthOf } from '@dinora/core/budgets';
import { useQueryClient } from '@tanstack/react-query';
import type { FormEvent, ReactNode } from 'react';
import { useMemo, useState } from 'react';

import type { ActivityData, Filing } from './Activity.tsx';
import { TransactionLine, useActivity } from './Activity.tsx';
import type { Problem } from './controls.tsx';
import { Actions, currencyAffix, errorFor, Field, formError, Segmented } from './controls.tsx';
import { useOnline } from './device/useOnline.ts';
import { ACCOUNTS } from './queries/balances.ts';
import { ACCOUNT_GROUPS, setAccountGroup } from './queries/groups.ts';
import { ReadAgain } from './ReadAgain.tsx';
import { useSynced } from './queries/synced.ts';
import type { NewTerm } from './queries/terms.ts';
import { ACCOUNT_TERMS, addTerm, removeTerm } from './queries/terms.ts';
import { DASHBOARD_HREF } from './route.ts';
import { Sheet } from './sheet.tsx';
import { usePicker } from './Sorting.tsx';
import { Age, localDay, LOCALE, useNow } from './time.tsx';
import { notDone } from './queries/writes.ts';

/** An account's list starts with this many and opens the rest on asking, as a payee's does. */
const LISTED_AT_FIRST = 50;

const ONE_GROUP: Readonly<Record<Group, string>> = {
  cash: 'Cash',
  card: 'Credit card',
  loan: 'Loan',
  investment: 'Investment',
};

const TERM_NAMES: Readonly<Record<TermKind, string>> = {
  credit_limit: 'Credit limit',
  cash_advance_limit: 'Cash advance limit',
  purchase_apr: 'Purchase APR',
  promo_apr: 'Promo APR',
};

/**
 * The same four, short enough to sit side by side on a phone, and none the same as a field's
 * label below them, or a screen reader hears two controls by one name.
 */
const SHORT_TERM_NAMES: Readonly<Record<TermKind, string>> = {
  credit_limit: 'Limit',
  cash_advance_limit: 'Cash advance',
  purchase_apr: 'APR',
  promo_apr: 'Promo',
};

/**
 * One account (ACCT-10): its balance, its group, for a card the terms no bank sends — the
 * limits and rates Nora reads off a statement and enters here — and every transaction in it
 * (ACCT-17). Edits are off with no signal, as the group's are (PLAT-02); what was entered
 * before still shows.
 */
export function AccountDetails({
  accountId,
  userId,
}: {
  readonly accountId: string;
  readonly userId: string;
}) {
  const accounts = useSynced(ACCOUNTS);
  const groups = useSynced(ACCOUNT_GROUPS);
  const terms = useSynced(ACCOUNT_TERMS);
  const online = useOnline();
  const now = useNow();

  if (accounts.status === 'waiting') return <section aria-busy="true" />;
  const placed =
    accounts.status === 'held'
      ? placeAccounts(accounts.rows, groups.status === 'held' ? groups.rows : []).find(
          (p) => p.account.id === accountId,
        )
      : undefined;

  if (placed === undefined) {
    return (
      <section className="details">
        <Back />
        <p className="muted">
          {accounts.status === 'failed'
            ? 'Dinora could not be reached, and this device has no accounts saved from before.'
            : 'This account is not in Dinora.'}
        </p>
      </section>
    );
  }

  const { account, placement } = placed;
  const stale = isStale(account.balance_at, now);
  const source = readSource(account.source);
  const today = localDay(now);

  return (
    <section className="details" aria-labelledby="account-title">
      <Back />
      <h2 id="account-title">{account.name || 'Unnamed account'}</h2>
      <p className="muted small">{account.institution}</p>

      <div className="hero-value">
        {formatMinor(account.balance_minor, account.currency, LOCALE)}
      </div>
      <p className={stale ? 'age stale small' : 'age muted small'}>
        {stale ? 'Not updated since ' : 'As of '}
        <Age at={account.balance_at} now={now} />
      </p>
      {/* Read again from here too (BANK-18): the amber line above is what sends her looking. */}
      {stale && source !== null && <ReadAgain source={source} still="it" online={online} />}

      <div className="details-group">
        <span className="label">Group</span>
        <GroupControl account={account} placement={placement} online={online} userId={userId} />
      </div>

      {isCardLike(placement) ? (
        <Terms
          account={account}
          terms={cardTerms(terms.status === 'held' ? terms.rows : [], account.id, today)}
          today={today}
          online={online}
          userId={userId}
        />
      ) : (
        <p className="muted small">
          Limits and rates are kept for credit cards. Set this account's group to Credit card to add
          them.
        </p>
      )}

      <AccountTransactions accountId={account.id} today={today} userId={userId} />
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

/**
 * A card, or a guess that might be one — a *Line of Credit* torn between a loan and a card has
 * a limit and a rate either way, so it gets the section before she settles the group.
 */
function isCardLike(placement: Placement): boolean {
  switch (placement.kind) {
    case 'set':
    case 'likely':
      return placement.group === 'card';
    case 'unsure':
      return placement.group === 'card' || placement.or === 'card';
    case 'unknown':
      return false;
  }
}

/** What the empty choice says: the guess, the doubt, or that there is nothing to go on. */
function unsetLabel(placement: Placement): string | null {
  switch (placement.kind) {
    case 'set':
      return null;
    case 'likely':
      return `Guess: ${ONE_GROUP[placement.group].toLowerCase()}`;
    case 'unsure':
      return `${ONE_GROUP[placement.group]} or ${ONE_GROUP[placement.or].toLowerCase()}?`;
    case 'unknown':
      return 'Choose a group';
  }
}

/**
 * Her choice of group. Until she makes one the select shows the guess as its empty option,
 * so picking the guessed group is how she confirms it: the guess is never saved as if it
 * were hers. Off with no signal, since nothing is queued (PLAT-02).
 */
function GroupControl({
  account,
  placement,
  online,
  userId,
}: {
  readonly account: AccountRow;
  readonly placement: Placement;
  readonly online: boolean;
  readonly userId: string;
}) {
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // A choice that saves the moment it is made says so; it was silent before (UI-02).
  const [saved, setSaved] = useState(false);
  const unset = unsetLabel(placement);

  const choose = async (value: string) => {
    const group = GROUPS.find((g) => g === value);
    if (group === undefined) return;
    setSaving(true);
    setFailed(null);
    setSaved(false);
    try {
      await setAccountGroup(userId, account.id, group);
      await client.invalidateQueries({ queryKey: ACCOUNT_GROUPS.queryKey });
      setSaved(true);
    } catch (error) {
      setFailed(notDone(error, 'saved'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="group-control">
      <select
        aria-label={`Group for ${account.name || 'unnamed account'}`}
        value={placement.kind === 'set' ? placement.group : ''}
        disabled={!online || saving}
        onChange={(event) => void choose(event.currentTarget.value)}
      >
        {unset !== null && (
          <option value="" disabled>
            {unset}
          </option>
        )}
        {GROUPS.map((group) => (
          <option key={group} value={group}>
            {ONE_GROUP[group]}
          </option>
        ))}
      </select>
      {saved && (
        <span className="saved" role="status">
          Saved
        </span>
      )}
      {failed !== null && (
        <span className="error small" role="alert">
          {failed}
        </span>
      )}
    </div>
  );
}

/* ─── what went through it ──────────────────────────────────────────────────────────────── */

/**
 * The account's transactions, newest first, each filed or refiled where it stands — the same
 * lines as Activity's and a payee's, less the account's name, which every one would repeat.
 * Read from what the device holds, so it lists with no signal, as Activity does.
 */
function AccountTransactions({
  accountId,
  today,
  userId,
}: {
  readonly accountId: string;
  readonly today: string;
  readonly userId: string;
}) {
  const data = useActivity(today);
  if (data === 'waiting') return <section aria-busy="true" />;
  if (data === 'failed') {
    return (
      <p className="muted small">
        Dinora could not be reached, and this device has no transactions saved from before.
      </p>
    );
  }
  return (
    <TransactionList accountId={accountId} data={data} current={monthOf(today)} userId={userId} />
  );
}

function TransactionList({
  accountId,
  data,
  current,
  userId,
}: {
  readonly accountId: string;
  readonly data: ActivityData;
  readonly current: string;
  readonly userId: string;
}) {
  const online = useOnline();
  const picker = usePicker(data);
  const filing: Filing = { current, userId, online, onOpen: picker.open };
  const [all, setAll] = useState(false);
  const mine = useMemo(
    () => data.items.filter((item) => item.transaction.account_id === accountId),
    [data, accountId],
  );
  const shown = all ? mine : mine.slice(0, LISTED_AT_FIRST);
  return (
    <section aria-labelledby="account-transactions-title">
      <h3 id="account-transactions-title">
        Transactions{' '}
        {mine.length > 0 && (
          <span className="muted small">
            {mine.length === 1 ? '1 in all' : `${mine.length.toLocaleString(LOCALE)} in all`}
          </span>
        )}
      </h3>
      {mine.length === 0 ? (
        <p className="muted small">No transaction in this account has been read yet.</p>
      ) : (
        <ul className="accounts">
          {shown.map((item) => (
            <TransactionLine
              key={item.transaction.id}
              item={item}
              data={data}
              filing={filing}
              nameAccount={false}
            />
          ))}
        </ul>
      )}
      {shown.length < mine.length && (
        <button type="button" className="quiet small" onClick={() => setAll(true)}>
          Show all {mine.length.toLocaleString(LOCALE)}
        </button>
      )}
      {picker.sheet}
    </section>
  );
}

/* ─── what is in force ──────────────────────────────────────────────────────────────────── */

function Terms({
  account,
  terms,
  today,
  online,
  userId,
}: {
  readonly account: AccountRow;
  readonly terms: CardTerms;
  readonly today: string;
  readonly online: boolean;
  readonly userId: string;
}) {
  const [sheet, setSheet] = useState<'add' | 'list' | null>(null);
  const close = () => setSheet(null);
  const { figures } = terms;
  const limit = limitOf(figures.credit_limit.current);
  const room = limit === null ? null : headroom(account.balance_minor, limit);
  const cashLimit = limitOf(figures.cash_advance_limit.current);
  const money = (minor: number) => formatMinor(minor, account.currency, LOCALE);
  const show = (row: TermRow): string => {
    switch (row.kind) {
      case 'credit_limit':
      case 'cash_advance_limit':
        return money(row.amount_minor);
      case 'purchase_apr':
      case 'promo_apr':
        return formatRate(row.rate_bp);
    }
  };

  return (
    <section className="terms" aria-labelledby="terms-title">
      <h3 id="terms-title">Limits and rates</h3>
      <p className="muted small">
        Entered by you: no bank sends these. Each keeps the day it took effect, so an older figure
        stays in the history when a newer one arrives.
      </p>

      <dl className="figures">
        <FigureRow name="Credit limit" figure={figures.credit_limit} show={show}>
          {room !== null && (
            <p className={room.availableMinor < 0 ? 'error small' : 'muted small'}>
              {money(room.availableMinor)} available · {formatTenths(room.usedTenths)} used
            </p>
          )}
        </FigureRow>
        <FigureRow name="Cash advance limit" figure={figures.cash_advance_limit} show={show}>
          {cashLimit !== null && room !== null && (
            // A cash advance draws on the same line, so it can never exceed what the card has
            // left. How much of the cash line is already drawn no bank says, hence "at most".
            <p className="muted small">
              At most {money(Math.max(0, Math.min(cashLimit, room.availableMinor)))} available now
            </p>
          )}
        </FigureRow>
        <FigureRow name="Purchase APR" figure={figures.purchase_apr} show={show} />
        <FigureRow name="Promo APR" figure={figures.promo_apr} show={show}>
          {figures.promo_apr.current?.kind === 'promo_apr' && (
            <Promo row={figures.promo_apr.current} today={today} />
          )}
        </FigureRow>
      </dl>

      <p>
        <button
          type="button"
          className="secondary small-action"
          disabled={!online}
          onClick={() => setSheet('add')}
        >
          Add a figure
        </button>
      </p>
      {!online && (
        <p className="muted small">Figures can be added when this device is back online.</p>
      )}
      <History rows={terms.history} online={online} show={show} onEdit={() => setSheet('list')} />

      <Sheet title="Add a figure" open={sheet === 'add'} onClose={close}>
        <AddFigure account={account} today={today} online={online} userId={userId} onDone={close} />
      </Sheet>
      <Sheet
        title="Entered figures"
        // Closes with its last row: an empty list of things to remove is nothing to look at.
        open={sheet === 'list' && terms.history.length > 0}
        onClose={close}
      >
        <ul className="term-list">
          {terms.history.map((row) => (
            <HistoryRow key={row.id} row={row} online={online} show={show} />
          ))}
        </ul>
      </Sheet>
    </section>
  );
}

function FigureRow({
  name,
  figure,
  show,
  children,
}: {
  readonly name: string;
  readonly figure: Figure;
  readonly show: (row: TermRow) => string;
  readonly children?: ReactNode;
}) {
  const { current, next } = figure;
  return (
    <div className="figure">
      <dt className="label">{name}</dt>
      <dd>
        {current === null ? (
          <span className="muted">Not entered</span>
        ) : (
          <>
            <span className="figure-value">{show(current)}</span>{' '}
            <span className="muted small">
              since <Day on={current.effective_on} />
            </span>
          </>
        )}
        {children}
        {next !== null && (
          <p className="muted small">
            {show(next)} from <Day on={next.effective_on} />
          </p>
        )}
      </dd>
    </div>
  );
}

function Promo({
  row,
  today,
}: {
  readonly row: Extract<TermRow, { kind: 'promo_apr' }>;
  readonly today: string;
}) {
  const state = promoState(row.ends_on, today);
  if (state.kind === 'ended') {
    return (
      <p className="muted small">
        Ended <Day on={row.ends_on} />
      </p>
    );
  }
  return (
    <p className={state.endingSoon ? 'error small' : 'muted small'}>
      Until <Day on={row.ends_on} /> · {state.daysLeft} {state.daysLeft === 1 ? 'day' : 'days'} left
    </p>
  );
}

function Day({ on }: { readonly on: string }) {
  return <time dateTime={on}>{describeDay(on, LOCALE)}</time>;
}

/* ─── adding one ────────────────────────────────────────────────────────────────────────── */

type Draft = { kind: TermKind; value: string; effectiveOn: string; endsOn: string };

type DraftField = 'value' | 'effectiveOn' | 'endsOn';

const wrong = (field: DraftField, message: string) =>
  ({ ok: false, problem: { field, message } }) as const;

/** The draft as a row to add, or what is wrong with it in words she can act on. */
function readDraft(
  draft: Draft,
  currency: string,
): { ok: true; term: NewTerm } | { ok: false; problem: Problem<DraftField> } {
  if (draft.effectiveOn === '') return wrong('effectiveOn', 'Say which day it took effect.');
  switch (draft.kind) {
    case 'credit_limit':
    case 'cash_advance_limit': {
      const amountMinor = parseLimit(draft.value, currency);
      return amountMinor === null
        ? wrong('value', 'Enter the limit as a number, like 12,500.')
        : { ok: true, term: { kind: draft.kind, effectiveOn: draft.effectiveOn, amountMinor } };
    }
    case 'purchase_apr': {
      const rateBp = parseRate(draft.value);
      return rateBp === null
        ? wrong('value', 'Enter the rate as a percent, like 24.99.')
        : { ok: true, term: { kind: 'purchase_apr', effectiveOn: draft.effectiveOn, rateBp } };
    }
    case 'promo_apr': {
      const rateBp = parseRate(draft.value);
      if (rateBp === null) return wrong('value', 'Enter the rate as a percent, like 0.');
      if (draft.endsOn === '' || draft.endsOn <= draft.effectiveOn) {
        return wrong('endsOn', 'Say the day the promo ends, after the day it started.');
      }
      return {
        ok: true,
        term: { kind: 'promo_apr', effectiveOn: draft.effectiveOn, rateBp, endsOn: draft.endsOn },
      };
    }
  }
}

function AddFigure({
  account,
  today,
  online,
  userId,
  onDone,
}: {
  readonly account: AccountRow;
  readonly today: string;
  readonly online: boolean;
  readonly userId: string;
  /** Saved or cancelled: the sheet closes, and the terms show the new figure. */
  readonly onDone: () => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft>({
    kind: 'credit_limit',
    value: '',
    effectiveOn: today,
    endsOn: '',
  });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem<DraftField> | null>(null);
  const isRate = draft.kind === 'purchase_apr' || draft.kind === 'promo_apr';
  // Editing is answering the problem, so it goes until the next Add says otherwise.
  const edit = (next: Draft) => {
    setDraft(next);
    setProblem(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = readDraft(draft, account.currency);
    if (!read.ok) {
      setProblem(read.problem);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await addTerm(userId, account.id, read.term);
      await client.invalidateQueries({ queryKey: ACCOUNT_TERMS.queryKey });
      onDone();
    } catch (error) {
      setProblem({ field: null, message: notDone(error, 'saved') });
      setSaving(false);
    }
  };

  const off = !online || saving;
  const name = TERM_NAMES[draft.kind];
  return (
    <form className="add-figure" onSubmit={(event) => void submit(event)}>
      {!online && (
        <p className="muted small">Figures can be added when this device is back online.</p>
      )}
      <div className="fields">
        <Segmented
          legend="Figure"
          name="term-kind"
          options={TERM_KINDS.map((kind) => ({ value: kind, label: SHORT_TERM_NAMES[kind] }))}
          value={draft.kind}
          disabled={off}
          onChange={(kind) => edit({ ...draft, kind })}
        />
        <Field
          label={name}
          error={errorFor(problem, 'value')}
          {...(isRate ? { after: '%' } : currencyAffix(account.currency))}
        >
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              autoComplete="off"
              value={draft.value}
              placeholder={isRate ? '24.99' : '12,500'}
              disabled={off}
              onChange={(event) => edit({ ...draft, value: event.currentTarget.value })}
            />
          )}
        </Field>
        <Field label="Takes effect" error={errorFor(problem, 'effectiveOn')}>
          {(control) => (
            <input
              {...control}
              type="date"
              value={draft.effectiveOn}
              disabled={off}
              onChange={(event) => edit({ ...draft, effectiveOn: event.currentTarget.value })}
            />
          )}
        </Field>
        {draft.kind === 'promo_apr' && (
          <Field label="Ends" error={errorFor(problem, 'endsOn')}>
            {(control) => (
              <input
                {...control}
                type="date"
                value={draft.endsOn}
                disabled={off}
                onChange={(event) => edit({ ...draft, endsOn: event.currentTarget.value })}
              />
            )}
          </Field>
        )}
      </div>
      <Actions problem={formError(problem)}>
        <button type="submit" disabled={off}>
          {saving ? 'Adding…' : `Add ${name.charAt(0).toLowerCase()}${name.slice(1)}`}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </Actions>
    </form>
  );
}

/* ─── what was entered ──────────────────────────────────────────────────────────────────── */

/** Every figure entered, to read; taking one back is in the sheet its button opens (UI-03). */
function History({
  rows,
  online,
  show,
  onEdit,
}: {
  readonly rows: readonly TermRow[];
  readonly online: boolean;
  readonly show: (row: TermRow) => string;
  readonly onEdit: () => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="term-history" aria-labelledby="term-history-title">
      <div className="section-head">
        <h3 id="term-history-title">Entered</h3>
        <button type="button" className="quiet" disabled={!online} onClick={onEdit}>
          Remove one
        </button>
      </div>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <TermText row={row} show={show} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function TermText({
  row,
  show,
}: {
  readonly row: TermRow;
  readonly show: (row: TermRow) => string;
}) {
  return (
    <span>
      {TERM_NAMES[row.kind]} {show(row)}{' '}
      <span className="muted small">
        from <Day on={row.effective_on} />
        {row.kind === 'promo_apr' && (
          <>
            {' '}
            to <Day on={row.ends_on} />
          </>
        )}
      </span>
    </span>
  );
}

/**
 * One entered figure, with a way to take it back. Two steps, since a slip of the thumb on a
 * phone should not remove a rate; a removal is kept in the table all the same (invariant 2).
 */
function HistoryRow({
  row,
  online,
  show,
}: {
  readonly row: TermRow;
  readonly online: boolean;
  readonly show: (row: TermRow) => string;
}) {
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await removeTerm(row.id);
      await client.invalidateQueries({ queryKey: ACCOUNT_TERMS.queryKey });
    } catch (error) {
      setFailed(notDone(error, 'removed'));
      setBusy(false);
    }
  };

  const what = `${TERM_NAMES[row.kind]} ${show(row)}`;
  return (
    <li>
      <TermText row={row} show={show} />
      {asking ? (
        <span className="confirm small">
          <button
            type="button"
            className="quiet danger"
            aria-label={`Yes, remove ${what}`}
            disabled={!online || busy}
            onClick={() => void remove()}
          >
            Remove
          </button>
          <button type="button" className="quiet" disabled={busy} onClick={() => setAsking(false)}>
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="quiet small"
          disabled={!online}
          aria-label={`Remove ${what}`}
          onClick={() => setAsking(true)}
        >
          Remove
        </button>
      )}
      {failed !== null && (
        <span className="error small" role="alert">
          {failed}
        </span>
      )}
    </li>
  );
}
