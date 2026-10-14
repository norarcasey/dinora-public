import type { AssetKind } from '@dinora/core/assets';
import {
  assetRowSchema,
  assetValueRowSchema,
  compareAssets,
  compareAssetValues,
} from '@dinora/core/assets';
import { compareCryptoPrices, cryptoPriceRowSchema } from '@dinora/core/crypto';
import type { Piece } from '@dinora/core/metals';
import { comparePrices, priceRowSchema } from '@dinora/core/metals';
import { parse } from '@dinora/core/parse';
import { z } from 'zod';

import { supabase } from '../supabase/client.ts';
import { defineSynced } from './synced.ts';
import { writeFailed } from './writes.ts';

/**
 * What Nora owns and what she says it is worth (ACCT-06), kept on the device like the
 * accounts, so net worth counts them with no signal. A handful of assets; Monarch's history
 * brings about 90 values, one per day a value changed.
 */
export const ASSETS = defineSynced({
  name: 'assets',
  columns:
    'id,updated_at,deleted_at,name,kind,currency,acquired_on,cost_minor,financed_by,address,postal_code,vin,odometer_miles,odometer_on,metal,metal_mg,fineness,coin,coin_quantity::text',
  schema: assetRowSchema,
  compare: compareAssets,
});

export const ASSET_VALUES = defineSynced({
  name: 'asset_values',
  columns:
    'id,updated_at,deleted_at,asset_id,valued_on,amount_minor,source,provider,low_minor,high_minor,coin_quantity::text,created_at',
  schema: assetValueRowSchema,
  compare: compareAssetValues,
});

/**
 * The LBMA's daily prices for the metals she owns (ACCT-12), kept on the device like the ECB's
 * rates, so a piece's worth and what its metal has done since she bought it show offline.
 * `price::text` for the reason `rate::text` is. About 250 rows a year per metal, and every day
 * back to a week before the oldest purchase: 1,150 for gold since March 2022.
 */
export const METAL_PRICES = defineSynced({
  name: 'metal_prices',
  columns: 'id,updated_at,deleted_at,source,metal,currency,price_date,price::text',
  schema: priceRowSchema,
  compare: comparePrices,
});

/**
 * Gemini's daily closes for the coins she holds (ACCT-21), kept on the device like the LBMA's
 * prices, so a holding's value and the close it used show offline. A row a day per coin, from
 * a month before the first night that priced it.
 */
export const CRYPTO_PRICES = defineSynced({
  name: 'crypto_prices',
  columns: 'id,updated_at,deleted_at,source,coin,currency,price_date,price::text',
  schema: cryptoPriceRowSchema,
  compare: compareCryptoPrices,
});

export type AssetDetails = {
  readonly name: string;
  readonly kind: AssetKind;
  readonly acquiredOn: string | null;
  readonly costMinor: number | null;
  readonly financedBy: string | null;
  /** What an estimate is asked with (ACCT-11): null for anything its kind does not use. */
  readonly address: string | null;
  readonly postalCode: string | null;
  readonly vin: string | null;
  readonly odometer: { readonly miles: number; readonly on: string } | null;
  /** What a piece of gold or silver is valued from (ACCT-12): null for anything else. */
  readonly piece: Piece | null;
  /**
   * What crypto she holds (ACCT-21): null for anything else. The quantity is decimal text, sent
   * as a JSON string, so PostgREST casts it to numeric with every digit.
   */
  readonly holding: { readonly coin: string; readonly quantity: string } | null;
};

function columns(details: AssetDetails) {
  return {
    name: details.name,
    kind: details.kind,
    acquired_on: details.acquiredOn,
    cost_minor: details.costMinor,
    financed_by: details.financedBy,
    address: details.address,
    postal_code: details.postalCode,
    vin: details.vin,
    odometer_miles: details.odometer?.miles ?? null,
    odometer_on: details.odometer?.on ?? null,
    metal: details.piece?.metal ?? null,
    metal_mg: details.piece?.mg ?? null,
    fineness: details.piece?.fineness ?? null,
    coin: details.holding?.coin ?? null,
    coin_quantity: details.holding?.quantity ?? null,
  };
}

/**
 * Adds an asset with its first value, and answers its id. Two requests, not one: an asset
 * whose value failed is still an asset, shown as not valued yet, and its page offers the
 * value again. Online only (PLAT-02); errors carry PostgREST's code and nothing of the row.
 * A crypto holding (ACCT-21) is added with no value: the nightly job gives it one.
 */
export async function addAsset(
  userId: string,
  details: AssetDetails,
  currency: string,
  value: { readonly valuedOn: string; readonly amountMinor: number } | null,
): Promise<string> {
  const { data, error, status } = await supabase
    .from('assets')
    .insert({ user_id: userId, currency, ...columns(details) })
    .select('id')
    .single();
  if (error !== null) throw writeFailed('the asset was not saved', error, status);
  const made = parse(z.object({ id: z.string() }), data);
  if (!made.ok) throw new Error('the asset was saved, and its id could not be read');
  if (value !== null) await addValue(userId, made.value.id, value);
  return made.value.id;
}

/** Changes what she says about it. Its currency stays: its values are in it. */
export async function updateAsset(id: string, details: AssetDetails): Promise<void> {
  const { error, status } = await supabase.from('assets').update(columns(details)).eq('id', id);
  if (error !== null) throw writeFailed('the asset was not saved', error, status);
}

/** Sold, given away, or entered by mistake. Removed, not deleted (invariant 2). */
export async function removeAsset(id: string): Promise<void> {
  const { error, status } = await supabase
    .from('assets')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error !== null) throw writeFailed('the asset was not removed', error, status);
}

/** A new value is a new row; the one before stays as history, as a card's terms do. */
export async function addValue(
  userId: string,
  assetId: string,
  value: { readonly valuedOn: string; readonly amountMinor: number },
): Promise<void> {
  const { error, status } = await supabase.from('asset_values').insert({
    user_id: userId,
    asset_id: assetId,
    valued_on: value.valuedOn,
    amount_minor: value.amountMinor,
  });
  if (error !== null) throw writeFailed('the value was not saved', error, status);
}

export async function removeValue(id: string): Promise<void> {
  const { error, status } = await supabase
    .from('asset_values')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error !== null) throw writeFailed('the value was not removed', error, status);
}
