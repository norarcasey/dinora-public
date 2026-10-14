import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Actions, currencyAffix, errorFor, Field, formError, Segmented } from './controls.tsx';

describe('a field', () => {
  it('names its control by its label and reads the unit after it', () => {
    render(
      <Field label="Credit limit" before="$">
        {(control) => <input {...control} />}
      </Field>,
    );
    const input = screen.getByLabelText('Credit limit');
    const unit = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(unit?.textContent).toBe('$');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('puts its error in place of its hint, and marks the control', () => {
    const { rerender } = render(
      <Field label="Budget" hint="From September on" after="%">
        {(control) => <input {...control} />}
      </Field>,
    );
    expect(screen.getByText('From September on')).toBeDefined();
    rerender(
      <Field label="Budget" hint="From September on" error="Enter a number" after="%">
        {(control) => <input {...control} />}
      </Field>,
    );
    const input = screen.getByLabelText('Budget');
    expect(screen.queryByText('From September on')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Enter a number');
    expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
  });
});

describe('a segmented choice', () => {
  it('shows every option and says which is chosen', () => {
    const onChange = vi.fn<(value: 'a' | 'b') => void>();
    render(
      <Segmented
        legend="Kind"
        name="kind"
        options={[
          { value: 'a', label: 'One' },
          { value: 'b', label: 'Two' },
        ]}
        value="a"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('radio', { name: 'One' })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('radio', { name: 'Two' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('the actions', () => {
  it('says saved only while nothing is wrong', () => {
    const { rerender } = render(
      <Actions saved>
        <button type="submit">Save</button>
      </Actions>,
    );
    expect(screen.getByRole('status').textContent).toBe('Saved');
    rerender(
      <Actions saved problem="Not saved.">
        <button type="submit">Save</button>
      </Actions>,
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Not saved.');
  });
});

describe('a problem', () => {
  it('belongs to its field, or to the form when it names none', () => {
    const onField = { field: 'name', message: 'Give it a name.' } as const;
    const onForm = { field: null, message: 'Not saved.' } as const;
    expect(errorFor(onField, 'name')).toBe('Give it a name.');
    expect(errorFor(onField, 'cost')).toBeNull();
    expect(formError(onField)).toBeNull();
    expect(formError(onForm)).toBe('Not saved.');
    expect(errorFor(null, 'name')).toBeNull();
  });
});

describe('a currency’s sign', () => {
  it('is the sign, not the code, on the side this device writes it', () => {
    const dollars = currencyAffix('USD');
    expect(dollars.before ?? dollars.after).toBe('$');
    const euros = currencyAffix('EUR');
    expect(euros.before ?? euros.after).toBe('€');
  });
});
