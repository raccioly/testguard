import { describe, it, expect } from 'vitest';
import { convert } from '../src/registry.ts';
import { verify } from './support/verify.ts';

async function check(
  category: string,
  from: string,
  to: string,
  quantity: unknown,
  expected: number,
  options?: { delta?: boolean },
): Promise<void> {
  const outcome = await convert(category, from, to, quantity, options);
  verify(outcome, { result: expected });
}

describe('R3 volume plugin', () => {
  it.each([
    ['cup', 'ml', 2, 480],
    ['l', 'ml', 1, 1000],
    ['tbsp', 'ml', 1, 15],
    ['tsp', 'ml', 1, 5],
    ['cup', 'tbsp', 1, 16],
    ['tbsp', 'tsp', 1, 3],
    ['cup', 'tsp', 1, 48],
    ['cup', 'l', 1, 0.24],
    ['ml', 'tsp', 1, 0.2],
    ['cup', 'ml', 0.5, 120],
  ])('converts 1 %s unit ratios: %s -> %s (%s) = %s', async (from, to, quantity, expected) => {
    await check('volume', from as string, to as string, quantity, expected as number);
  });

  it('rounds to 2 decimals, half away from zero', async () => {
    await check('volume', 'tsp', 'l', 1, 0.01); // 0.005 rounds up
    await check('volume', 'ml', 'l', 5, 0.01);
    await check('volume', 'tbsp', 'l', 1, 0.02); // 0.015 rounds up
    await check('volume', 'tsp', 'l', 3, 0.02);
  });

  it('rounds ordinary fractions to 2 decimals', async () => {
    await check('volume', 'tbsp', 'cup', 3, 0.19); // 0.1875
    await check('volume', 'ml', 'cup', 10, 0.04); // 0.041666
    await check('volume', 'l', 'cup', 1, 4.17);
    await check('volume', 'l', 'tbsp', 1, 66.67);
    await check('volume', 'ml', 'cup', 7, 0.03);
  });

  it('rounds same-unit conversions too', async () => {
    await check('volume', 'ml', 'ml', 1.234, 1.23);
    await check('volume', 'cup', 'cup', 3, 3);
  });

  it('rounds tiny results to 0', async () => {
    await check('volume', 'ml', 'l', 1, 0);
  });
});

describe('R4 mass plugin', () => {
  it.each([
    ['lb', 'oz', 1, 16],
    ['kg', 'g', 1, 1000],
    ['lb', 'g', 1, 453.6],
    ['lb', 'g', 2, 907.2],
    ['lb', 'kg', 1, 0.5],
    ['oz', 'lb', 16, 1],
    ['kg', 'oz', 1, 35.3],
    ['kg', 'lb', 1, 2.2],
    ['g', 'lb', 500, 1.1],
    ['g', 'oz', 100, 3.5],
    ['lb', 'kg', 2, 0.9],
  ])('converts %s -> %s (%s) = %s', async (from, to, quantity, expected) => {
    await check('mass', from as string, to as string, quantity, expected as number);
  });

  it('rounds to 1 decimal, half away from zero', async () => {
    await check('mass', 'oz', 'g', 1, 28.4); // 28.35 rounds up
    await check('mass', 'oz', 'lb', 1, 0.1); // 0.0625 -> 0.1 (0.625 rounds up at 1 decimal)
  });

  it('rounds tiny results to 0', async () => {
    await check('mass', 'g', 'kg', 0.05, 0);
    await check('mass', 'g', 'oz', 1, 0);
  });
});

describe('R5 temperature plugin', () => {
  it.each([
    ['C', 'F', 100, 212],
    ['C', 'F', 0, 32],
    ['F', 'C', 212, 100],
    ['F', 'C', 32, 0],
    ['C', 'F', -40, -40],
    ['F', 'C', -40, -40],
    ['C', 'F', 37, 99],
    ['F', 'C', 98.6, 37],
    ['F', 'C', 100, 38],
    ['F', 'C', 0, -18],
  ])('absolute %s -> %s of %s = %s', async (from, to, quantity, expected) => {
    await check('temperature', from as string, to as string, quantity, expected as number);
  });

  it('rounds absolute results half away from zero', async () => {
    await check('temperature', 'C', 'F', 2.5, 37); // 36.5 -> 37
    await check('temperature', 'C', 'F', -22.5, -9); // -8.5 -> -9
    await check('temperature', 'C', 'F', -2.5, 28); // 27.5 -> 28
  });

  it('treats the default as absolute when delta is false or absent', async () => {
    await check('temperature', 'C', 'F', 100, 212, { delta: false });
    await check('temperature', 'C', 'F', 100, 212, {});
  });

  it('converts deltas with the scale factor only (no offset)', async () => {
    await check('temperature', 'C', 'F', 10, 18, { delta: true });
    await check('temperature', 'F', 'C', 9, 5, { delta: true });
    await check('temperature', 'F', 'C', 5, 3, { delta: true }); // 2.78
    await check('temperature', 'C', 'F', 0, 0, { delta: true });
  });

  it('rounds deltas half away from zero', async () => {
    await check('temperature', 'C', 'F', 2.5, 5, { delta: true }); // 4.5
    await check('temperature', 'C', 'F', -2.5, -5, { delta: true }); // -4.5
  });

  it('has no lower bound for deltas', async () => {
    await check('temperature', 'C', 'F', -10, -18, { delta: true });
    await check('temperature', 'C', 'F', -500, -900, { delta: true });
    await check('temperature', 'F', 'C', -900, -500, { delta: true });
  });

  it('accepts the absolute-zero boundary itself', async () => {
    await check('temperature', 'C', 'F', -273.15, -460); // -459.67 F
    await check('temperature', 'F', 'C', -459.67, -273); // -273.15 C
  });

  it('fails below absolute zero with BelowAbsoluteZero', async () => {
    await expect(convert('temperature', 'C', 'F', -273.16)).rejects.toMatchObject({
      name: 'BelowAbsoluteZero',
    });
    await expect(convert('temperature', 'F', 'C', -459.68)).rejects.toMatchObject({
      name: 'BelowAbsoluteZero',
    });
  });

  it('applies the absolute-zero bound of the source unit', async () => {
    // -300 is below absolute zero in C but not in F.
    await expect(convert('temperature', 'C', 'F', -300)).rejects.toMatchObject({
      name: 'BelowAbsoluteZero',
    });
    await check('temperature', 'F', 'C', -300, -184);
  });

  it('applies the bound to same-unit absolute conversions, not to deltas', async () => {
    await expect(convert('temperature', 'C', 'C', -300)).rejects.toMatchObject({
      name: 'BelowAbsoluteZero',
    });
    await check('temperature', 'C', 'C', -300, -300, { delta: true });
  });

  it('rounds same-unit conversions to whole numbers', async () => {
    await check('temperature', 'C', 'C', 25, 25);
    await check('temperature', 'C', 'C', 25.5, 26);
  });
});

describe('R6 unsupported units', () => {
  it('rejects units of another category with the unit named', async () => {
    await expect(convert('volume', 'ml', 'kg', 1)).rejects.toMatchObject({
      name: 'UnsupportedUnit',
      message: 'Unsupported unit: kg',
    });
    await expect(convert('mass', 'ml', 'g', 1)).rejects.toMatchObject({
      message: 'Unsupported unit: ml',
    });
    await expect(convert('temperature', 'C', 'ml', 1)).rejects.toMatchObject({
      message: 'Unsupported unit: ml',
    });
  });

  it('checks the source before the target', async () => {
    await expect(convert('volume', 'xx', 'yy', 1)).rejects.toMatchObject({
      message: 'Unsupported unit: xx',
    });
    await expect(convert('volume', 'ml', 'yy', 1)).rejects.toMatchObject({
      message: 'Unsupported unit: yy',
    });
  });

  it('is case-sensitive', async () => {
    await expect(convert('volume', 'ML', 'l', 1)).rejects.toMatchObject({
      message: 'Unsupported unit: ML',
    });
    await expect(convert('mass', 'g', 'KG', 1)).rejects.toMatchObject({
      message: 'Unsupported unit: KG',
    });
    await expect(convert('temperature', 'c', 'F', 1)).rejects.toMatchObject({
      message: 'Unsupported unit: c',
    });
  });

  it('does not treat inherited object keys as units', async () => {
    await expect(convert('volume', 'toString', 'ml', 1)).rejects.toMatchObject({
      name: 'UnsupportedUnit',
      message: 'Unsupported unit: toString',
    });
  });

  it('checks units before the quantity', async () => {
    // Source behavior; the spec does not order unit vs quantity errors.
    await expect(convert('volume', 'xx', 'ml', -1)).rejects.toMatchObject({
      name: 'UnsupportedUnit',
    });
  });
});

describe('R7 invalid quantities', () => {
  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
    ['null', null],
    ['numeric string', '5'],
  ])('rejects a %s quantity in volume', async (_label, quantity) => {
    await expect(convert('volume', 'ml', 'l', quantity)).rejects.toMatchObject({
      name: 'InvalidQuantity',
      message: 'Invalid quantity',
    });
  });

  it('rejects negative and non-finite quantities in mass', async () => {
    await expect(convert('mass', 'g', 'kg', -0.1)).rejects.toMatchObject({
      name: 'InvalidQuantity',
    });
    await expect(convert('mass', 'g', 'kg', Number.NaN)).rejects.toMatchObject({
      name: 'InvalidQuantity',
    });
  });

  it('rejects non-finite or missing quantities in temperature', async () => {
    await expect(convert('temperature', 'C', 'F', Number.POSITIVE_INFINITY)).rejects.toMatchObject({
      name: 'InvalidQuantity',
      message: 'Invalid quantity',
    });
    await expect(convert('temperature', 'C', 'F', undefined)).rejects.toMatchObject({
      name: 'InvalidQuantity',
    });
    await expect(
      convert('temperature', 'C', 'F', Number.NaN, { delta: true }),
    ).rejects.toMatchObject({ name: 'InvalidQuantity' });
  });

  it('allows negative temperatures (R5)', async () => {
    await check('temperature', 'C', 'F', -10, 14);
  });

  it('treats zero as valid and converts it to 0', async () => {
    await check('volume', 'cup', 'ml', 0, 0);
    await check('mass', 'kg', 'g', 0, 0);
  });
});
