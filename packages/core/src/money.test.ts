import { describe, expect, it } from 'vitest';

import { minorDigits, toMinor } from './money.ts';

describe('minorDigits', () => {
  it('knows the currencies that are not two digits', () => {
    expect(minorDigits('USD')).toBe(2);
    expect(minorDigits('EUR')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
    expect(minorDigits('KWD')).toBe(3);
    expect(minorDigits('CLF')).toBe(4);
  });

  it('refuses what is not an ISO code, such as a custom currency URL', () => {
    expect(minorDigits('usd')).toBeNull();
    expect(minorDigits('https://example.test/points')).toBeNull();
    expect(minorDigits('')).toBeNull();
  });
});

describe('toMinor', () => {
  it.each([
    ['-05.50', 2, -550],
    ['00.00', 2, 0],
    ['-0.00', 2, 0],
    ['114125.51', 2, 11412551],
    ['+3.1', 2, 310],
    ['12', 2, 1200],
    ['12.', 2, 1200],
    ['  7.25 ', 2, 725],
    ['1500', 0, 1500],
    ['1.2340', 3, 1234],
    ['0.10', 2, 10],
    ['0.29', 2, 29],
  ])('%s with %i digits is %i', (text, digits, minor) => {
    expect(toMinor(text, digits)).toEqual({ ok: true, minor });
  });

  it('never yields negative zero', () => {
    const result = toMinor('-0', 2);
    expect(result.ok && Object.is(result.minor, 0)).toBe(true);
  });

  it.each(['1.005', '1,00', '', '.5', '1e3', 'NaN', '--1', '12.3.4'])(
    'refuses %j rather than rounding or guessing',
    (text) => {
      expect(toMinor(text, 2)).toEqual({ ok: false });
    },
  );

  it('refuses an amount past exact integers', () => {
    expect(toMinor('999999999999999999', 2)).toEqual({ ok: false });
  });
});
