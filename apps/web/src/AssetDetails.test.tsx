import type { AssetRow, AssetValueRow } from '@dinora/core/assets';
import type { AccountRow } from '@dinora/core/balances';
import type { GroupRow } from '@dinora/core/groups';
import type { CryptoPriceRow } from '@dinora/core/crypto';
import type { PriceRow } from '@dinora/core/metals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssetDetails as Details } from './queries/assets.ts';
import type { SyncedRows } from './queries/synced.ts';
import { WriteError } from './queries/writes.ts';

// Noon UTC, so her local day is 25 Sep wherever the tests run.
const NOW = Date.parse('2026-09-25T12:00:00Z');
const USER = '11111111-1111-1111-1111-111111111111';

const state: {
  assets: SyncedRows<AssetRow>;
  values: SyncedRows<AssetValueRow>;
  accounts: SyncedRows<AccountRow>;
  groups: SyncedRows<GroupRow>;
  prices: SyncedRows<PriceRow>;
  closes: SyncedRows<CryptoPriceRow>;
  online: boolean;
} = {
  assets: { status: 'waiting' },
  values: { status: 'waiting' },
  accounts: { status: 'waiting' },
  groups: { status: 'waiting' },
  prices: { status: 'waiting' },
  closes: { status: 'waiting' },
  online: true,
};

type Value = { readonly valuedOn: string; readonly amountMinor: number };
const addAsset =
  vi.fn<
    (user: string, details: Details, currency: string, value: Value | null) => Promise<string>
  >();
const updateAsset = vi.fn<(id: string, details: Details) => Promise<void>>();
const removeAsset = vi.fn<(id: string) => Promise<void>>();
const addValue = vi.fn<(user: string, asset: string, value: Value) => Promise<void>>();
const removeValue = vi.fn<(id: string) => Promise<void>>();

vi.mock('./queries/synced.ts', () => ({
  useSynced: (table: { name: string }) => {
    switch (table.name) {
      case 'assets':
        return state.assets;
      case 'asset_values':
        return state.values;
      case 'accounts':
        return state.accounts;
      case 'account_groups':
        return state.groups;
      case 'metal_prices':
        return state.prices;
      case 'crypto_prices':
        return state.closes;
      default:
        return { status: 'waiting' };
    }
  },
  defineSynced: (spec: { name: string }) => ({ ...spec, queryKey: ['synced', spec.name] }),
}));
vi.mock('./queries/assets.ts', () => ({
  ASSETS: { name: 'assets', queryKey: ['synced', 'assets'] },
  ASSET_VALUES: { name: 'asset_values', queryKey: ['synced', 'asset_values'] },
  METAL_PRICES: { name: 'metal_prices', queryKey: ['synced', 'metal_prices'] },
  CRYPTO_PRICES: { name: 'crypto_prices', queryKey: ['synced', 'crypto_prices'] },
  addAsset,
  updateAsset,
  removeAsset,
  addValue,
  removeValue,
}));
vi.mock('./queries/groups.ts', () => ({
  ACCOUNT_GROUPS: { name: 'account_groups', queryKey: ['synced', 'account_groups'] },
}));
vi.mock('./device/useOnline.ts', () => ({ useOnline: () => state.online }));

const { AssetDetails, NewAsset, readDetails } = await import('./AssetDetails.tsx');

const LOAN: AccountRow = {
  id: 'auto',
  updated_at: '2026-09-25T09:00:00+00:00',
  deleted_at: null,
  institution: 'PSCU',
  name: 'Auto Loan',
  currency: 'USD',
  balance_minor: -1_800_000,
  balance_at: '2026-09-25T09:00:00+00:00',
  holdings: 0,
  source: 'simplefin',
};

const CHECKING: AccountRow = { ...LOAN, id: 'checking', name: 'Checking', balance_minor: 1 };

const CAR: AssetRow = {
  id: 'car',
  updated_at: '2026-09-25T09:00:00+00:00',
  deleted_at: null,
  name: 'Civic',
  kind: 'vehicle',
  currency: 'USD',
  acquired_on: '2024-03-01',
  cost_minor: 4_000_000,
  financed_by: 'auto',
  address: null,
  postal_code: null,
  vin: null,
  odometer_miles: null,
  odometer_on: null,
  metal: null,
  metal_mg: null,
  fineness: null,
  coin: null,
  coin_quantity: null,
};

function valued(
  id: string,
  on: string,
  minor: number,
  source: AssetValueRow['source'] = 'entered',
): AssetValueRow {
  return {
    id,
    updated_at: '2026-09-25T09:00:00+00:00',
    deleted_at: null,
    asset_id: 'car',
    valued_on: on,
    amount_minor: minor,
    source,
    provider: source === 'estimate' ? 'rentcast' : null,
    low_minor: null,
    high_minor: null,
    coin_quantity: null,
    created_at: `${on}T09:00:00+00:00`,
  };
}

function held<Row>(rows: Row[]): SyncedRows<Row> {
  return { status: 'held', rows, asOf: NOW, refreshing: false, stale: false };
}

function show(screenFor: 'asset' | 'new' = 'asset', assetId = 'car') {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const page = () => (
    <QueryClientProvider client={client}>
      {screenFor === 'asset' ? (
        <AssetDetails assetId={assetId} userId={USER} />
      ) : (
        <NewAsset userId={USER} />
      )}
    </QueryClientProvider>
  );
  const { rerender } = render(page());
  return { invalidate, again: () => rerender(page()) };
}

function text(element: Element = document.body): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ');
}

/** A sheet (UI-03), opened by the button on the page that opens it. */
function open(button: string, title: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: button }));
  return screen.getByRole('dialog', { name: title });
}

function theForm(sheet: HTMLElement): HTMLElement {
  const found = sheet.querySelector('form');
  if (found === null) throw new Error('no form in the sheet');
  return found;
}

const addSheet = () => open('Add a value', 'Add a value');
const editSheet = (name = 'Civic') => open('Edit', `Edit ${name}`);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.assets = held([CAR]);
  state.values = held([
    valued('v1', '2024-03-01', 4_000_000, 'monarch'),
    valued('v2', '2026-09-01', 3_000_000),
  ]);
  state.accounts = held([LOAN, CHECKING]);
  state.groups = held([]);
  state.prices = held([]);
  state.closes = held([]);
  state.online = true;
  for (const mock of [addAsset, updateAsset, removeAsset, addValue, removeValue]) mock.mockReset();
  window.location.hash = '';
});

describe('an asset', () => {
  it('waits for the disk, and says when it is not in Dinora', () => {
    state.assets = { status: 'waiting' };
    show();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('is not found when removed or unknown', () => {
    state.assets = held([{ ...CAR, deleted_at: '2026-09-24T00:00:00+00:00' }]);
    show();
    expect(text()).toContain('This is not in Dinora.');
  });

  it('says when the server cannot be reached and nothing was saved', () => {
    state.assets = { status: 'failed' };
    show();
    expect(text()).toContain('Dinora could not be reached');
  });

  it('shows its value, its age, what it lost and what of it is hers', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Civic' })).toBeDefined();
    expect(text()).toContain('$30,000.00');
    expect(text()).toContain('Your value from');
    expect(text()).toContain('-$10,000.00 -25%');
    expect(text()).toContain('Bought for $40,000.00');
    expect(text()).toContain('Yours, after the loan$12,000.00');
    expect(text()).toContain('$18,000.00 still owed on Auto Loan');
    // Every value, newest first, Monarch's said as Monarch's.
    const values = screen.getByRole('region', { name: 'Values' });
    expect(text(values)).toMatch(/\$30,000\.00.*\$40,000\.00.*from Monarch/);
  });

  it('says what it is as facts to read, the loan among them', () => {
    show();
    const facts = text(screen.getByRole('region', { name: 'What it is' }));
    expect(facts).toContain('Bought');
    expect(facts).toContain('for $40,000.00');
    expect(facts).toContain('Bought withAuto Loan · PSCU');
    expect(facts).toContain('VINNot given');
    // Read, not filled in: the form is in the sheet, not on the page.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows five values, and the rest a tap away', () => {
    state.values = held(
      Array.from({ length: 7 }, (_, i) =>
        valued(`v${i}`, `2026-0${i + 1}-01`, 3_000_000 + i * 100_000),
      ),
    );
    show();
    const values = screen.getByRole('region', { name: 'Values' });
    expect(within(values).getAllByRole('listitem')).toHaveLength(5);
    expect(within(values).queryByRole('button', { name: /^Remove \$/ })).toBeNull();
    fireEvent.click(within(values).getByRole('button', { name: 'All 7' }));
    const all = screen.getByRole('dialog', { name: 'Values' });
    expect(within(all).getAllByRole('listitem')).toHaveLength(7);
    expect(within(all).getByRole('button', { name: 'Remove $30,000.00' })).toBeDefined();
  });

  it('asks whether an old value is still right', () => {
    state.values = held([valued('v1', '2025-01-15', 3_000_000, 'monarch')]);
    show();
    const age = document.querySelector('.age');
    expect(age?.className).toContain('stale');
    expect(text(age ?? document.body)).toContain('Monarch’s value from');
    expect(text(age ?? document.body)).toContain('Is it still worth this?');
  });

  it('says it is not valued yet, and that equity across currencies is not worked out', () => {
    state.values = held([]);
    show();
    expect(text()).toContain('Not valued yet.');
    state.values = held([valued('v2', '2026-09-01', 3_000_000)]);
    state.assets = held([{ ...CAR, currency: 'EUR' }]);
    document.body.innerHTML = '';
    show();
    expect(text()).toContain('Not worked out: the loan is in USD');
  });
});

describe('setting a value', () => {
  it('adds a new row, dated, and reads the table again', async () => {
    addValue.mockResolvedValue();
    const { invalidate } = show();
    const add = addSheet();
    fireEvent.change(within(add).getByLabelText('Worth'), {
      target: { value: '$28,500' },
    });
    fireEvent.click(within(add).getByRole('button', { name: 'Add value' }));
    await waitFor(() =>
      expect(addValue).toHaveBeenCalledWith(USER, 'car', {
        valuedOn: '2026-09-25',
        amountMinor: 2_850_000,
      }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['synced', 'asset_values'] }),
    );
    // Saved, the sheet closes over the page that shows it.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on Cancel, adding nothing', () => {
    show();
    const add = addSheet();
    fireEvent.change(within(add).getByLabelText('Worth'), { target: { value: '1' } });
    fireEvent.click(within(add).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(addValue).not.toHaveBeenCalled();
    // Opened again, it starts empty rather than from the draft left behind.
    expect(within(addSheet()).getByLabelText('Worth')).toHaveProperty('value', '');
  });

  it('refuses what is not an amount, or a day still to come', () => {
    show();
    const add = addSheet();
    fireEvent.change(within(add).getByLabelText('Worth'), { target: { value: 'lots' } });
    fireEvent.click(within(add).getByRole('button', { name: 'Add value' }));
    expect(text(add)).toContain('Enter the value as a number');
    fireEvent.change(within(add).getByLabelText('Worth'), { target: { value: '1' } });
    fireEvent.change(within(add).getByLabelText('On'), { target: { value: '2026-12-01' } });
    // Submitted directly: a browser, and jsdom, stop a click at the field's `max` first.
    fireEvent.submit(theForm(add));
    expect(text(add)).toContain('today or before');
    expect(addValue).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Add a value' })).toBeDefined();
  });

  it('says so when the value was not saved', async () => {
    addValue.mockRejectedValue(new Error('no'));
    show();
    const add = addSheet();
    fireEvent.change(within(add).getByLabelText('Worth'), { target: { value: '1' } });
    fireEvent.click(within(add).getByRole('button', { name: 'Add value' }));
    expect((await within(add).findByRole('alert')).textContent).toContain('Not saved');
  });

  it('is off with no signal', () => {
    state.online = false;
    show();
    expect(text()).toContain('Changes can be made when this device is back online.');
    expect(screen.getByRole('button', { name: 'Add a value' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Remove one' })).toHaveProperty('disabled', true);
  });

  it('switches off a sheet already open when the signal goes', () => {
    const { again } = show();
    const add = addSheet();
    state.online = false;
    again();
    expect(text(add)).toContain('Values can be set when this device is back online.');
    expect(within(add).getByRole('button', { name: 'Add value' })).toHaveProperty('disabled', true);
  });
});

describe('taking a value back', () => {
  it('asks first, then removes it', async () => {
    removeValue.mockResolvedValue();
    show();
    const values = within(open('Remove one', 'Values'));
    fireEvent.click(values.getByRole('button', { name: 'Remove $30,000.00' }));
    fireEvent.click(values.getByRole('button', { name: 'Keep' }));
    expect(removeValue).not.toHaveBeenCalled();
    fireEvent.click(values.getByRole('button', { name: 'Remove $30,000.00' }));
    fireEvent.click(values.getByRole('button', { name: 'Yes, remove $30,000.00' }));
    await waitFor(() => expect(removeValue).toHaveBeenCalledWith('v2'));
  });

  it('says so when it could not', async () => {
    removeValue.mockRejectedValue(new Error('no'));
    show();
    const values = within(open('Remove one', 'Values'));
    fireEvent.click(values.getByRole('button', { name: 'Remove $30,000.00' }));
    fireEvent.click(values.getByRole('button', { name: 'Yes, remove $30,000.00' }));
    expect(await values.findByText(/Not removed/)).toBeDefined();
  });
});

describe('what it is', () => {
  it('saves a new name, cost and loan', async () => {
    updateAsset.mockResolvedValue();
    const { invalidate } = show();
    const edit = editSheet();
    fireEvent.change(within(edit).getByLabelText('Name'), { target: { value: ' Honda ' } });
    fireEvent.change(within(edit).getByLabelText('Bought with'), { target: { value: '' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith('car', {
        name: 'Honda',
        kind: 'vehicle',
        acquiredOn: '2024-03-01',
        costMinor: 4_000_000,
        financedBy: null,
        address: null,
        postalCode: null,
        vin: null,
        odometer: null,
        piece: null,
        holding: null,
      }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['synced', 'assets'] }),
    );
    // Saved, the sheet closes; there is no "Saved" to read in it any more.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on Cancel, saving nothing', () => {
    show();
    const edit = editSheet();
    fireEvent.change(within(edit).getByLabelText('Name'), { target: { value: 'Honda' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(updateAsset).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Civic' })).toBeDefined();
  });

  it('offers only debts as the loan it was bought with', () => {
    show();
    const choices = within(editSheet()).getByLabelText('Bought with').querySelectorAll('option');
    expect([...choices].map((o) => o.textContent)).toEqual(['No loan', 'Auto Loan · PSCU']);
  });

  it('shows what is wrong, and says when it was not saved', async () => {
    updateAsset.mockRejectedValue(new Error('no'));
    show();
    const edit = editSheet();
    fireEvent.change(within(edit).getByLabelText('Name'), { target: { value: '' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    expect(text(edit)).toContain('Give it a name.');
    fireEvent.change(within(edit).getByLabelText('Name'), { target: { value: 'Car' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    expect((await within(edit).findByRole('alert')).textContent).toContain('Not saved');
  });

  it('names the code when Dinora answered and refused', async () => {
    updateAsset.mockRejectedValue(new WriteError('the asset was not saved', '42501'));
    show();
    const edit = editSheet();
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    expect((await within(edit).findByRole('alert')).textContent).toBe(
      'Not saved: Dinora refused it (code 42501).',
    );
  });
});

describe('removing it', () => {
  it('asks first, removes it, and goes back to the dashboard', async () => {
    removeAsset.mockResolvedValue();
    show();
    const edit = within(editSheet());
    fireEvent.click(edit.getByRole('button', { name: 'Remove Civic' }));
    expect(text()).toContain('It leaves net worth');
    fireEvent.click(edit.getByRole('button', { name: 'Yes, remove Civic' }));
    await waitFor(() => expect(removeAsset).toHaveBeenCalledWith('car'));
    await waitFor(() => expect(window.location.hash).toBe('#/'));
  });

  it('can be kept, and says when removing failed', async () => {
    removeAsset.mockRejectedValue(new Error('no'));
    show();
    const edit = within(editSheet());
    fireEvent.click(edit.getByRole('button', { name: 'Remove Civic' }));
    fireEvent.click(edit.getByRole('button', { name: 'Keep' }));
    expect(removeAsset).not.toHaveBeenCalled();
    fireEvent.click(edit.getByRole('button', { name: 'Remove Civic' }));
    fireEvent.click(edit.getByRole('button', { name: 'Yes, remove Civic' }));
    expect(await edit.findByText(/Not removed/)).toBeDefined();
  });
});

describe('something new', () => {
  it('adds it with its first value and opens its page', async () => {
    addAsset.mockResolvedValue('new-id');
    show('new');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Gold bracelet' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Valuables' }));
    fireEvent.change(screen.getByLabelText('Bought on'), { target: { value: '2022-05-01' } });
    fireEvent.change(screen.getByLabelText('Cost'), { target: { value: '8,000' } });
    fireEvent.change(screen.getByLabelText('Worth now'), { target: { value: '14,000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add it' }));
    await waitFor(() =>
      expect(addAsset).toHaveBeenCalledWith(
        USER,
        {
          name: 'Gold bracelet',
          kind: 'valuables',
          acquiredOn: '2022-05-01',
          costMinor: 800_000,
          financedBy: null,
          address: null,
          postalCode: null,
          vin: null,
          odometer: null,
          piece: null,
          holding: null,
        },
        'USD',
        { valuedOn: '2026-09-25', amountMinor: 1_400_000 },
      ),
    );
    await waitFor(() => expect(window.location.hash).toBe('#/asset/new-id'));
  });

  it('takes euros, and refuses a missing value or a day to come', () => {
    show('new');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Piso' } });
    fireEvent.click(screen.getByRole('radio', { name: 'EUR' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add it' }));
    expect(text()).toContain('Enter what it is worth as a number');
    fireEvent.change(screen.getByLabelText('Worth now'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Worth this on'), { target: { value: '2027-01-01' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Add it' }));
    expect(text()).toContain('today or before');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Add it' }));
    expect(text()).toContain('Give it a name.');
    expect(addAsset).not.toHaveBeenCalled();
  });

  it('says so when it was not saved, and is off with no signal', async () => {
    addAsset.mockRejectedValue(new Error('no'));
    show('new');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Silver' } });
    fireEvent.change(screen.getByLabelText('Worth now'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add it' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Not saved');

    document.body.innerHTML = '';
    state.online = false;
    state.accounts = { status: 'waiting' };
    show('new');
    expect(text()).toContain('back online');
    expect(screen.getByRole('button', { name: 'Add it' })).toHaveProperty('disabled', true);
  });
});

describe('readDetails', () => {
  const draft = {
    name: 'Ring',
    kind: 'valuables' as const,
    acquiredOn: '',
    cost: '',
    financedBy: '',
    address: '',
    postalCode: '',
    vin: '',
    miles: '',
    metal: '' as const,
    weight: '',
    unit: 'g' as const,
    fineness: '',
    coin: '',
    quantity: '',
  };

  it('needs the day it was bought for a cost to mean anything', () => {
    expect(readDetails({ ...draft, cost: '100' }, 'USD', '2026-09-25')).toEqual({
      ok: false,
      problem: {
        field: 'acquiredOn',
        message: 'Say when you bought it, so the cost can show what it gained.',
      },
    });
  });

  it('refuses a cost that is not an amount, and a day to come', () => {
    expect(
      readDetails({ ...draft, cost: 'x', acquiredOn: '2020-01-01' }, 'USD', '2026-09-25').ok,
    ).toBe(false);
    expect(readDetails({ ...draft, acquiredOn: '2027-01-01' }, 'USD', '2026-09-25').ok).toBe(false);
  });

  it('leaves out what was not said', () => {
    expect(readDetails(draft, 'USD', '2026-09-25')).toEqual({
      ok: true,
      details: {
        name: 'Ring',
        kind: 'valuables',
        acquiredOn: null,
        costMinor: null,
        financedBy: null,
        address: null,
        postalCode: null,
        vin: null,
        odometer: null,
        piece: null,
        holding: null,
      },
    });
  });

  const car = { ...draft, name: 'Civic', kind: 'vehicle' as const };

  it('reads what a car is estimated with, and dates a new mileage today', () => {
    const read = readDetails(
      { ...car, vin: ' 2hgfe1f50ph000001 ', postalCode: '92104', miles: '21,000' },
      'USD',
      '2026-09-25',
      CAR,
    );
    expect(read).toMatchObject({
      ok: true,
      details: {
        address: null,
        vin: '2HGFE1F50PH000001',
        postalCode: '92104',
        odometer: { miles: 21_000, on: '2026-09-25' },
      },
    });
  });

  it('keeps the day of a mileage she did not change', () => {
    const before = { ...CAR, odometer_miles: 21_000, odometer_on: '2026-06-01' };
    expect(readDetails({ ...car, miles: '21000' }, 'USD', '2026-09-25', before)).toMatchObject({
      details: { odometer: { miles: 21_000, on: '2026-06-01' } },
    });
  });

  it('refuses a VIN, a ZIP code or a mileage that cannot be one', () => {
    expect(readDetails({ ...car, vin: '2HGFE1F50PH00000O' }, 'USD', '2026-09-25')).toEqual({
      ok: false,
      problem: { field: 'vin', message: 'A VIN is 17 letters and digits, with no I, O or Q.' },
    });
    expect(readDetails({ ...car, postalCode: '9812' }, 'USD', '2026-09-25').ok).toBe(false);
    expect(readDetails({ ...car, miles: '21.5' }, 'USD', '2026-09-25').ok).toBe(false);
  });

  it('keeps an address for a home only, and drops a car’s inputs from anything else', () => {
    const home = { ...draft, kind: 'home' as const, address: ' 1 Main St, San Diego, CA ' };
    expect(readDetails(home, 'USD', '2026-09-25')).toMatchObject({
      details: { address: '1 Main St, San Diego, CA', vin: null },
    });
    expect(readDetails({ ...draft, vin: '2HGFE1F50PH000001' }, 'USD', '2026-09-25')).toMatchObject({
      details: { vin: null, address: null },
    });
    expect(readDetails({ ...home, address: 'x'.repeat(301) }, 'USD', '2026-09-25').ok).toBe(false);
  });
});

describe('an estimate', () => {
  function estimated(id: string, on: string, minor: number): AssetValueRow {
    return { ...valued(id, on, minor, 'estimate'), provider: 'marketcheck' };
  }

  it('shows beside her value, quieter, and hers is the one that counts', () => {
    state.values = held([
      valued('v1', '2026-09-01', 3_000_000),
      estimated('e1', '2026-09-20', 2_745_000),
    ]);
    show();
    expect(document.querySelector('.hero-value')?.textContent).toBe('$30,000.00');
    const note = document.querySelector('.estimate');
    expect(text(note ?? document.body)).toContain('MarketCheck estimates $27,450.00');
    expect(text(note ?? document.body)).toContain('dealer’s retail price');
    expect(text(note ?? document.body)).toContain('Yours is the one that counts.');
    const values = screen.getByRole('region', { name: 'Values' });
    expect(text(values)).toContain('MarketCheck’s estimate');
  });

  it('is the value when she has set none, and says what kind of figure it is', () => {
    state.values = held([
      valued('m1', '2026-08-01', 2_900_000, 'monarch'),
      {
        ...estimated('e1', '2026-09-20', 2_745_000),
        provider: 'rentcast',
        low_minor: 2_600_000,
        high_minor: 2_900_000,
      },
    ]);
    show();
    expect(document.querySelector('.hero-value')?.textContent).toBe('$27,450.00');
    expect(text(document.querySelector('.age') ?? document.body)).toContain(
      'RentCast’s estimate from',
    );
    const note = text(document.querySelector('.estimate') ?? document.body);
    expect(note).toContain('somewhere between $26,000.00 and $29,000.00');
    expect(note).toContain('A value you set counts instead.');
  });

  it('asks a car for its VIN, ZIP code and mileage, and a home for its address', () => {
    show();
    const edit = editSheet();
    expect(within(edit).getByLabelText('VIN')).toBeDefined();
    expect(within(edit).queryByLabelText('Address')).toBeNull();
    fireEvent.click(within(edit).getByRole('radio', { name: 'Home' }));
    expect(within(edit).getByLabelText('Address')).toBeDefined();
    expect(within(edit).queryByLabelText('VIN')).toBeNull();
  });

  it('says how old the mileage is', () => {
    state.assets = held([{ ...CAR, odometer_miles: 21_000, odometer_on: '2026-06-01' }]);
    show();
    // On the page, beside the figure; and in the sheet, where it is changed.
    expect(text(screen.getByRole('region', { name: 'What it is' }))).toContain(
      'Mileage21,000 mi as of',
    );
    expect(text(editSheet())).toContain('Mileage as of');
  });
});

describe('gold and silver', () => {
  const BRACELET: AssetRow = {
    ...CAR,
    id: 'bracelet',
    name: 'Gold bracelet',
    kind: 'valuables',
    acquired_on: '2022-03-01',
    cost_minor: 800_000,
    financed_by: null,
    metal: 'gold',
    metal_mg: 52_300,
    fineness: 750,
  };

  function priced(id: string, on: string, value: string): PriceRow {
    return {
      id,
      updated_at: '2026-09-25T09:00:00+00:00',
      deleted_at: null,
      source: 'lbma',
      metal: 'gold',
      currency: 'USD',
      price_date: on,
      price: value,
    };
  }

  function metalValue(id: string, on: string, minor: number): AssetValueRow {
    return { ...valued(id, on, minor, 'estimate'), asset_id: 'bracelet', provider: 'lbma' };
  }

  beforeEach(() => {
    state.assets = held([BRACELET]);
    state.values = held([metalValue('g1', '2026-09-24', 538_041)]);
    state.prices = held([
      priced('p1', '2022-03-01', '1922'),
      priced('p2', '2026-09-23', '4284.45'),
      priced('p3', '2026-09-24', '4266.4'),
    ]);
  });

  it('is its metal at the LBMA’s price, said to be a floor', () => {
    show('asset', 'bracelet');
    expect(document.querySelector('.hero-value')?.textContent).toBe('$5,380.41');
    expect(text(document.querySelector('.age') ?? document.body)).toContain(
      'Its metal at the LBMA’s price from',
    );
    const note = text(document.querySelector('.estimate') ?? document.body);
    expect(note).toContain('The metal alone: a floor');
    expect(note).toContain('A value you set counts instead.');
  });

  it('shows what its gold has done since she bought it, not the floor against the cost', () => {
    show('asset', 'bracelet');
    expect(text()).not.toContain('Since you bought it');
    expect(text()).toContain('Its gold since you bought it');
    // $5,380.41 now against $2,423.86 of gold at $1,922 on 1 Mar 2022.
    expect(text()).toContain('+$2,956.55 +122%');
    expect(text()).toContain('52.3 g of 18-karat gold: $2,423.86 at $1,922.00 an ounce on');
    expect(text()).toContain('$5,380.41 at $4,266.40 on');
  });

  it('lets her value count over it, and shows the metal beside it', () => {
    state.values = held([
      metalValue('g1', '2026-09-24', 538_041),
      { ...valued('v1', '2026-09-10', 800_000), asset_id: 'bracelet' },
    ]);
    show('asset', 'bracelet');
    expect(document.querySelector('.hero-value')?.textContent).toBe('$8,000.00');
    const note = text(document.querySelector('.estimate') ?? document.body);
    expect(note).toContain('Its metal alone is worth $5,380.41 at the LBMA’s price on');
    expect(note).toContain('Yours is the one that counts.');
    expect(text()).toContain('Since you bought it');
  });

  it('asks for the day she bought it', () => {
    state.assets = held([{ ...BRACELET, acquired_on: null, cost_minor: null }]);
    show('asset', 'bracelet');
    expect(text()).toContain('Say when you bought it to see this.');
  });

  it('says when no price has been read yet', () => {
    state.values = held([]);
    state.prices = held([]);
    show('asset', 'bracelet');
    expect(text()).toContain('Its value arrives with the LBMA’s next price');
  });

  it('lists the newest of its daily values, and says the rest are kept', () => {
    state.values = held([
      metalValue('g1', '2026-09-22', 530_000),
      metalValue('g2', '2026-09-23', 540_000),
      metalValue('g3', '2026-09-24', 538_041),
    ]);
    show('asset', 'bracelet');
    const values = screen.getByRole('region', { name: 'Values' });
    expect(within(values).getAllByRole('listitem')).toHaveLength(1);
    expect(text(values)).toContain('$5,380.41');
    const all = open('Remove one', 'Values');
    expect(within(all).getAllByRole('listitem')).toHaveLength(1);
    expect(text(all)).toContain('2 earlier estimates are kept too.');
  });

  it('saves a weight in grams or troy ounces, and a purity from the marks', async () => {
    updateAsset.mockResolvedValue();
    state.assets = held([{ ...BRACELET, metal: null, metal_mg: null, fineness: null }]);
    show('asset', 'bracelet');
    expect(text(screen.getByRole('region', { name: 'What it is' }))).toContain(
      'MetalNot gold or silver',
    );
    const edit = editSheet('Gold bracelet');
    expect(within(edit).queryByLabelText('Weight')).toBeNull();
    fireEvent.click(within(edit).getByRole('radio', { name: 'Gold' }));
    fireEvent.change(within(edit).getByLabelText('Weight'), { target: { value: '1.5' } });
    fireEvent.click(within(edit).getByRole('radio', { name: 'Troy ounces' }));
    fireEvent.change(within(edit).getByLabelText('Purity'), { target: { value: '999' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith(
        'bracelet',
        expect.objectContaining({ piece: { metal: 'gold', mg: 46_655, fineness: 999 } }),
      ),
    );
  });

  it('shows the weight she gave, in grams', () => {
    show('asset', 'bracelet');
    expect(text(screen.getByRole('region', { name: 'What it is' }))).toContain(
      'Metal52.3 g of 18-karat gold',
    );
    const edit = editSheet('Gold bracelet');
    expect(within(edit).getByLabelText('Weight')).toHaveProperty('value', '52.3');
    expect(within(edit).getByLabelText('Purity')).toHaveProperty('value', '750');
  });
});

describe('readDetails, for a piece of metal', () => {
  const ring = {
    name: 'Ring',
    kind: 'valuables' as const,
    acquiredOn: '',
    cost: '',
    financedBy: '',
    address: '',
    postalCode: '',
    vin: '',
    miles: '',
    metal: 'silver' as const,
    weight: '12',
    unit: 'g' as const,
    fineness: '925',
    coin: '',
    quantity: '',
  };

  it('reads all three', () => {
    expect(readDetails(ring, 'USD', '2026-09-25')).toMatchObject({
      ok: true,
      details: { piece: { metal: 'silver', mg: 12_000, fineness: 925 } },
    });
  });

  it('refuses a weight that cannot be one, or no purity', () => {
    expect(readDetails({ ...ring, weight: '' }, 'USD', '2026-09-25')).toEqual({
      ok: false,
      problem: { field: 'weight', message: 'Enter the weight in grams, like 52.3.' },
    });
    expect(readDetails({ ...ring, weight: 'x', unit: 'ozt' }, 'USD', '2026-09-25')).toEqual({
      ok: false,
      problem: { field: 'weight', message: 'Enter the weight in troy ounces, like 1.5.' },
    });
    expect(readDetails({ ...ring, fineness: '' }, 'USD', '2026-09-25')).toEqual({
      ok: false,
      problem: { field: 'fineness', message: 'Say how pure it is.' },
    });
    // A mark that belongs to the other metal is not a purity of this one.
    expect(readDetails({ ...ring, fineness: '750' }, 'USD', '2026-09-25').ok).toBe(false);
  });

  it('drops the metal from anything that is not a valuable', () => {
    expect(readDetails({ ...ring, kind: 'home' }, 'USD', '2026-09-25')).toMatchObject({
      details: { piece: null },
    });
  });
});

describe('crypto', () => {
  const REWARDS: AssetRow = {
    ...CAR,
    id: 'rewards',
    name: 'Card rewards',
    kind: 'crypto',
    acquired_on: null,
    cost_minor: null,
    financed_by: null,
    coin: 'BTC',
    coin_quantity: '0.0123',
  };

  function closed(id: string, on: string, value: string): CryptoPriceRow {
    return {
      id,
      updated_at: '2026-09-25T09:00:00+00:00',
      deleted_at: null,
      source: 'gemini',
      coin: 'BTC',
      currency: 'USD',
      price_date: on,
      price: value,
    };
  }

  function closeValue(id: string, on: string, minor: number, quantity: string): AssetValueRow {
    return {
      ...valued(id, on, minor, 'estimate'),
      asset_id: 'rewards',
      provider: 'gemini',
      coin_quantity: quantity,
    };
  }

  beforeEach(() => {
    state.assets = held([REWARDS]);
    state.values = held([closeValue('c1', '2026-09-24', 103_441, '0.0123')]);
    state.closes = held([
      closed('k1', '2026-09-23', '84384.61'),
      closed('k2', '2026-09-24', '84098'),
    ]);
  });

  it('is what she holds at Gemini’s close, with the close and its day', () => {
    show('asset', 'rewards');
    expect(document.querySelector('.hero-value')?.textContent).toBe('$1,034.41');
    expect(text(document.querySelector('.age') ?? document.body)).toContain(
      'At Gemini’s close from',
    );
    expect(text()).toContain('What you hold0.0123 BTC');
    expect(text()).toContain('$1,034.41 at $84,098.00 a coin, Gemini’s close on');
    expect(text()).toContain('Holding0.0123 BTC');
    expect(text()).not.toContain('Bought with');
    expect(text()).toContain('0.0123 BTC at Gemini’s close');
  });

  it('shows a new quantity at once, and says the counted value is the old one’s', () => {
    state.assets = held([{ ...REWARDS, coin_quantity: '0.02' }]);
    show('asset', 'rewards');
    expect(document.querySelector('.hero-value')?.textContent).toBe('$1,034.41');
    expect(text()).toContain('$1,681.96 at $84,098.00 a coin');
    expect(text()).toContain('The value above counts 0.0123 BTC.');
  });

  it('says when no close has been read for it yet', () => {
    state.values = held([]);
    state.closes = held([]);
    show('asset', 'rewards');
    expect(text()).toContain('Not valued yet. It is valued at Gemini’s close each night');
    expect(text()).toContain('Its value arrives with Gemini’s next daily close');
  });

  it('is added with a coin and a quantity, and no value of hers', async () => {
    addAsset.mockResolvedValue('new-id');
    show('new');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Card rewards' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Crypto' }));
    expect(screen.queryByLabelText('Worth now')).toBeNull();
    expect(screen.queryByRole('radio', { name: 'EUR' })).toBeNull();
    expect(screen.queryByLabelText('Bought on')).toBeNull();
    fireEvent.change(screen.getByLabelText('Coin'), { target: { value: 'btc' } });
    fireEvent.change(screen.getByLabelText('How much'), { target: { value: '0.01230' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add it' }));
    await waitFor(() =>
      expect(addAsset).toHaveBeenCalledWith(
        USER,
        {
          name: 'Card rewards',
          kind: 'crypto',
          acquiredOn: null,
          costMinor: null,
          financedBy: null,
          address: null,
          postalCode: null,
          vin: null,
          odometer: null,
          piece: null,
          holding: { coin: 'BTC', quantity: '0.0123' },
        },
        'USD',
        null,
      ),
    );
    await waitFor(() => expect(window.location.hash).toBe('#/asset/new-id'));
  });

  it('refuses a coin or a quantity that cannot be one', () => {
    show('new');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Card rewards' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Crypto' }));
    fireEvent.change(screen.getByLabelText('Coin'), { target: { value: 'B T C' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add it' }));
    expect(text()).toContain('Enter the coin as Gemini names it, like BTC.');
    fireEvent.change(screen.getByLabelText('Coin'), { target: { value: 'BTC' } });
    fireEvent.change(screen.getByLabelText('How much'), { target: { value: '0' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Add it' }));
    expect(text()).toContain('Enter how much you hold as a number, like 0.0123.');
    expect(addAsset).not.toHaveBeenCalled();
  });

  it('takes a new quantity from its edit sheet', async () => {
    updateAsset.mockResolvedValue();
    show('asset', 'rewards');
    const edit = editSheet('Card rewards');
    expect(text(edit)).toContain('a value already stored keeps the quantity it counted');
    fireEvent.change(within(edit).getByLabelText('How much'), { target: { value: '0.0200' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(updateAsset).toHaveBeenCalledWith(
        'rewards',
        expect.objectContaining({ kind: 'crypto', holding: { coin: 'BTC', quantity: '0.02' } }),
      ),
    );
  });

  it('refuses crypto in a currency other than dollars', () => {
    const draft = {
      name: 'Coins',
      kind: 'crypto' as const,
      acquiredOn: '',
      cost: '',
      financedBy: '',
      address: '',
      postalCode: '',
      vin: '',
      miles: '',
      metal: '' as const,
      weight: '',
      unit: 'g' as const,
      fineness: '',
      coin: 'BTC',
      quantity: '1',
    };
    expect(readDetails(draft, 'EUR', '2026-09-25')).toEqual({
      ok: false,
      problem: { field: 'coin', message: 'Crypto is valued in dollars, and this is in EUR.' },
    });
  });
});
