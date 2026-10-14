import type { AssetKind, AssetRow, AssetValueRow, Standing } from '@dinora/core/assets';
import {
  ASSET_KINDS,
  changeOver,
  formatChange,
  standOf,
  VALUE_STALE_DAYS,
} from '@dinora/core/assets';
import type { AccountRow } from '@dinora/core/balances';
import { formatMinor } from '@dinora/core/balances';
import type { HoldingWorth } from '@dinora/core/crypto';
import {
  coinOf,
  CRYPTO_CURRENCY,
  formatQuantity,
  holdingWorth,
  quantityOf,
  sameQuantity,
} from '@dinora/core/crypto';
import { PROVIDER_NAMES } from '@dinora/core/estimates';
import type { Placed } from '@dinora/core/groups';
import type { Metal, MetalWorth, Piece } from '@dinora/core/metals';
import {
  describeFineness,
  FINENESS,
  formatGrams,
  formatPrice,
  metalWorth,
  METALS,
  milligramsOf,
} from '@dinora/core/metals';
import { placeAccounts, sideOf } from '@dinora/core/groups';
import { describeDay } from '@dinora/core/networth';
import { parseLimit } from '@dinora/core/terms';
import { useQueryClient } from '@tanstack/react-query';
import type { FormEvent, ReactNode } from 'react';
import { useState } from 'react';

import type { Problem } from './controls.tsx';
import {
  Actions,
  amountDraft,
  currencyAffix,
  errorFor,
  Field,
  formError,
  Segmented,
} from './controls.tsx';
import { useOnline } from './device/useOnline.ts';
import type { AssetDetails as Details } from './queries/assets.ts';
import {
  addAsset,
  addValue,
  ASSET_VALUES,
  ASSETS,
  CRYPTO_PRICES,
  METAL_PRICES,
  removeAsset,
  removeValue,
  updateAsset,
} from './queries/assets.ts';
import { ACCOUNTS } from './queries/balances.ts';
import { ACCOUNT_GROUPS } from './queries/groups.ts';
import { useSynced } from './queries/synced.ts';
import { assetHref, DASHBOARD_HREF } from './route.ts';
import { DangerZone, Sheet } from './sheet.tsx';
import { localDay, LOCALE, useNow } from './time.tsx';
import { notDone } from './queries/writes.ts';

const METAL_NAMES: Readonly<Record<Metal, string>> = { gold: 'gold', silver: 'silver' };

const KIND_NAMES: Readonly<Record<AssetKind, string>> = {
  home: 'Home',
  vehicle: 'Vehicle',
  valuables: 'Valuables',
  crypto: 'Crypto',
};

/** Dollars, and euros for something in Spain: the two currencies Dinora is for. */
const CURRENCIES = ['USD', 'EUR'] as const;

/**
 * One thing Nora owns (ACCT-06): what it is worth, how old that value is, what it has gained
 * since she bought it, and what she owns of it once its loan is taken off. Each value she sets
 * is kept, like a card's terms (ACCT-10), so the chart can draw its past. Edits are off with
 * no signal (PLAT-02).
 */
export function AssetDetails({
  assetId,
  userId,
}: {
  readonly assetId: string;
  readonly userId: string;
}) {
  const assets = useSynced(ASSETS);
  const values = useSynced(ASSET_VALUES);
  const accounts = useSynced(ACCOUNTS);
  const groups = useSynced(ACCOUNT_GROUPS);
  const prices = useSynced(METAL_PRICES);
  const closes = useSynced(CRYPTO_PRICES);
  const online = useOnline();
  const now = useNow();
  const [sheet, setSheet] = useState<'value' | 'details' | 'values' | null>(null);
  const close = () => setSheet(null);

  if (assets.status === 'waiting') return <section aria-busy="true" />;
  const asset =
    assets.status === 'held'
      ? assets.rows.find((row) => row.id === assetId && row.deleted_at === null)
      : undefined;
  if (asset === undefined) {
    return (
      <section className="details">
        <Back />
        <p className="muted">
          {assets.status === 'failed'
            ? 'Dinora could not be reached, and this device has nothing you own saved from before.'
            : 'This is not in Dinora.'}
        </p>
      </section>
    );
  }

  const today = localDay(now);
  const heldAccounts = accounts.status === 'held' ? accounts.rows : [];
  const standing = standOf(asset, values.status === 'held' ? values.rows : [], heldAccounts, today);
  const loans = loanChoices(
    placeAccounts(heldAccounts, groups.status === 'held' ? groups.rows : []),
    asset.financed_by,
  );
  const worth = metalWorth(asset, prices.status === 'held' ? prices.rows : []);
  const held = holdingWorth(asset, closes.status === 'held' ? closes.rows : []);

  return (
    <section className="details" aria-labelledby="asset-title">
      <Back />
      <h2 id="asset-title">{asset.name}</h2>
      <p className="muted small">{KIND_NAMES[asset.kind]}</p>
      <Worth standing={standing} />
      <p>
        <button
          type="button"
          className="secondary small-action"
          disabled={!online}
          onClick={() => setSheet('value')}
        >
          Add a value
        </button>
      </p>
      {!online && (
        <p className="muted small">Changes can be made when this device is back online.</p>
      )}
      <Estimate standing={standing} />
      {worth !== null && <MetalFigures asset={asset} worth={worth} />}
      {held !== null && <HoldingFigures standing={standing} held={held} />}
      <Facts asset={asset} loans={loans} online={online} onEdit={() => setSheet('details')} />
      <Values
        rows={standing.history}
        currency={asset.currency}
        coin={asset.coin}
        online={online}
        onAll={() => setSheet('values')}
      />

      <Sheet title="Add a value" open={sheet === 'value'} onClose={close}>
        <AddValue asset={asset} today={today} online={online} userId={userId} onDone={close} />
      </Sheet>
      <Sheet title={`Edit ${asset.name}`} open={sheet === 'details'} onClose={close}>
        <EditDetails asset={asset} loans={loans} online={online} onDone={close} />
        <Remove asset={asset} online={online} />
      </Sheet>
      <Sheet title="Values" open={sheet === 'values'} onClose={close}>
        <ValueList
          rows={standing.history}
          currency={asset.currency}
          coin={asset.coin}
          online={online}
        />
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
 * The accounts an asset can be bought with: every debt, set or guessed, and whatever it names
 * now, so a loan she has since regrouped is not dropped from the choice silently.
 */
function loanChoices(placed: readonly Placed[], current: string | null): AccountRow[] {
  return placed
    .filter((p) => sideOf(p.placement) === 'debt' || p.account.id === current)
    .map((p) => p.account);
}

/* ─── what it is worth ──────────────────────────────────────────────────────────────────── */

/** Whose figure a value is, as the page says it. */
function sourceOf(row: AssetValueRow): string {
  if (row.source === 'monarch') return 'Monarch’s value';
  if (row.provider === 'lbma') return 'Its metal at the LBMA’s price';
  if (row.provider === 'gemini') return 'At Gemini’s close';
  if (row.source === 'estimate' && row.provider !== null) {
    return `${PROVIDER_NAMES[row.provider]}’s estimate`;
  }
  return 'Your value';
}

function Worth({ standing }: { readonly standing: Standing }) {
  const { asset, current, ageDays, stale, change, loan } = standing;
  const money = (minor: number) => formatMinor(minor, asset.currency, LOCALE);
  if (current === null || ageDays === null) {
    return (
      <p className="muted">
        {asset.kind === 'crypto'
          ? 'Not valued yet. It is valued at Gemini’s close each night, and counts in net worth from then.'
          : 'Not valued yet. Add a value and it counts in net worth.'}
      </p>
    );
  }
  return (
    <>
      <div className="hero-value">{money(current.amount_minor)}</div>
      <p className={stale ? 'age stale small' : 'age muted small'}>
        {sourceOf(current)} from <Day on={current.valued_on} />
        {stale && `, over ${VALUE_STALE_DAYS} days ago. Is it still worth this?`}
      </p>
      <dl className="figures">
        {/* A floor against a price that paid for the work too would read as a loss on any
            piece of jewelry; what its metal has done is `MetalFigures`. */}
        {change !== null &&
          current.provider !== 'lbma' &&
          asset.acquired_on !== null &&
          asset.cost_minor !== null && (
            <div className="figure">
              <dt className="label">Since you bought it</dt>
              <dd>
                <span className="figure-value">
                  {change.minor >= 0 ? '+' : ''}
                  {money(change.minor)}
                </span>
                {change.tenths !== null && ` ${formatChange(change.tenths)}`}
                <p className="muted small">
                  Bought for {money(asset.cost_minor)} on <Day on={asset.acquired_on} />
                </p>
              </dd>
            </div>
          )}
        {loan !== null && (
          <div className="figure">
            <dt className="label">Yours, after the loan</dt>
            <dd>
              {loan.equityMinor === null ? (
                <span className="muted">
                  Not worked out: the loan is in {loan.account.currency}
                </span>
              ) : (
                <span className="figure-value">{money(loan.equityMinor)}</span>
              )}
              <p className="muted small">
                {formatMinor(loan.owedMinor, loan.account.currency, LOCALE)} still owed on{' '}
                {loan.account.name}
              </p>
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

/**
 * The market's guess (ACCT-11), beside hers and quieter than it: decided by Nora 25 Sep, a
 * value she entered counts and the estimate is shown near it. With nothing of hers to outrank
 * it, it is the value above, and this says what kind of figure that is.
 */
function Estimate({ standing }: { readonly standing: Standing }) {
  const { asset, current, estimate } = standing;
  if (estimate === null || estimate.provider === null) return null;
  const money = (minor: number) => formatMinor(minor, asset.currency, LOCALE);
  const counted = current?.id === estimate.id;
  // A holding's close (ACCT-21) is no guess: it is what the market paid for the coin that day.
  // Counted, `HoldingFigures` says what it was worked out from; outranked, it is said here.
  if (estimate.provider === 'gemini') {
    return counted ? null : (
      <p className="estimate muted small">
        At Gemini’s close on <Day on={estimate.valued_on} /> it was worth{' '}
        <span className="estimate-value">{money(estimate.amount_minor)}</span>. Yours is the one
        that counts.
      </p>
    );
  }
  // A piece's metal (ACCT-12) is not the market's guess at the piece: it is the least it is
  // worth, since the work in it is priced in when it is sold.
  if (estimate.provider === 'lbma') {
    return (
      <p className="estimate muted small">
        {counted ? (
          <>The metal alone: a floor, since what it was made into is worth more. </>
        ) : (
          <>
            Its metal alone is worth{' '}
            <span className="estimate-value">{money(estimate.amount_minor)}</span> at the LBMA’s
            price on <Day on={estimate.valued_on} />.{' '}
          </>
        )}
        {counted ? 'A value you set counts instead.' : 'Yours is the one that counts.'}
      </p>
    );
  }
  const range =
    estimate.low_minor === null || estimate.high_minor === null
      ? ''
      : ` between ${money(estimate.low_minor)} and ${money(estimate.high_minor)}`;
  return (
    <p className="estimate muted small">
      {counted ? (
        <>A market estimate{range === '' ? '' : `, somewhere${range}`}. </>
      ) : (
        <>
          {PROVIDER_NAMES[estimate.provider]} estimates{' '}
          <span className="estimate-value">{money(estimate.amount_minor)}</span>
          {range === '' ? '' : `,${range}`}, on <Day on={estimate.valued_on} />.{' '}
        </>
      )}
      {estimate.provider === 'marketcheck' &&
        'That is a dealer’s retail price: a private sale or a trade-in would bring less. '}
      {counted ? 'A value you set counts instead.' : 'Yours is the one that counts.'}
    </p>
  );
}

/**
 * What a piece of gold or silver is, and what its metal has done since she bought it
 * (ACCT-12): the gain Nora asked to see, "gold has gone up a lot since then". The metal's own
 * change, from the LBMA's price the day she bought it to the newest, whatever the work was
 * worth; worked out from the weight as it stands, so a corrected weight corrects it at once.
 */
function MetalFigures({ asset, worth }: { readonly asset: AssetRow; readonly worth: MetalWorth }) {
  const money = (minor: number) => formatMinor(minor, asset.currency, LOCALE);
  const perOunce = (price: string) => formatPrice(price, asset.currency, LOCALE);
  const { piece, now, then } = worth;
  const what = `${formatGrams(piece.mg, LOCALE)} of ${describeFineness(piece.metal, piece.fineness).toLowerCase()} ${METAL_NAMES[piece.metal]}`;
  if (now === null) {
    return (
      <p className="muted small">
        {what}. Its value arrives with the LBMA’s next price, read each night.
      </p>
    );
  }
  const change = then === null ? null : changeOver(now.minor, then.minor);
  return (
    <dl className="figures">
      <div className="figure">
        <dt className="label">Its {METAL_NAMES[piece.metal]} since you bought it</dt>
        <dd>
          {change === null || then === null ? (
            <span className="muted">
              {asset.acquired_on === null
                ? 'Say when you bought it to see this.'
                : 'Worked out once the prices back to then are read, tonight.'}
            </span>
          ) : (
            <>
              <span className="figure-value">
                {change.minor >= 0 ? '+' : ''}
                {money(change.minor)}
              </span>
              {change.tenths !== null && ` ${formatChange(change.tenths)}`}
            </>
          )}
          <p className="muted small">
            {what}:{' '}
            {then !== null && (
              <>
                {money(then.minor)} at {perOunce(then.price.price)} an ounce on{' '}
                <Day on={then.price.price_date} />,{' '}
              </>
            )}
            {money(now.minor)} at {perOunce(now.price.price)} on <Day on={now.price.price_date} />
          </p>
        </dd>
      </div>
    </dl>
  );
}

/**
 * What she holds and what it is worth at Gemini's newest close (ACCT-21), with the close and
 * its day: the figure is only as good as the price it used, so the price is said beside it.
 * Worked out from the quantity as it stands, so a quantity she has just changed shows at once;
 * the value that counts is the night's, and says which quantity it counted when that differs.
 */
function HoldingFigures({
  standing,
  held,
}: {
  readonly standing: Standing;
  readonly held: HoldingWorth;
}) {
  const { asset, current } = standing;
  const what = formatQuantity(held.quantity, held.coin, LOCALE);
  if (held.now === null) {
    return (
      <p className="muted small">
        {what}. Its value arrives with Gemini’s next daily close, read each night. If none has
        arrived by the morning after, Gemini does not price {held.coin} in dollars: check the coin
        under What it is.
      </p>
    );
  }
  const counted = current?.provider === 'gemini' ? current.coin_quantity : null;
  return (
    <dl className="figures">
      <div className="figure">
        <dt className="label">What you hold</dt>
        <dd>
          <span className="figure-value">{what}</span>
          <p className="muted small">
            {formatMinor(held.now.minor, asset.currency, LOCALE)} at{' '}
            {formatPrice(held.now.price.price, asset.currency, LOCALE)} a coin, Gemini’s close on{' '}
            <Day on={held.now.price.price_date} />
          </p>
          {counted !== null && !sameQuantity(counted, held.quantity) && (
            <p className="muted small">
              The value above counts {formatQuantity(counted, held.coin, LOCALE)}. The new quantity
              counts from the next close, valued tonight.
            </p>
          )}
        </dd>
      </div>
    </dl>
  );
}

/* ─── a new value ───────────────────────────────────────────────────────────────────────── */

function AddValue({
  asset,
  today,
  online,
  userId,
  onDone,
}: {
  readonly asset: AssetRow;
  readonly today: string;
  readonly online: boolean;
  readonly userId: string;
  /** Saved or cancelled: the sheet closes, and the page shows the new value. */
  readonly onDone: () => void;
}) {
  const client = useQueryClient();
  const [amount, setAmount] = useState('');
  const [valuedOn, setValuedOn] = useState(today);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem<AssetField> | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amountMinor = parseLimit(amount, asset.currency);
    if (amountMinor === null) {
      setProblem({ field: 'amount', message: 'Enter the value as a number, like 425,000.' });
      return;
    }
    if (valuedOn === '' || valuedOn > today) {
      setProblem({ field: 'valuedOn', message: 'Say the day it was worth this, today or before.' });
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await addValue(userId, asset.id, { valuedOn, amountMinor });
      await client.invalidateQueries({ queryKey: ASSET_VALUES.queryKey });
      onDone();
    } catch (error) {
      setProblem({ field: null, message: notDone(error, 'saved') });
      setSaving(false);
    }
  };

  const off = !online || saving;
  return (
    <form className="add-figure" onSubmit={(event) => void submit(event)}>
      {!online && <p className="muted small">Values can be set when this device is back online.</p>}
      <div className="fields">
        <Field label="Worth" error={errorFor(problem, 'amount')} {...currencyAffix(asset.currency)}>
          {(control) => (
            <input
              {...control}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              placeholder="425,000"
              disabled={off}
              onChange={(event) => {
                setAmount(event.currentTarget.value);
                setProblem(null);
              }}
            />
          )}
        </Field>
        <Field label="On" error={errorFor(problem, 'valuedOn')}>
          {(control) => (
            <input
              {...control}
              type="date"
              value={valuedOn}
              max={today}
              disabled={off}
              onChange={(event) => {
                setValuedOn(event.currentTarget.value);
                setProblem(null);
              }}
            />
          )}
        </Field>
      </div>
      <Actions problem={formError(problem)}>
        <button type="submit" disabled={off}>
          {saving ? 'Adding…' : 'Add value'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </Actions>
    </form>
  );
}

/* ─── every value it has had ────────────────────────────────────────────────────────────── */

/** Every value of hers and Monarch's, and only the newest estimate from each source: a metal is
 * valued every business day (ACCT-12), and a list of 250 a year would bury hers. */
function listed(rows: readonly AssetValueRow[]): readonly AssetValueRow[] {
  return rows.filter(
    (row, i) =>
      row.source !== 'estimate' ||
      rows.findIndex((r) => r.source === 'estimate' && r.provider === row.provider) === i,
  );
}

/** How many a page shows before the rest are a tap away (UI-03): the home had about 80. */
const VALUES_SHOWN = 5;

function Values({
  rows,
  currency,
  coin,
  online,
  onAll,
}: {
  readonly rows: readonly AssetValueRow[];
  readonly currency: string;
  readonly coin: string | null;
  readonly online: boolean;
  readonly onAll: () => void;
}) {
  if (rows.length === 0) return null;
  const shown = listed(rows);
  return (
    <section className="term-history" aria-labelledby="values-title">
      <div className="section-head">
        <h3 id="values-title">Values</h3>
        <button
          type="button"
          className="quiet"
          disabled={!online && shown.length <= VALUES_SHOWN}
          onClick={onAll}
        >
          {shown.length > VALUES_SHOWN ? `All ${shown.length}` : 'Remove one'}
        </button>
      </div>
      <ul>
        {shown.slice(0, VALUES_SHOWN).map((row) => (
          <li key={row.id}>
            <ValueText row={row} currency={currency} coin={coin} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every value, each with a way to take it back: the sheet the page's list opens. */
function ValueList({
  rows,
  currency,
  coin,
  online,
}: {
  readonly rows: readonly AssetValueRow[];
  readonly currency: string;
  readonly coin: string | null;
  readonly online: boolean;
}) {
  const shown = listed(rows);
  const earlier = rows.length - shown.length;
  return (
    <div className="term-history bare">
      {!online && (
        <p className="muted small">Values can be removed when this device is back online.</p>
      )}
      <ul>
        {shown.map((row) => (
          <ValueRow key={row.id} row={row} currency={currency} coin={coin} online={online} />
        ))}
      </ul>
      {/* It said "and drawn in the chart", of a page with no chart (UI-09, 26 Sep). */}
      {earlier > 0 && (
        <p className="muted small">
          {earlier === 1 ? 'An earlier estimate is' : `${earlier} earlier estimates are`} kept too.
        </p>
      )}
    </div>
  );
}

/** Whose a listed value is; a close says the quantity it counted, which may since have changed. */
function whoseValue(row: AssetValueRow, coin: string | null): string {
  if (row.source === 'monarch') return ', from Monarch';
  if (row.source !== 'estimate' || row.provider === null) return '';
  if (row.provider === 'gemini' && row.coin_quantity !== null && coin !== null) {
    return `, ${formatQuantity(row.coin_quantity, coin, LOCALE)} at Gemini’s close`;
  }
  return `, ${PROVIDER_NAMES[row.provider]}’s estimate`;
}

function ValueText({
  row,
  currency,
  coin,
}: {
  readonly row: AssetValueRow;
  readonly currency: string;
  readonly coin: string | null;
}) {
  return (
    <span>
      {formatMinor(row.amount_minor, currency, LOCALE)}{' '}
      <span className="muted small">
        on <Day on={row.valued_on} />
        {whoseValue(row, coin)}
      </span>
    </span>
  );
}

/** Two steps to take one back, as for a card's figures; kept in the table all the same. */
function ValueRow({
  row,
  currency,
  coin,
  online,
}: {
  readonly row: AssetValueRow;
  readonly currency: string;
  readonly coin: string | null;
  readonly online: boolean;
}) {
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await removeValue(row.id);
      await client.invalidateQueries({ queryKey: ASSET_VALUES.queryKey });
    } catch (error) {
      setFailed(notDone(error, 'removed'));
      setBusy(false);
    }
  };

  const what = formatMinor(row.amount_minor, currency, LOCALE);
  return (
    <li>
      <span>
        {what}{' '}
        <span className="muted small">
          on <Day on={row.valued_on} />
          {whoseValue(row, coin)}
        </span>
      </span>
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

/* ─── what it is ────────────────────────────────────────────────────────────────────────── */

/**
 * What it is, as facts to read (UI-03). They were an open form, filled in, under a paragraph
 * saying what every field was for; changing them is now a sheet the Edit button opens. A fact
 * she has not given says so, since what it would show (a gain, the part of it hers) is missing
 * until she does.
 */
/**
 * A crypto holding's one fact is what it holds (ACCT-21). Rewards paid by a card were bought
 * on no one day, for nothing and with no loan, so those facts are not asked for.
 */
function holdingFacts(asset: AssetRow): { readonly name: string; readonly value: ReactNode }[] {
  return [
    {
      name: 'Holding',
      value:
        asset.coin === null || asset.coin_quantity === null ? (
          <span className="muted">Not given</span>
        ) : (
          formatQuantity(asset.coin_quantity, asset.coin, LOCALE)
        ),
    },
  ];
}

function Facts({
  asset,
  loans,
  online,
  onEdit,
}: {
  readonly asset: AssetRow;
  readonly loans: readonly AccountRow[];
  readonly online: boolean;
  readonly onEdit: () => void;
}) {
  const money = (minor: number) => formatMinor(minor, asset.currency, LOCALE);
  const loan = loans.find((account) => account.id === asset.financed_by);
  const unset = <span className="muted">Not given</span>;
  const facts: { readonly name: string; readonly value: ReactNode }[] =
    asset.kind === 'crypto'
      ? holdingFacts(asset)
      : [
          {
            name: 'Bought',
            value:
              asset.acquired_on === null ? (
                unset
              ) : (
                <>
                  <Day on={asset.acquired_on} />
                  {asset.cost_minor !== null && ` for ${money(asset.cost_minor)}`}
                </>
              ),
          },
          {
            name: 'Bought with',
            value:
              asset.financed_by === null
                ? 'No loan'
                : loan === undefined
                  ? 'A loan no longer linked'
                  : `${loan.name || 'Unnamed account'} · ${loan.institution}`,
          },
        ];
  if (asset.kind === 'home') facts.push({ name: 'Address', value: asset.address ?? unset });
  if (asset.kind === 'vehicle') {
    facts.push(
      { name: 'VIN', value: asset.vin ?? unset },
      { name: 'ZIP code', value: asset.postal_code ?? unset },
      {
        name: 'Mileage',
        value:
          asset.odometer_miles === null ? (
            unset
          ) : (
            <>
              {asset.odometer_miles.toLocaleString(LOCALE)} mi
              {asset.odometer_on !== null && (
                <span className="muted small">
                  {' '}
                  as of <Day on={asset.odometer_on} />
                </span>
              )}
            </>
          ),
      },
    );
  }
  if (asset.kind === 'valuables') {
    facts.push({
      name: 'Metal',
      value:
        asset.metal === null || asset.metal_mg === null || asset.fineness === null
          ? 'Not gold or silver'
          : `${formatGrams(asset.metal_mg, LOCALE)} of ${describeFineness(asset.metal, asset.fineness).toLowerCase()} ${METAL_NAMES[asset.metal]}`,
    });
  }
  return (
    <section className="terms" aria-labelledby="facts-title">
      <div className="section-head">
        <h3 id="facts-title">What it is</h3>
        <button
          type="button"
          className="secondary small-action"
          disabled={!online}
          onClick={onEdit}
        >
          Edit
        </button>
      </div>
      <dl className="figures">
        {facts.map((fact) => (
          <div key={fact.name} className="figure">
            <dt className="label">{fact.name}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

type Draft = {
  name: string;
  kind: AssetKind;
  acquiredOn: string;
  cost: string;
  financedBy: string;
  address: string;
  postalCode: string;
  vin: string;
  miles: string;
  metal: Metal | '';
  weight: string;
  unit: 'g' | 'ozt';
  fineness: string;
  coin: string;
  quantity: string;
};

function draftOf(asset: AssetRow | null): Draft {
  return {
    name: asset?.name ?? '',
    kind: asset?.kind ?? 'home',
    acquiredOn: asset?.acquired_on ?? '',
    cost:
      asset === null || asset.cost_minor === null
        ? ''
        : amountDraft(asset.cost_minor, asset.currency),
    financedBy: asset?.financed_by ?? '',
    address: asset?.address ?? '',
    postalCode: asset?.postal_code ?? '',
    vin: asset?.vin ?? '',
    miles: asset === null || asset.odometer_miles === null ? '' : String(asset.odometer_miles),
    metal: asset?.metal ?? '',
    // Grams to the milligram it is stored in: at most three places, so it reads back exactly.
    weight: asset === null || asset.metal_mg === null ? '' : String(asset.metal_mg / 1000),
    unit: 'g',
    fineness: asset === null || asset.fineness === null ? '' : String(asset.fineness),
    coin: asset?.coin ?? '',
    quantity: asset?.coin_quantity ?? '',
  };
}

export type AssetField =
  | 'name'
  | 'acquiredOn'
  | 'cost'
  | 'address'
  | 'vin'
  | 'postalCode'
  | 'miles'
  | 'weight'
  | 'fineness'
  | 'coin'
  | 'quantity'
  | 'amount'
  | 'valuedOn';

const wrong = (field: AssetField, message: string) =>
  ({ ok: false, problem: { field, message } }) as const;

/** A VIN is 17 characters and never I, O or Q, as `assets_vin_shape` insists. */
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * The draft as what to save, or what is wrong with it in words she can act on. `before` is the
 * asset as saved: a mileage she has not changed keeps the day it was read, and one she has
 * is dated today.
 */
export function readDetails(
  draft: Draft,
  currency: string,
  today: string,
  before: AssetRow | null = null,
): { ok: true; details: Details } | { ok: false; problem: Problem<AssetField> } {
  const name = draft.name.trim();
  if (name === '' || name.length > 200) return wrong('name', 'Give it a name.');
  if (draft.kind === 'crypto') {
    const holding = readHolding(draft, currency);
    if (!holding.ok) return holding;
    // Its purchase is not asked for (`holdingFacts`), so none is kept from a kind it was before.
    return {
      ok: true,
      details: {
        name,
        kind: draft.kind,
        acquiredOn: null,
        costMinor: null,
        financedBy: null,
        address: null,
        postalCode: null,
        vin: null,
        odometer: null,
        piece: null,
        holding: holding.holding,
      },
    };
  }
  const acquiredOn = draft.acquiredOn === '' ? null : draft.acquiredOn;
  if (acquiredOn !== null && acquiredOn > today) {
    return wrong('acquiredOn', 'The day you bought it has to be today or before.');
  }
  let costMinor: number | null = null;
  if (draft.cost.trim() !== '') {
    costMinor = parseLimit(draft.cost, currency);
    if (costMinor === null) return wrong('cost', 'Enter what it cost as a number.');
    if (acquiredOn === null) {
      return wrong('acquiredOn', 'Say when you bought it, so the cost can show what it gained.');
    }
  }
  const lookup = readLookup(draft, today, before);
  if (!lookup.ok) return lookup;
  return {
    ok: true,
    details: {
      name,
      kind: draft.kind,
      acquiredOn,
      costMinor,
      financedBy: draft.financedBy === '' ? null : draft.financedBy,
      ...lookup.lookup,
    },
  };
}

type Lookup = Pick<Details, 'address' | 'postalCode' | 'vin' | 'odometer' | 'piece' | 'holding'>;

/** What an estimate is asked with (ACCT-11), kept only for the kind that uses it. */
function readLookup(
  draft: Draft,
  today: string,
  before: AssetRow | null,
): { ok: true; lookup: Lookup } | { ok: false; problem: Problem<AssetField> } {
  const none: Lookup = {
    address: null,
    postalCode: null,
    vin: null,
    odometer: null,
    piece: null,
    holding: null,
  };
  if (draft.kind === 'home') {
    const address = draft.address.trim();
    if (address.length > 300) return wrong('address', 'That address is too long.');
    return { ok: true, lookup: { ...none, address: address === '' ? null : address } };
  }
  if (draft.kind === 'valuables') {
    const piece = readPiece(draft);
    return piece.ok ? { ok: true, lookup: { ...none, piece: piece.piece } } : piece;
  }
  if (draft.kind !== 'vehicle') return { ok: true, lookup: none };
  const vin = draft.vin.trim().toUpperCase();
  if (vin !== '' && !VIN.test(vin)) {
    return wrong('vin', 'A VIN is 17 letters and digits, with no I, O or Q.');
  }
  const postalCode = draft.postalCode.trim();
  if (postalCode !== '' && !/^[0-9]{5}$/.test(postalCode)) {
    return wrong('postalCode', 'Enter a five-digit ZIP code.');
  }
  const digits = draft.miles.replace(/[,\s]/g, '');
  if (digits !== '' && !/^[0-9]{1,7}$/.test(digits)) {
    return wrong('miles', 'Enter the mileage as a whole number, like 21,000.');
  }
  const miles = digits === '' ? null : Number(digits);
  const keptOn = before !== null && before.odometer_miles === miles ? before.odometer_on : null;
  return {
    ok: true,
    lookup: {
      address: null,
      postalCode: postalCode === '' ? null : postalCode,
      vin: vin === '' ? null : vin,
      odometer: miles === null ? null : { miles, on: keptOn ?? today },
      piece: null,
      holding: null,
    },
  };
}

/** A piece of gold or silver (ACCT-12): its metal, weight and purity, all three or none. */
function readPiece(
  draft: Draft,
): { ok: true; piece: Piece | null } | { ok: false; problem: Problem<AssetField> } {
  if (draft.metal === '') return { ok: true, piece: null };
  const mg = milligramsOf(draft.weight, draft.unit);
  if (mg === null) {
    return wrong(
      'weight',
      draft.unit === 'g'
        ? 'Enter the weight in grams, like 52.3.'
        : 'Enter the weight in troy ounces, like 1.5.',
    );
  }
  const fineness = FINENESS[draft.metal].find((f) => String(f.fineness) === draft.fineness);
  if (fineness === undefined) return wrong('fineness', 'Say how pure it is.');
  return { ok: true, piece: { metal: draft.metal, mg, fineness: fineness.fineness } };
}

/**
 * A crypto holding (ACCT-21): the coin as Gemini names it and how much of it. In dollars only,
 * since Gemini's dollar close is the one price read.
 */
function readHolding(
  draft: Draft,
  currency: string,
):
  | { ok: true; holding: { readonly coin: string; readonly quantity: string } }
  | { ok: false; problem: Problem<AssetField> } {
  const coin = coinOf(draft.coin);
  if (coin === null) return wrong('coin', 'Enter the coin as Gemini names it, like BTC.');
  const quantity = quantityOf(draft.quantity);
  if (quantity === null) {
    return wrong('quantity', 'Enter how much you hold as a number, like 0.0123.');
  }
  if (currency !== CRYPTO_CURRENCY) {
    return wrong('coin', `Crypto is valued in dollars, and this is in ${currency}.`);
  }
  return { ok: true, holding: { coin, quantity } };
}

function DetailFields({
  draft,
  setDraft,
  currency,
  loans,
  problem,
  off,
}: {
  readonly draft: Draft;
  readonly setDraft: (draft: Draft) => void;
  readonly currency: string;
  readonly loans: readonly AccountRow[];
  readonly problem: Problem<AssetField> | null;
  readonly off: boolean;
}) {
  return (
    <>
      <Field label="Name" error={errorFor(problem, 'name')} wide>
        {(control) => (
          <input
            {...control}
            autoComplete="off"
            value={draft.name}
            maxLength={200}
            disabled={off}
            onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
          />
        )}
      </Field>
      <Segmented
        legend="Kind"
        name="asset-kind"
        options={ASSET_KINDS.map((kind) => ({ value: kind, label: KIND_NAMES[kind] }))}
        value={draft.kind}
        disabled={off}
        onChange={(kind) => setDraft({ ...draft, kind })}
      />
      {draft.kind === 'crypto' ? (
        <CoinFields draft={draft} setDraft={setDraft} problem={problem} off={off} />
      ) : (
        <PurchaseFields
          draft={draft}
          setDraft={setDraft}
          currency={currency}
          loans={loans}
          problem={problem}
          off={off}
        />
      )}
      {draft.kind === 'home' && (
        <Field
          label="Address"
          hint="For a market estimate each week."
          error={errorFor(problem, 'address')}
          wide
        >
          {(control) => (
            <input
              {...control}
              autoComplete="street-address"
              value={draft.address}
              maxLength={300}
              placeholder="Street, City, State, ZIP"
              disabled={off}
              onChange={(event) => setDraft({ ...draft, address: event.currentTarget.value })}
            />
          )}
        </Field>
      )}
      {draft.kind === 'valuables' && (
        <PieceFields draft={draft} setDraft={setDraft} problem={problem} off={off} />
      )}
      {draft.kind === 'vehicle' && (
        <VehicleFields draft={draft} setDraft={setDraft} problem={problem} off={off} />
      )}
    </>
  );
}

/** When it was bought, for what and with which loan: not asked of crypto (`holdingFacts`). */
function PurchaseFields({
  draft,
  setDraft,
  currency,
  loans,
  problem,
  off,
}: {
  readonly draft: Draft;
  readonly setDraft: (draft: Draft) => void;
  readonly currency: string;
  readonly loans: readonly AccountRow[];
  readonly problem: Problem<AssetField> | null;
  readonly off: boolean;
}) {
  return (
    <>
      <Field label="Bought on" error={errorFor(problem, 'acquiredOn')}>
        {(control) => (
          <input
            {...control}
            type="date"
            value={draft.acquiredOn}
            disabled={off}
            onChange={(event) => setDraft({ ...draft, acquiredOn: event.currentTarget.value })}
          />
        )}
      </Field>
      <Field
        label="Cost"
        hint="Optional. Shows what it has gained."
        error={errorFor(problem, 'cost')}
        {...currencyAffix(currency)}
      >
        {(control) => (
          <input
            {...control}
            inputMode="decimal"
            autoComplete="off"
            value={draft.cost}
            disabled={off}
            onChange={(event) => setDraft({ ...draft, cost: event.currentTarget.value })}
          />
        )}
      </Field>
      <Field label="Bought with" hint="The loan shows how much of it is yours.">
        {(control) => (
          <select
            {...control}
            value={draft.financedBy}
            disabled={off}
            onChange={(event) => setDraft({ ...draft, financedBy: event.currentTarget.value })}
          >
            <option value="">No loan</option>
            {loans.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name || 'Unnamed account'} · {account.institution}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}

/** What a vehicle's estimate is asked with (ACCT-11). */
function VehicleFields({
  draft,
  setDraft,
  problem,
  off,
}: {
  readonly draft: Draft;
  readonly setDraft: (draft: Draft) => void;
  readonly problem: Problem<AssetField> | null;
  readonly off: boolean;
}) {
  return (
    <>
      <Field label="VIN" hint="For a market estimate each week." error={errorFor(problem, 'vin')}>
        {(control) => (
          <input
            {...control}
            autoComplete="off"
            autoCapitalize="characters"
            value={draft.vin}
            maxLength={17}
            disabled={off}
            onChange={(event) => setDraft({ ...draft, vin: event.currentTarget.value })}
          />
        )}
      </Field>
      <Field label="ZIP code" error={errorFor(problem, 'postalCode')}>
        {(control) => (
          <input
            {...control}
            inputMode="numeric"
            autoComplete="postal-code"
            value={draft.postalCode}
            maxLength={5}
            disabled={off}
            onChange={(event) => setDraft({ ...draft, postalCode: event.currentTarget.value })}
          />
        )}
      </Field>
      <Field label="Mileage" error={errorFor(problem, 'miles')} after="mi">
        {(control) => (
          <input
            {...control}
            inputMode="numeric"
            autoComplete="off"
            value={draft.miles}
            placeholder="21,000"
            disabled={off}
            onChange={(event) => setDraft({ ...draft, miles: event.currentTarget.value })}
          />
        )}
      </Field>
    </>
  );
}

/**
 * What crypto she holds (ACCT-21): the coin as Gemini names it, and how much, which she updates
 * as rewards arrive. Typed as text and kept as text, every digit.
 */
function CoinFields({
  draft,
  setDraft,
  problem,
  off,
}: {
  readonly draft: Draft;
  readonly setDraft: (draft: Draft) => void;
  readonly problem: Problem<AssetField> | null;
  readonly off: boolean;
}) {
  return (
    <>
      <Field label="Coin" hint="As Gemini names it." error={errorFor(problem, 'coin')}>
        {(control) => (
          <input
            {...control}
            autoComplete="off"
            autoCapitalize="characters"
            value={draft.coin}
            maxLength={15}
            placeholder="BTC"
            disabled={off}
            onChange={(event) => setDraft({ ...draft, coin: event.currentTarget.value })}
          />
        )}
      </Field>
      <Field
        label="How much"
        hint="What Gemini shows you hold."
        error={errorFor(problem, 'quantity')}
      >
        {(control) => (
          <input
            {...control}
            inputMode="decimal"
            autoComplete="off"
            value={draft.quantity}
            placeholder="0.0123"
            disabled={off}
            onChange={(event) => setDraft({ ...draft, quantity: event.currentTarget.value })}
          />
        )}
      </Field>
    </>
  );
}

/** What a piece is made of. Purity is offered as the marks a piece is stamped with. */
function PieceFields({
  draft,
  setDraft,
  problem,
  off,
}: {
  readonly draft: Draft;
  readonly setDraft: (draft: Draft) => void;
  readonly problem: Problem<AssetField> | null;
  readonly off: boolean;
}) {
  const metal = draft.metal;
  return (
    <>
      <Segmented
        legend="Metal"
        name="asset-metal"
        options={[
          { value: '', label: 'Neither' },
          ...METALS.map((m) => ({ value: m, label: m === 'gold' ? 'Gold' : 'Silver' })),
        ]}
        value={metal}
        disabled={off}
        onChange={(next) => setDraft({ ...draft, metal: next, fineness: '' })}
      />
      {metal !== '' && (
        <>
          <Field
            label="Weight"
            error={errorFor(problem, 'weight')}
            after={draft.unit === 'g' ? 'g' : 'ozt'}
          >
            {(control) => (
              <input
                {...control}
                inputMode="decimal"
                autoComplete="off"
                value={draft.weight}
                placeholder={draft.unit === 'g' ? '52.3' : '1.5'}
                disabled={off}
                onChange={(event) => setDraft({ ...draft, weight: event.currentTarget.value })}
              />
            )}
          </Field>
          <Segmented
            legend="Weighed in"
            name="asset-unit"
            options={[
              { value: 'g', label: 'Grams' },
              { value: 'ozt', label: 'Troy ounces' },
            ]}
            value={draft.unit}
            disabled={off}
            onChange={(unit) => setDraft({ ...draft, unit })}
          />
          <Field label="Purity" error={errorFor(problem, 'fineness')}>
            {(control) => (
              <select
                {...control}
                value={draft.fineness}
                disabled={off}
                onChange={(event) => setDraft({ ...draft, fineness: event.currentTarget.value })}
              >
                <option value="">Choose</option>
                {FINENESS[metal].map((f) => (
                  <option key={f.fineness} value={String(f.fineness)}>
                    {f.label} ({f.fineness})
                  </option>
                ))}
              </select>
            )}
          </Field>
        </>
      )}
    </>
  );
}

function EditDetails({
  asset,
  loans,
  online,
  onDone,
}: {
  readonly asset: AssetRow;
  readonly loans: readonly AccountRow[];
  readonly online: boolean;
  /** Saved or cancelled: the sheet closes, and the page shows the facts as saved. */
  readonly onDone: () => void;
}) {
  const client = useQueryClient();
  const now = useNow();
  const [draft, setDraft] = useState(() => draftOf(asset));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem<AssetField> | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = readDetails(draft, asset.currency, localDay(now), asset);
    if (!read.ok) {
      setProblem(read.problem);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await updateAsset(asset.id, read.details);
      await client.invalidateQueries({ queryKey: ASSETS.queryKey });
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
      {/* What each field is for is its hint now; this paragraph said all of them at once, over
          the form, whichever kind it was (UI-02). */}
      {draft.kind === 'valuables' && (
        <p className="muted small">
          A piece of gold or silver, with its weight and purity, is valued at the LBMA’s price each
          business day.
        </p>
      )}
      {draft.kind === 'crypto' && (
        <p className="muted small">
          Update how much you hold as rewards arrive. Each night’s value counts the quantity as it
          stands then; a value already stored keeps the quantity it counted.
        </p>
      )}
      {asset.kind === 'vehicle' && asset.odometer_on !== null && (
        <p className="muted small">
          Mileage as of <Day on={asset.odometer_on} />. The estimate uses it as it stands, so update
          it now and then.
        </p>
      )}
      <div className="fields">
        <DetailFields
          draft={draft}
          setDraft={(next) => {
            setDraft(next);
            setProblem(null);
          }}
          currency={asset.currency}
          loans={loans}
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

/** Sold, or entered by mistake: at the foot of its edit sheet. */
function Remove({ asset, online }: { readonly asset: AssetRow; readonly online: boolean }) {
  const client = useQueryClient();
  return (
    <DangerZone
      label={`Remove ${asset.name}`}
      consequence="It leaves net worth, and its values leave the net worth chart."
      online={online}
      onRemove={async () => {
        await removeAsset(asset.id);
        await client.invalidateQueries({ queryKey: ASSETS.queryKey });
        window.location.hash = DASHBOARD_HREF;
      }}
    />
  );
}

/* ─── something new ─────────────────────────────────────────────────────────────────────── */

/** Adding something she owns: what it is, and what it is worth now. */
export function NewAsset({ userId }: { readonly userId: string }) {
  const client = useQueryClient();
  const accounts = useSynced(ACCOUNTS);
  const groups = useSynced(ACCOUNT_GROUPS);
  const online = useOnline();
  const now = useNow();
  const today = localDay(now);
  const [draft, setDraft] = useState(() => draftOf(null));
  const [currency, setCurrency] = useState<(typeof CURRENCIES)[number]>('USD');
  const [amount, setAmount] = useState('');
  const [valuedOn, setValuedOn] = useState(today);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<Problem<AssetField> | null>(null);

  const loans = loanChoices(
    placeAccounts(
      accounts.status === 'held' ? accounts.rows : [],
      groups.status === 'held' ? groups.rows : [],
    ),
    null,
  );

  // A holding (ACCT-21) is in dollars and valued by the night: she says how much, not its worth.
  const holding = draft.kind === 'crypto';
  const inCurrency = holding ? CRYPTO_CURRENCY : currency;

  const save = async (
    details: Details,
    value: { readonly valuedOn: string; readonly amountMinor: number } | null,
  ) => {
    setSaving(true);
    setProblem(null);
    try {
      const id = await addAsset(userId, details, inCurrency, value);
      await client.invalidateQueries({ queryKey: ASSETS.queryKey });
      await client.invalidateQueries({ queryKey: ASSET_VALUES.queryKey });
      window.location.hash = assetHref(id);
    } catch (error) {
      setProblem({ field: null, message: notDone(error, 'saved') });
      setSaving(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const read = readDetails(draft, inCurrency, today);
    if (!read.ok) {
      setProblem(read.problem);
      return;
    }
    if (holding) {
      await save(read.details, null);
      return;
    }
    const amountMinor = parseLimit(amount, currency);
    if (amountMinor === null) {
      setProblem({ field: 'amount', message: 'Enter what it is worth as a number, like 425,000.' });
      return;
    }
    if (valuedOn === '' || valuedOn > today) {
      setProblem({ field: 'valuedOn', message: 'Say the day it was worth this, today or before.' });
      return;
    }
    await save(read.details, { valuedOn, amountMinor });
  };

  const off = !online || saving;
  // Editing is answering the problem, so it goes until the next Add says otherwise.
  const answering = () => setProblem(null);
  return (
    <section className="details" aria-labelledby="new-asset-title">
      <Back />
      <h2 id="new-asset-title">Something you own</h2>
      <p className="muted small">
        {holding
          ? 'Say the coin and how much you hold. It is valued at Gemini’s close each night, and counts with your investments.'
          : 'It counts in net worth at the value you give it, and the value shows its age, so you can tell when it wants another look.'}
      </p>
      {!online && <p className="muted small">It can be added when this device is back online.</p>}
      <form className="add-figure" onSubmit={(event) => void submit(event)}>
        <div className="fields">
          <DetailFields
            draft={draft}
            setDraft={(next) => {
              setDraft(next);
              answering();
            }}
            currency={inCurrency}
            loans={loans}
            problem={problem}
            off={off}
          />
          {!holding && (
            <>
              <Segmented
                legend="Currency"
                name="asset-currency"
                options={CURRENCIES.map((code) => ({ value: code, label: code }))}
                value={currency}
                disabled={off}
                onChange={setCurrency}
              />
              <Field
                label="Worth now"
                error={errorFor(problem, 'amount')}
                {...currencyAffix(currency)}
              >
                {(control) => (
                  <input
                    {...control}
                    inputMode="decimal"
                    autoComplete="off"
                    value={amount}
                    placeholder="425,000"
                    disabled={off}
                    onChange={(event) => {
                      setAmount(event.currentTarget.value);
                      answering();
                    }}
                  />
                )}
              </Field>
              <Field label="Worth this on" error={errorFor(problem, 'valuedOn')}>
                {(control) => (
                  <input
                    {...control}
                    type="date"
                    value={valuedOn}
                    max={today}
                    disabled={off}
                    onChange={(event) => {
                      setValuedOn(event.currentTarget.value);
                      answering();
                    }}
                  />
                )}
              </Field>
            </>
          )}
        </div>
        <Actions problem={formError(problem)}>
          <button type="submit" disabled={off}>
            {saving ? 'Adding…' : 'Add it'}
          </button>
        </Actions>
      </form>
    </section>
  );
}
