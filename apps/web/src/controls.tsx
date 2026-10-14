import { formatMinor } from '@dinora/core/balances';
import type { ReactNode } from 'react';
import { useId } from 'react';

import { LOCALE } from './time.tsx';

/**
 * The controls every form is built from (UI-02). The design audit of 26 Sep found four sizes of
 * select, units written into labels (*Amount, USD*), and every error printed under the Save
 * button, away from the field it was about and unmarked for a screen reader. Here a field
 * carries its own unit, hint and error, and every control is at least 44px tall.
 */

/**
 * What is wrong with a form, and which field it is about. `null` is the form as a whole: a
 * save the server refused, which no field can fix.
 */
export type Problem<F extends string> = { readonly field: F | null; readonly message: string };

/** What a field hands the one control inside it, so the label, hint and error reach it. */
export type ControlProps = {
  readonly id: string;
  readonly 'aria-invalid': true | undefined;
  readonly 'aria-describedby': string | undefined;
};

export function Field({
  label,
  hint,
  error = null,
  before,
  after,
  wide = false,
  children,
}: {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | null;
  /** A unit inside the field, before the text: `$`. */
  readonly before?: string;
  /** A unit inside the field, after the text: `%`. */
  readonly after?: string;
  /** Across the whole row: a name, an address. */
  readonly wide?: boolean;
  readonly children: (control: ControlProps) => ReactNode;
}) {
  const id = useId();
  const unitId = `${id}-unit`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  // The unit is read after the label, so "Credit limit, $" rather than a bare number.
  const describedBy = [
    before !== undefined || after !== undefined ? unitId : null,
    error !== null ? errorId : hint !== undefined ? hintId : null,
  ].filter((part) => part !== null);
  const classes = ['field', wide ? 'wide' : null, error !== null ? 'invalid' : null];
  return (
    <div className={classes.filter((c) => c !== null).join(' ')}>
      <label htmlFor={id}>{label}</label>
      <div className="control-box">
        {before !== undefined && (
          <span className="affix" id={unitId}>
            {before}
          </span>
        )}
        {children({
          id,
          'aria-invalid': error !== null ? true : undefined,
          'aria-describedby': describedBy.length > 0 ? describedBy.join(' ') : undefined,
        })}
        {after !== undefined && (
          <span className="affix" id={before === undefined ? unitId : undefined}>
            {after}
          </span>
        )}
      </div>
      {/* The error takes the hint's place: both at once is two sentences about one field. */}
      {error !== null ? (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      ) : (
        hint !== undefined && (
          <p id={hintId} className="hint">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** A handful of choices, all on show: a select hides four options behind a tap. */
export function Segmented<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
  disabled = false,
}: {
  readonly legend: string;
  readonly name: string;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
}) {
  return (
    <fieldset className="segmented" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="segments">
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Boxes to tick, with the error for the set of them. */
export function CheckList({
  legend,
  error = null,
  disabled = false,
  children,
}: {
  readonly legend: string;
  readonly error?: string | null;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset
      className={error === null ? 'checklist' : 'checklist invalid'}
      disabled={disabled}
      aria-describedby={error === null ? undefined : id}
    >
      <legend>{legend}</legend>
      {children}
      {error !== null && (
        <p id={id} className="field-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** One box and what it is, with any second line quieter beneath rather than run on. */
export function Check({
  checked,
  onChange,
  label,
  detail,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly detail?: string;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>
        {label}
        {detail !== undefined && detail !== '' && <span className="check-detail">{detail}</span>}
      </span>
    </label>
  );
}

/** The submit, and beside it what became of the last one. */
export function Actions({
  children,
  problem = null,
  saved = false,
}: {
  readonly children: ReactNode;
  /** The form's own problem: one no field can fix, like a refused save. */
  readonly problem?: string | null;
  readonly saved?: boolean;
}) {
  return (
    <div className="actions">
      {children}
      {saved && problem === null && (
        <span className="saved" role="status">
          Saved
        </span>
      )}
      {problem !== null && (
        <p className="error form-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/** The field's error, if the problem is about it. */
export function errorFor<F extends string>(problem: Problem<F> | null, field: F): string | null {
  return problem !== null && problem.field === field ? problem.message : null;
}

/** The form's own error, if the problem is about no one field. */
export function formError<F extends string>(problem: Problem<F> | null): string | null {
  return problem !== null && problem.field === null ? problem.message : null;
}

/**
 * An amount as a field's starting text: the number alone, since the field shows the sign
 * beside it. With the sign in the text too, the Cost field read "$ $385,000.00" (UI-03,
 * 26 Sep). English separators whatever the device, which is what `parseLimit` reads back.
 */
export function amountDraft(minor: number | bigint, currency: string): string {
  return formatMinor(minor, currency, 'en-US').replace(/[^\d.,-]/g, '');
}

/**
 * A currency's sign and which side of the number it goes, the way this device writes money:
 * `$` before in English, `€` after in Spanish.
 */
export function currencyAffix(currency: string): {
  readonly before?: string;
  readonly after?: string;
} {
  const parts = new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).formatToParts(1);
  const at = parts.findIndex((part) => part.type === 'currency');
  const sign = parts[at]?.value.trim() ?? currency;
  const number = parts.findIndex((part) => part.type === 'integer');
  return at < number ? { before: sign } : { after: sign };
}
