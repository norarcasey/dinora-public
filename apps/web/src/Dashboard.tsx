import type { AssetValueRow, Standing } from '@dinora/core/assets';
import {
  combineTotals,
  formatChange,
  onSide,
  propertyRows,
  propertyTotals,
  standings,
  startTogether,
} from '@dinora/core/assets';
import type { AccountRow, LastRead, SourceRead, Total } from '@dinora/core/balances';
import {
  formatMinor,
  isStale,
  lastReads,
  sourceName,
  totalsByCurrency,
  warnedAccounts,
} from '@dinora/core/balances';
import { monthBridge } from '@dinora/core/bridge';
import type { Double } from '@dinora/core/doubles';
import { doubledAccounts, goalsCounting } from '@dinora/core/doubles';
import { describeMonth, monthOf, spentShare } from '@dinora/core/budgets';
import { dueItems } from '@dinora/core/due';
import { PROVIDER_NAMES } from '@dinora/core/estimates';
import type { GoalAccountRow, GoalRow, Progress } from '@dinora/core/goals';
import { progressOf } from '@dinora/core/goals';
import type { Group, Placed, Side } from '@dinora/core/groups';
import { GROUPS, listedUnder, placeAccounts, sideOf } from '@dinora/core/groups';
import { netWorthByDay } from '@dinora/core/networth';
import type { Conversion, NetCurrency, RateRow, Sum } from '@dinora/core/rates';
import { describeRateDate, isRateStale, NET_CURRENCIES, sumIn } from '@dinora/core/rates';
import { cardTerms, headroom, limitOf } from '@dinora/core/terms';
import { wantsSignIn } from '@dinora/core/signing-in';
import { Fragment } from 'react';

import { useOnline } from './device/useOnline.ts';
import { DueSoon } from './Due.tsx';
import type { BudgetMonth } from './Budget.tsx';
import { monthLine, useBudgetMonth } from './Budget.tsx';
import { GoalBar, shortLine } from './GoalDetails.tsx';
import { History } from './NetWorthChart.tsx';
import { PutTogether } from './PutTogether.tsx';
import { BRIDGE_HOME } from './ReadAgain.tsx';
import { SignInAgain } from './SignInAgain.tsx';
import { MonthChange } from './MonthChange.tsx';
import { useNetCurrency } from './netCurrency.ts';
import { ACCOUNTS, BANK_PULLS, FX_RATES } from './queries/balances.ts';
import { GOAL_ACCOUNTS, GOALS } from './queries/goals.ts';
import { ACCOUNT_GROUPS } from './queries/groups.ts';
import { BALANCE_SNAPSHOTS } from './queries/history.ts';
import { ASSET_VALUES, ASSETS } from './queries/assets.ts';
import { useSynced } from './queries/synced.ts';
import { ACCOUNT_TERMS } from './queries/terms.ts';
import {
  accountHref,
  assetHref,
  BUDGET_HREF,
  categorizeHref,
  goalHref,
  NEW_ASSET_HREF,
  NEW_GOAL_HREF,
} from './route.ts';
import { Age, localDay, LOCALE, useNow } from './time.tsx';

const GROUP_NAMES: Readonly<Record<Group, string>> = {
  cash: 'Cash',
  card: 'Credit cards',
  loan: 'Loans',
  investment: 'Investments',
};

/**
 * The first screen (ACCT-04): net worth, how it has moved, cash, investments and debt, and every account in
 * its group. It replaced ACCT-01's balances screen, and kept what that screen said about
 * trust: each balance's age, red past 36 hours, when the banks were last read, and what the
 * device is showing when it cannot reach Dinora.
 *
 * It edits nothing: an account's group is set on its own page (ACCT-10), so each row here
 * is only what is in it.
 */
export function Dashboard() {
  const accounts = useSynced(ACCOUNTS);
  const pulls = useSynced(BANK_PULLS);
  const rates = useSynced(FX_RATES);
  const snapshots = useSynced(BALANCE_SNAPSHOTS);
  const groups = useSynced(ACCOUNT_GROUPS);
  const terms = useSynced(ACCOUNT_TERMS);
  const assets = useSynced(ASSETS);
  const values = useSynced(ASSET_VALUES);
  const goals = useSynced(GOALS);
  const goalLinks = useSynced(GOAL_ACCOUNTS);
  const online = useOnline();
  const now = useNow();
  const month = useBudgetMonth(monthOf(localDay(now)), localDay(now));
  const [currency, setCurrency] = useNetCurrency();

  if (accounts.status === 'waiting') return <section aria-busy="true" />;
  if (accounts.status === 'failed') {
    return (
      <p className="error" role="alert">
        Dinora could not be reached, and this device has no balances saved from before.
      </p>
    );
  }

  const heldRates = rates.status === 'held' ? rates.rows : [];
  const reads = pulls.status === 'held' ? lastReads(pulls.rows) : null;
  const placed = placeAccounts(accounts.rows, groups.status === 'held' ? groups.rows : []);
  const today = localDay(now);
  const limits = new Map(
    placed.map((p) => [
      p.account.id,
      limitOf(
        cardTerms(terms.status === 'held' ? terms.rows : [], p.account.id, today).figures
          .credit_limit.current,
      ),
    ]),
  );
  const heldAssets = assets.status === 'held' ? assets.rows : [];
  const heldValues = values.status === 'held' ? values.rows : [];
  const stood = standings(heldAssets, heldValues, accounts.rows, today);
  const netTotals = combineTotals(totalsByCurrency(accounts.rows), propertyTotals(stood));
  const sided = new Map(placed.map((p) => [p.account.id, sideOf(p.placement)]));
  const heldSnapshots = snapshots.status === 'held' ? snapshots.rows : [];
  const together = startTogether(
    heldAssets,
    propertyRows(heldAssets, heldValues),
    heldSnapshots.filter((row) => sided.has(row.account_id)),
  );
  const history =
    snapshots.status === 'held'
      ? netWorthByDay(together.snapshots, sided, heldRates, together.property, currency)
      : null;
  const bridge =
    snapshots.status === 'held'
      ? monthBridge(together.snapshots, sided, heldRates, together.property, currency)
      : null;
  const along = (goals.status === 'held' ? goals.rows : [])
    .filter((goal) => goal.deleted_at === null)
    .map((goal) => ({
      goal,
      progress: progressOf(
        goal,
        goalLinks.status === 'held' ? goalLinks.rows : [],
        accounts.rows,
        heldSnapshots,
        heldRates,
        today,
      ),
    }));
  const due = dueItems(accounts.rows, terms.status === 'held' ? terms.rows : [], along, today);
  // A loan names what it bought, so the debt and the thing it paid for read as a pair.
  const bought = new Map<string, string[]>();
  for (const { asset } of stood) {
    if (asset.financed_by === null) continue;
    bought.set(asset.financed_by, [...(bought.get(asset.financed_by) ?? []), asset.name]);
  }

  return (
    <section className="dashboard">
      {(!online || accounts.stale) && (
        <p className="notice" role="status">
          {online ? 'Dinora could not be reached.' : 'Offline.'} Showing what this device last read,{' '}
          <Age at={new Date(accounts.asOf).toISOString()} now={now} />.
        </p>
      )}

      {reads !== null && (
        <LastPull reads={reads} now={now} online={online} accounts={accounts.rows} />
      )}
      <Doubles
        doubles={doubledAccounts(accounts.rows)}
        goals={goals.status === 'held' ? goals.rows : []}
        goalLinks={goalLinks.status === 'held' ? goalLinks.rows : []}
        online={online}
      />
      <DueSoon due={due} />

      {placed.length === 0 ? (
        <p className="muted">No accounts are linked yet.</p>
      ) : (
        <>
          <NetWorth
            totals={netTotals}
            rates={heldRates}
            count={placed.length}
            valued={stood.filter((s) => s.current !== null).length}
            ratesRead={rates.status !== 'waiting'}
            currency={currency}
            onCurrency={setCurrency}
            now={now}
          />
          <Sides placed={placed} stood={stood} rates={heldRates} currency={currency} />
          {history !== null && <History history={history} />}
          {bridge !== null && (
            <MonthChange
              bridge={bridge}
              names={{
                accounts: new Map(
                  placed.map((p) => [p.account.id, p.account.name || 'Unnamed account']),
                ),
                assets: new Map(heldAssets.map((a) => [a.id, a.name])),
              }}
            />
          )}
          <Goals along={along} />
          <BudgetCard month={month} />
          <Accounts
            placed={placed}
            holdings={onSide(stood, 'investments')}
            bought={bought}
            limits={limits}
            rates={heldRates}
            currency={currency}
            now={now}
          />
          <Property stood={onSide(stood, 'property')} rates={heldRates} currency={currency} />
        </>
      )}
    </section>
  );
}

/* ─── the numbers at the top ────────────────────────────────────────────────────────────── */

const CURRENCY_NAMES: Readonly<Record<NetCurrency, string>> = {
  USD: 'In dollars',
  EUR: 'In euros',
};

/**
 * Every account summed in dollars, or in euros when she asks (ACCT-16), with the rate that
 * converted anything that was not, and its date (ACCT-02). A currency with no rate leaves the
 * figure unsaid rather than short. The switch sits here but moves the whole dashboard (DIN-10):
 * the tiles, the group totals, the chart and the month's change. Those under it convert at the
 * rate named here; the chart's past days and the month's ends at their own day's. An account's
 * own balance stays in its own currency.
 */
function NetWorth({
  totals,
  rates,
  count,
  valued,
  ratesRead,
  currency,
  onCurrency,
  now,
}: {
  readonly totals: readonly Total[];
  readonly rates: readonly RateRow[];
  readonly count: number;
  /** Assets with a value (ACCT-06), which count beside the accounts. */
  readonly valued: number;
  readonly ratesRead: boolean;
  readonly currency: NetCurrency;
  readonly onCurrency: (currency: NetCurrency) => void;
  readonly now: number;
}) {
  const net = sumIn(totals, rates, currency);
  const switcher = (
    <fieldset className="views currency" aria-label="Totals in">
      {NET_CURRENCIES.map((option) => (
        <label key={option}>
          <input
            type="radio"
            name="net-currency"
            value={option}
            aria-label={CURRENCY_NAMES[option]}
            checked={currency === option}
            onChange={() => onCurrency(option)}
          />
          {option}
        </label>
      ))}
    </fieldset>
  );
  if (net.kind === 'unrated') {
    return (
      <div className="hero">
        <div className="label">Net worth</div>
        <div className="hero-line">
          <p className="muted small">
            {ratesRead
              ? `Not summed yet: no exchange rate from ${net.missing.join(', ')} has been read.`
              : 'Waiting for the exchange rates.'}
          </p>
          {switcher}
        </div>
      </div>
    );
  }
  return (
    <div className="hero">
      <div className="label">
        Net worth · {count} {count === 1 ? 'account' : 'accounts'}
        {valued > 0 && ` and ${valued} ${valued === 1 ? 'asset' : 'assets'}`}, all in {net.currency}
      </div>
      <div className="hero-line">
        <div className="hero-value">{formatMinor(net.minor, net.currency, LOCALE)}</div>
        {switcher}
      </div>
      {net.conversions.map((conversion) => (
        <Rate key={conversion.currency} conversion={conversion} to={net.currency} now={now} />
      ))}
    </div>
  );
}

function Rate({
  conversion,
  to,
  now,
}: {
  readonly conversion: Conversion;
  readonly to: string;
  readonly now: number;
}) {
  const { rate } = conversion;
  const stale = isRateStale(rate.rate_date, now);
  return (
    <p className={stale ? 'rate stale small' : 'rate muted small'}>
      {formatMinor(conversion.minor, conversion.currency, LOCALE)} is{' '}
      {formatMinor(conversion.converted, to, LOCALE)} at 1 {rate.base} = {rate.rate} {rate.quote},
      the ECB's rate for{' '}
      <time dateTime={rate.rate_date}>{describeRateDate(rate.rate_date, LOCALE)}</time>.
      {stale && ' No newer rate has been read.'}
    </p>
  );
}

/**
 * Cash, investments, and debt as the amount owed: cards and loans arrive negative (BANK-01),
 * so the owed figure is the sum turned round, and a card in credit makes it smaller. An account
 * whose side is unknown counts in none, and the tiles say so rather than look complete.
 */
function Sides({
  placed,
  stood,
  rates,
  currency,
}: {
  readonly placed: readonly Placed[];
  readonly stood: readonly Standing[];
  readonly rates: readonly RateRow[];
  readonly currency: NetCurrency;
}) {
  const on = (side: Side) =>
    sumIn(
      totalsByCurrency(placed.filter((p) => sideOf(p.placement) === side).map((p) => p.account)),
      rates,
      currency,
    );
  const cash = on('cash');
  // Crypto holdings (ACCT-21) are investments, beside the brokerage's funds (`assetSide`).
  const investments = sumIn(
    combineTotals(
      totalsByCurrency(
        placed.filter((p) => sideOf(p.placement) === 'investments').map((p) => p.account),
      ),
      propertyTotals(onSide(stood, 'investments')),
    ),
    rates,
    currency,
  );
  const property = onSide(stood, 'property');
  const debt = on('debt');
  const unsided = placed.filter((p) => sideOf(p.placement) === null).length;
  const guessed = placed.filter((p) => p.placement.kind !== 'set' && sideOf(p.placement) !== null);
  return (
    <>
      <div className="tiles">
        <Tile side="cash" label="Cash" sum={cash} />
        <Tile side="investments" label="Investments" sum={investments} />
        {property.length > 0 && (
          <Tile
            side="property"
            label="Property"
            sum={sumIn(propertyTotals(property), rates, currency)}
          />
        )}
        <Tile side="debt" label="Debt owed" sum={debt} owed />
      </div>
      {(unsided > 0 || guessed.length > 0) && (
        <p className="muted small">
          {guessed.length > 0 &&
            `${guessed.length} of these ${guessed.length === 1 ? 'account is' : 'accounts are'} counted by a guess at ${guessed.length === 1 ? 'its' : 'their'} group. `}
          {unsided > 0 &&
            `${unsided} ${unsided === 1 ? 'account is' : 'accounts are'} in none of these until you say which group ${unsided === 1 ? 'it is' : 'they are'} in.`}
        </p>
      )}
    </>
  );
}

/**
 * Each tile wears its side's colour from the chart (UI-05), so the tiles are the chart's key
 * before the chart is on screen. The swatch sits beside the name, never in place of it.
 */
function Tile({
  side,
  label,
  sum,
  owed = false,
}: {
  readonly side: Side;
  readonly label: string;
  readonly sum: Sum;
  readonly owed?: boolean;
}) {
  return (
    <div className="tile">
      <div className="label">
        <i className={`swatch ${side}`} aria-hidden="true" />
        {label}
      </div>
      <div className="total">
        {sum.kind === 'summed'
          ? formatMinor(owed ? -sum.minor : sum.minor, sum.currency, LOCALE)
          : '—'}
      </div>
    </div>
  );
}

/* ─── the accounts, in their groups ─────────────────────────────────────────────────────── */

function Accounts({
  placed,
  holdings,
  bought,
  limits,
  rates,
  currency,
  now,
}: {
  readonly placed: readonly Placed[];
  /** Crypto she holds (ACCT-21), listed with the investments it counts toward. */
  readonly holdings: readonly Standing[];
  /** What each loan bought, by name (ACCT-06). */
  readonly bought: ReadonlyMap<string, readonly string[]>;
  readonly limits: ReadonlyMap<string, number | null>;
  readonly rates: readonly RateRow[];
  readonly currency: NetCurrency;
  readonly now: number;
}) {
  const waiting = placed.filter((p) => listedUnder(p.placement) === null);
  const row = (p: Placed) => (
    <Account
      key={p.account.id}
      placed={p}
      bought={bought.get(p.account.id) ?? []}
      limit={limits.get(p.account.id) ?? null}
      now={now}
    />
  );
  return (
    <div className="groups">
      {waiting.length > 0 && (
        <section className="group" aria-labelledby="group-waiting">
          <div className="group-head">
            <h2 id="group-waiting">
              <span>Which group?</span>
            </h2>
            <p className="muted small">
              Dinora cannot tell from {waiting.length === 1 ? 'this name' : 'these names'} alone.
              Open {waiting.length === 1 ? 'it' : 'one'} to choose.
            </p>
          </div>
          <ul className="accounts">{waiting.map(row)}</ul>
        </section>
      )}
      {GROUPS.map((group) => {
        const members = placed.filter((p) => listedUnder(p.placement) === group);
        const held = group === 'investment' ? holdings : [];
        if (members.length === 0 && held.length === 0) return null;
        const sum = sumIn(
          combineTotals(totalsByCurrency(members.map((p) => p.account)), propertyTotals(held)),
          rates,
          currency,
        );
        return (
          <section
            key={group}
            className={`group ${sideOf({ kind: 'set', group }) ?? ''}`}
            aria-labelledby={`group-${group}`}
          >
            <details>
              <summary className="group-head">
                <h2 id={`group-${group}`}>
                  <span>
                    {GROUP_NAMES[group]}{' '}
                    <span className="group-count">
                      {[
                        members.length === 0
                          ? ''
                          : members.length === 1
                            ? '1 account'
                            : `${members.length} accounts`,
                        held.length === 0
                          ? ''
                          : held.length === 1
                            ? '1 holding'
                            : `${held.length} holdings`,
                      ]
                        .filter((part) => part !== '')
                        .join(' and ')}
                    </span>
                  </span>
                  {sum.kind === 'summed' && (
                    <span className="group-total">
                      {formatMinor(sum.minor, sum.currency, LOCALE)}
                    </span>
                  )}
                </h2>
              </summary>
              <ul className="accounts">
                {members.map(row)}
                {held.map(asset)}
              </ul>
            </details>
          </section>
        );
      })}
    </div>
  );
}

function Account({
  placed,
  bought,
  limit,
  now,
}: {
  readonly placed: Placed;
  readonly bought: readonly string[];
  /** The credit limit she entered (ACCT-10), or null. */
  readonly limit: number | null;
  readonly now: number;
}) {
  const { account, placement } = placed;
  const stale = isStale(account.balance_at, now);
  const room = limit === null ? null : headroom(account.balance_minor, limit);
  return (
    <li>
      <div className="account">
        <span>
          <a href={accountHref(account.id)}>{account.name || 'Unnamed account'}</a>
          {placement.kind === 'likely' && <span className="guess"> Guess</span>}
        </span>
        <span className="muted small">
          {account.institution}
          {bought.length > 0 && ` · for ${bought.join(', ')}`}
        </span>
      </div>
      <div className="amount">
        {formatMinor(account.balance_minor, account.currency, LOCALE)}
        {room !== null && (
          <span className={room.availableMinor < 0 ? 'available error' : 'available muted'}>
            {formatMinor(room.availableMinor, account.currency, LOCALE)} available
          </span>
        )}
      </div>
      {/* The bank's own time, not the pull's: a bank the aggregator could not refresh keeps
          an old balance, and it must look old rather than borrow tonight's timestamp. */}
      <div className={stale ? 'age stale' : 'age muted'}>
        {stale ? 'Not updated since ' : 'As of '}
        <Age at={account.balance_at} now={now} />
      </div>
    </li>
  );
}

/* ─── what she owns ────────────────────────────────────────────────────────────────────── */

/**
 * Property (ACCT-06), after the accounts: each thing she owns at the value she set, how old
 * that value is, what it has gained since she bought it, and what she owns of it once the
 * loan it was bought with is taken off. A value past half a year is shown in the stale colour,
 * as a balance the bank stopped refreshing is.
 */
function Property({
  stood,
  rates,
  currency,
}: {
  readonly stood: readonly Standing[];
  readonly rates: readonly RateRow[];
  readonly currency: NetCurrency;
}) {
  const sum = sumIn(propertyTotals(stood), rates, currency);
  return (
    <section className="group property" aria-labelledby="group-property">
      {/* Open while it holds nothing: all it has then is how to add the first thing. */}
      <details open={stood.length === 0}>
        <summary className="group-head">
          <h2 id="group-property">
            <span>
              Property{' '}
              {stood.length > 0 && (
                <span className="group-count">
                  {stood.length === 1 ? '1 asset' : `${stood.length} assets`}
                </span>
              )}
            </span>
            {stood.length > 0 && sum.kind === 'summed' && (
              <span className="group-total">{formatMinor(sum.minor, sum.currency, LOCALE)}</span>
            )}
          </h2>
          {stood.length === 0 && (
            <p className="muted small">
              A home, a car, jewelry: what you own counts in net worth at the value you give it.
            </p>
          )}
        </summary>
        {stood.length > 0 && <ul className="accounts">{stood.map(asset)}</ul>}
        <p className="small">
          <a href={NEW_ASSET_HREF}>Add something you own</a>
        </p>
      </details>
    </section>
  );
}

/** Whose value it is, as the card's age line starts. */
function valuedBy(row: AssetValueRow): string {
  if (row.source === 'monarch') return 'Monarch’s value, ';
  if (row.provider === 'gemini') return 'At Gemini’s close, ';
  if (row.source === 'estimate' && row.provider !== null) {
    return `${PROVIDER_NAMES[row.provider]} estimate, `;
  }
  return 'Valued ';
}

function asset(standing: Standing) {
  const { asset: owned, current, estimate, stale, change, loan, ageDays } = standing;
  const money = (minor: number) => formatMinor(minor, owned.currency, LOCALE);
  const notes: string[] = [];
  // The market's guess beside hers, in the quiet line under it (ACCT-11, Nora 25 Sep).
  if (estimate !== null && current !== null && estimate.id !== current.id) {
    notes.push(`Estimated at ${money(estimate.amount_minor)}`);
  }
  if (change !== null && owned.acquired_on !== null) {
    const share = change.tenths === null ? '' : ` (${formatChange(change.tenths)})`;
    notes.push(
      `${change.minor >= 0 ? '+' : ''}${money(change.minor)}${share} since ${owned.acquired_on.slice(0, 4)}`,
    );
  }
  if (loan !== null) {
    notes.push(
      loan.equityMinor === null
        ? `${formatMinor(loan.owedMinor, loan.account.currency, LOCALE)} owed on ${loan.account.name}`
        : `${money(loan.equityMinor)} yours after ${loan.account.name}`,
    );
  }
  return (
    <li key={owned.id}>
      <div className="account">
        <span>
          <a href={assetHref(owned.id)}>{owned.name}</a>
        </span>
      </div>
      <div className="amount">
        {current === null ? <span className="muted">Not valued</span> : money(current.amount_minor)}
      </div>
      {/* On a line of their own, across the row: beside the value they squeeze the name into a
          column a word wide on a phone (measured at 390px, 25 Sep). */}
      {notes.length > 0 && <div className="note muted small">{notes.join(' · ')}</div>}
      <div className={stale ? 'age stale' : 'age muted'}>
        {current !== null &&
          ageDays !== null &&
          `${valuedBy(current)}${
            ageDays === 0 ? 'today' : `${ageDays} ${ageDays === 1 ? 'day' : 'days'} ago`
          }`}
      </div>
    </li>
  );
}

/* ─── this month's budget ─── */

/**
 * This month against its budget (BUD-01), under the goals: one line, and its title is the way
 * in. Nothing while the transactions are still being read, rather than a total that is short.
 * Not a fold, unlike the groups (Nora, 27 Sep): its header is already everything it says, so
 * folding it hid only the bar and the links, and the arrow promised rows that were never there.
 */
function BudgetCard({ month }: { readonly month: BudgetMonth | 'waiting' | 'failed' }) {
  const summary = typeof month === 'string' ? null : month.summary;
  const share =
    summary !== null && summary.spentMinor !== null && summary.budgetedMinor !== null
      ? spentShare(summary.spentMinor, summary.budgetedMinor)
      : null;
  return (
    <section className="group budget-card" aria-labelledby="group-budget">
      <div className="group-head">
        <h2 id="group-budget">
          <a href={BUDGET_HREF}>Budget</a>
        </h2>
        {summary !== null && (
          <p className="muted small">
            {describeMonth(summary.month, LOCALE)}: {monthLine(summary)}
          </p>
        )}
      </div>
      {share !== null && (
        <progress
          className={share > 1000 ? 'goal-bar over' : 'goal-bar'}
          max={1000}
          value={Math.min(share, 1000)}
          aria-label="Spent of this month’s budget"
        />
      )}
      {summary !== null && summary.unsorted.count > 0 && (
        <p className="small">
          <a href={categorizeHref()}>Categorize {summary.unsorted.count}</a>
        </p>
      )}
    </section>
  );
}

/* ─── goals ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Goals (GOAL-01), under the chart: each with its bar and one line saying when it gets there.
 * Open, unlike the groups: a goal is there to be seen each time the app opens, and a folded
 * card would hide the only thing it says.
 */
function Goals({
  along,
}: {
  readonly along: readonly { readonly goal: GoalRow; readonly progress: Progress }[];
}) {
  return (
    <section className="group" aria-labelledby="group-goals">
      <details open>
        <summary className="group-head">
          <h2 id="group-goals">
            <span>
              Goals{' '}
              {along.length > 0 && (
                <span className="group-count">
                  {along.length === 1 ? '1 goal' : `${along.length} goals`}
                </span>
              )}
            </span>
          </h2>
          {along.length === 0 && (
            <p className="muted small">
              Save toward a target, or pay a loan off, and see how far along it is.
            </p>
          )}
        </summary>
        {along.length > 0 && <ul className="accounts">{along.map(goalRow)}</ul>}
        <p className="small">
          <a href={NEW_GOAL_HREF}>Add a goal</a>
        </p>
      </details>
    </section>
  );
}

function goalRow({ goal, progress }: { readonly goal: GoalRow; readonly progress: Progress }) {
  const money = (minor: bigint) => formatMinor(minor, goal.currency, LOCALE);
  return (
    <li key={goal.id}>
      <div className="account">
        <span>
          <a href={goalHref(goal.id)}>{goal.name}</a>
        </span>
      </div>
      <div className="amount">
        {progress.kind === 'save' && (
          <>
            {money(progress.balanceMinor)}
            <span className="available muted">of {money(progress.targetMinor)}</span>
          </>
        )}
        {progress.kind === 'payoff' && (
          <>
            {money(progress.owedMinor)}
            <span className="available muted">owed</span>
          </>
        )}
      </div>
      {(progress.kind === 'save' || progress.kind === 'payoff') && progress.tenths !== null && (
        <div className="note">
          <GoalBar tenths={progress.tenths} label={goal.name} />
        </div>
      )}
      <div className="note muted small">{shortLine(progress)}</div>
    </li>
  );
}

/* ─── how fresh it all is ───────────────────────────────────────────────────────────────── */

/**
 * One line while there is one source, as before Plaid; with two, each is named, since each
 * is read and fails on its own (BANK-07). The detail is counts, status codes and the
 * aggregator's own complaints, never an amount or a payee (bank_pulls, invariant 4), so it is
 * shown as it was written.
 */
function LastPull({
  reads,
  now,
  online,
  accounts,
}: {
  readonly reads: readonly SourceRead[];
  readonly now: number;
  readonly online: boolean;
  readonly accounts: readonly AccountRow[];
}) {
  const [only, ...others] = reads;
  if (others.length === 0) {
    const read: LastRead = only?.read ?? { kind: 'never', failed: null };
    return (
      <>
        <p className="muted small">
          {read.kind === 'read' ? (
            <>
              Banks last read <Age at={read.at} now={now} />.
            </>
          ) : (
            'The banks have not been read yet.'
          )}
        </p>
        {read.failed !== null && (
          <p className="error" role="alert">
            The read <Age at={read.failed.at} now={now} /> failed
            {read.failed.detail === '' ? '.' : `: ${read.failed.detail}`}
          </p>
        )}
        {only !== undefined && <Fix read={only} where="failure" online={online} />}
        {only !== undefined && only.read.kind === 'read' && (
          <Warnings
            name={sourceName(only.source)}
            warnings={only.read.warnings}
            accounts={accounts}
          />
        )}
        {only !== undefined && <Fix read={only} where="warning" online={online} />}
      </>
    );
  }
  return (
    <>
      <p className="muted small">
        Banks last read:{' '}
        {reads.map(({ source, read }, i) => (
          <Fragment key={source}>
            {i > 0 && ', '}
            {sourceName(source)} {read.kind === 'read' ? <Age at={read.at} now={now} /> : 'not yet'}
          </Fragment>
        ))}
        .
      </p>
      {reads.map(
        ({ source, read }) =>
          read.failed !== null && (
            <Fragment key={source}>
              <p className="error" role="alert">
                The {sourceName(source)} read <Age at={read.failed.at} now={now} /> failed
                {read.failed.detail === '' ? '.' : `: ${read.failed.detail}`}
              </p>
              <Fix read={{ source, read }} where="failure" online={online} />
            </Fragment>
          ),
      )}
      {reads.map(
        ({ source, read }) =>
          read.kind === 'read' && (
            <Fragment key={source}>
              <Warnings name={sourceName(source)} warnings={read.warnings} accounts={accounts} />
              <Fix read={{ source, read }} where="warning" online={online} />
            </Fragment>
          ),
      )}
    </>
  );
}

/**
 * The fix for a bank that wants signing in, under where it was said. A Plaid bank is signed in
 * from here (BANK-12). A SimpleFIN bank is signed in at the Bridge, which holds its login and
 * Dinora never does (invariant 5), so that is a link to the Bridge (BANK-13).
 */
function Fix({
  read,
  where,
  online,
}: {
  readonly read: SourceRead;
  readonly where: 'failure' | 'warning';
  readonly online: boolean;
}) {
  if (fixable(read) !== where) return null;
  return read.source === 'plaid' ? <SignInAgain online={online} /> : <SignInAtBridge />;
}

function SignInAtBridge() {
  return (
    <div className="sign-in-again">
      <a className="button-link" href={BRIDGE_HOME} target="_blank" rel="noopener noreferrer">
        Sign in again at SimpleFIN
      </a>
      <p className="muted small">
        SimpleFIN keeps the bank's sign-in, so it is fixed on SimpleFIN's page. The next nightly
        read picks it up.
      </p>
    </div>
  );
}

/**
 * Where a bank wanting signing in was said, which is where the app offers to fix it, or null.
 * Usually a warning: since BANK-10 a Plaid read keeps the other banks and only names this one,
 * and SimpleFIN's always did. A failure when every Plaid bank wanted it, and that failure is
 * newer news than any warning; a SimpleFIN failure is the Bridge's, never one bank's.
 */
function fixable({ source, read }: SourceRead): 'failure' | 'warning' | null {
  if (source === 'plaid' && read.failed !== null && wantsSignIn(read.failed.detail))
    return 'failure';
  if (read.kind === 'read' && read.warnings.some(wantsSignIn)) return 'warning';
  return null;
}

/**
 * What a read that worked still complained of — most often a bank that wants signing in
 * again (BANK-09). Amber, not red: the read did not fail, but an account in it has stopped
 * moving, and only a person can fix that. Each names its bank, and under it are that bank's
 * accounts, each opening its own page, so finding them is a tap and not a scroll through the
 * groups (`warnedAccounts`).
 */
function Warnings({
  name,
  warnings,
  accounts,
}: {
  readonly name: string;
  readonly warnings: readonly string[];
  readonly accounts: readonly AccountRow[];
}) {
  if (warnings.length === 0) return null;
  return (
    <div className="warning small">
      <p>
        {name}'s last read came with{' '}
        {warnings.length === 1 ? 'a warning' : `${warnings.length} warnings`}:
      </p>
      <ul>
        {warnings.map((w) => {
          const warned = warnedAccounts(w, accounts);
          return (
            <li key={w}>
              {w}
              {warned.length > 0 && (
                <ul className="warned">
                  {warned.map((a) => (
                    <li key={a.id}>
                      <a href={accountHref(a.id)}>{a.name || 'Unnamed account'}</a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * An account a bank started reading after Monarch's history of it was imported, counted twice
 * until the two are put together (BANK-15). Amber, beside the read's warnings: nothing failed,
 * but the totals under it are wrong, and only she can say the two are one. Each name opens its
 * account, and under them she puts the two together, confirmed first (BANK-17).
 */
function Doubles({
  doubles,
  goals,
  goalLinks,
  online,
}: {
  readonly doubles: readonly Double[];
  readonly goals: readonly GoalRow[];
  readonly goalLinks: readonly GoalAccountRow[];
  readonly online: boolean;
}) {
  if (doubles.length === 0) return null;
  const one = doubles.length === 1;
  return (
    <div className="warning small">
      <p>
        {one
          ? 'This account may be counted twice: a bank now reads it, and Monarch’s history of it is still an account of its own.'
          : 'These accounts may be counted twice: a bank now reads each, and Monarch’s history of it is still an account of its own.'}
      </p>
      <ul>
        {doubles.map((pair) => (
          <li key={`${pair.monarch.id} ${pair.bank.id}`}>
            <a href={accountHref(pair.monarch.id)}>{pair.monarch.name}</a> from Monarch, and{' '}
            <a href={accountHref(pair.bank.id)}>{pair.bank.name || 'Unnamed account'}</a> from{' '}
            {pair.bank.institution || sourceName(pair.bank.source)}.
            <PutTogether
              pair={pair}
              goals={goalsCounting(pair.monarch.id, goals, goalLinks)}
              online={online}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
