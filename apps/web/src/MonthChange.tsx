import { formatMinor } from '@dinora/core/balances';
import type { Bridge, BridgePart, BridgePartKind, Member } from '@dinora/core/bridge';
import { likeForLike, stepsOf } from '@dinora/core/bridge';
import { describeDay, describeDayWithYear } from '@dinora/core/networth';
import { describeRateDate } from '@dinora/core/rates';

import { accountHref, assetHref } from './route.ts';
import { LOCALE } from './time.tsx';

const PART_NAMES: Readonly<Record<BridgePartKind, string>> = {
  cash: 'Cash',
  investments: 'Investments',
  property: 'Property',
  debt: 'Debt',
  rate: 'Exchange rate',
  unsided: 'Not in a group',
  new: 'Newly counted',
};

export type Names = {
  readonly accounts: ReadonlyMap<string, string>;
  readonly assets: ReadonlyMap<string, string>;
};

/**
 * What changed this month (ACCT-13), under the chart: from last month's figure to this one's,
 * one bar per part in its side's colour, each opening onto what moved it.
 *
 * Under the chart rather than the hero figure, where the audit put it: at 390px the plot's
 * place was measured and bought back in UI-05, and five rows above it would give that away.
 * The chart on 1M and this card are the same month from two sides.
 *
 * A bridge, not a set of bars from zero: each bar runs from where the walk stood to where the
 * part took it, so a month of a few thousand is not a sliver beside a net worth of hundreds of
 * thousands. Every bar is labelled with its name and its figure, so the colour identifies and
 * never alone carries anything. The parts that are not sides are drawn in the muted ink.
 *
 * What was counted for the first time is under the walk, apart and with no bar, and the
 * headline leaves it out (`likeForLike`); the line under the title says so, so the two ends
 * still visibly reconcile.
 */
export function MonthChange({ bridge, names }: { readonly bridge: Bridge; readonly names: Names }) {
  const { currency, from, to } = bridge;
  const money = (minor: bigint) => formatMinor(minor, currency, LOCALE);
  const added = bridge.parts.find((part) => part.part === 'new');

  // Positions only: every figure a person reads is formatted from the bigints.
  const walked = stepsOf(bridge);
  const ends = walked.flatMap((w) => [w.before, w.after]);
  const low = Number(ends.reduce((a, b) => (b < a ? b : a), 0n));
  const high = Number(ends.reduce((a, b) => (b > a ? b : a), 0n));
  const span = Math.max(1, high - low);
  const at = (minor: bigint) => ((Number(minor) - low) / span) * 100;

  return (
    <section className="group month-change" aria-labelledby="month-change-title">
      <div className="group-head">
        <h2 id="month-change-title">
          <span>What changed this month</span>
          <span className="group-total">{signed(likeForLike(bridge), currency)}</span>
        </h2>
        <p className="muted small">
          {money(from.minor)} on{' '}
          <time dateTime={from.on_date}>{describeDayWithYear(from.on_date, LOCALE)}</time>, then{' '}
          {money(to.minor)} on <time dateTime={to.on_date}>{describeDay(to.on_date, LOCALE)}</time>.
          {added !== undefined &&
            ` Of that, ${money(added.minor)} was counted for the first time, and is not in the change.`}
          {from.kind === 'rebuilt' && ' The first figure is partly rebuilt from transactions.'}
          {from.kind === 'monarch' && ' The first figure is partly Monarch’s.'}
          {from.kind === 'statement' && ' The first figure is partly from a lender’s statement.'}
        </p>
      </div>
      <ul className="bridge">
        {walked.map(({ part, before, after }) => {
          const left = at(before < after ? before : after);
          const width = Math.abs(at(after) - at(before));
          return (
            <li key={part.part}>
              <details>
                <summary>
                  <span className="bridge-name">
                    <i className={`swatch ${swatchOf(part.part)}`} aria-hidden="true" />
                    {PART_NAMES[part.part]}
                  </span>
                  <span className="bridge-amount">{describePart(part, currency)}</span>
                  <span className="bridge-track" aria-hidden="true">
                    <span className="bridge-start" style={{ left: `${at(0n)}%` }} />
                    {part.minor !== 0n && (
                      <span
                        className={`bridge-bar ${swatchOf(part.part)}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                    )}
                  </span>
                </summary>
                <PartDetail part={part} bridge={bridge} names={names} />
              </details>
            </li>
          );
        })}
      </ul>
      {added !== undefined && (
        <ul className="bridge apart">
          <li>
            <details>
              <summary>
                <span className="bridge-name">{PART_NAMES.new}</span>
                <span className="bridge-amount">{money(added.minor)}</span>
              </summary>
              <PartDetail part={added} bridge={bridge} names={names} />
            </details>
          </li>
        </ul>
      )}
    </section>
  );
}

function swatchOf(part: BridgePartKind): string {
  switch (part) {
    case 'cash':
    case 'investments':
    case 'property':
    case 'debt':
      return part;
    case 'rate':
    case 'unsided':
    case 'new':
      return 'other';
  }
}

function signed(minor: bigint, currency: string): string {
  if (minor === 0n) return 'No change';
  const text = formatMinor(minor, currency, LOCALE);
  return minor > 0n ? `+${text}` : text;
}

/** Debt in words, since a sign on money owed reads either way. */
function describeDebt(minor: bigint, currency: string): string {
  if (minor === 0n) return 'No change';
  const text = formatMinor(minor < 0n ? -minor : minor, currency, LOCALE);
  return minor > 0n ? `${text} paid down` : `${text} more owed`;
}

function describePart(part: BridgePart, currency: string): string {
  return part.part === 'debt' ? describeDebt(part.minor, currency) : signed(part.minor, currency);
}

function PartDetail({
  part,
  bridge,
  names,
}: {
  readonly part: BridgePart;
  readonly bridge: Bridge;
  readonly names: Names;
}) {
  if (part.part === 'rate') {
    return (
      <div className="bridge-detail muted small">
        <p>
          What the rate’s move did to what was already held. Each end is at its own day’s ECB rate,
          and each part above at the later one.
        </p>
        {[bridge.from, bridge.to].flatMap((end) =>
          end.conversions.map((conversion) => (
            // The row as the ECB published it, which in euros is read backwards (DIN-10).
            <p key={`${end.on_date}-${conversion.currency}`}>
              1 {conversion.rate.base} = {conversion.rate.rate} {conversion.rate.quote} on{' '}
              <time dateTime={conversion.rate.rate_date}>
                {describeRateDate(conversion.rate.rate_date, LOCALE)}
              </time>
              .
            </p>
          )),
        )}
      </div>
    );
  }
  return (
    <div className="bridge-detail">
      {part.part === 'investments' && (
        <p className="muted small">
          A balance’s change: what the market did and what was paid in are one figure until holdings
          are read.
        </p>
      )}
      {part.part === 'new' && (
        <p className="muted small">
          Not counted on{' '}
          <time dateTime={bridge.from.on_date}>
            {describeDayWithYear(bridge.from.on_date, LOCALE)}
          </time>
          , so none of it is in the change: linking an account, or valuing something for the first
          time, is neither a gain nor a loss.
        </p>
      )}
      <ul className="accounts">
        {part.members.map((member) => (
          <MemberRow
            key={`${member.kind}-${member.id}`}
            member={member}
            part={part.part}
            names={names}
          />
        ))}
      </ul>
    </div>
  );
}

function MemberRow({
  member,
  part,
  names,
}: {
  readonly member: Member;
  readonly part: BridgePartKind;
  readonly names: Names;
}) {
  const account = member.kind === 'account';
  const name = (account ? names.accounts : names.assets).get(member.id) ?? 'Unnamed';
  const figure =
    part === 'new'
      ? formatMinor(member.minor, member.currency, LOCALE)
      : part === 'debt'
        ? describeDebt(member.minor, member.currency)
        : signed(member.minor, member.currency);
  return (
    <li>
      <div className="account">
        <a href={account ? accountHref(member.id) : assetHref(member.id)}>{name}</a>
      </div>
      <div className="amount">{figure}</div>
    </li>
  );
}
