import { describe, it, expect } from 'vitest';
import { scaleRecipe } from '../src/scaler.ts';

describe('R10-R11 scaling to metric', () => {
  it('scales then converts: 2 lb flour x 0.5 = 453.6 g', async () => {
    const result = await scaleRecipe([{ name: 'flour', quantity: 2, unit: 'lb' }], 0.5, 'metric');
    expect(result).toEqual({
      ingredients: [{ name: 'flour', quantity: 453.6, unit: 'g' }],
      warnings: [],
    });
  });

  it('converts volumes to ml', async () => {
    const result = await scaleRecipe(
      [
        { name: 'milk', quantity: 1, unit: 'cup' },
        { name: 'oil', quantity: 2, unit: 'tbsp' },
        { name: 'vanilla', quantity: 1, unit: 'tsp' },
        { name: 'water', quantity: 1, unit: 'l' },
      ],
      2,
      'metric',
    );
    expect(result.ingredients).toEqual([
      { name: 'milk', quantity: 480, unit: 'ml' },
      { name: 'oil', quantity: 60, unit: 'ml' },
      { name: 'vanilla', quantity: 10, unit: 'ml' },
      { name: 'water', quantity: 2000, unit: 'ml' },
    ]);
  });

  it('converts masses to g', async () => {
    const result = await scaleRecipe(
      [
        { name: 'sugar', quantity: 0.5, unit: 'kg' },
        { name: 'butter', quantity: 1, unit: 'lb' },
      ],
      3,
      'metric',
    );
    expect(result.ingredients).toEqual([
      { name: 'sugar', quantity: 1500, unit: 'g' },
      { name: 'butter', quantity: 1360.8, unit: 'g' },
    ]);
  });

  it('applies the multiplier first and rounds only the final result', async () => {
    // 3 oz = 85.05 g -> 85.1; rounding 1 oz first (28.4) and multiplying would give 85.2.
    const result = await scaleRecipe([{ name: 'cheese', quantity: 1, unit: 'oz' }], 3, 'metric');
    expect(result.ingredients).toEqual([{ name: 'cheese', quantity: 85.1, unit: 'g' }]);
  });

  it('scales but does not convert ingredients already in the target unit', async () => {
    const result = await scaleRecipe(
      [
        { name: 'broth', quantity: 100, unit: 'ml' },
        { name: 'salt', quantity: 1.25, unit: 'g' },
      ],
      2,
      'metric',
    );
    expect(result.ingredients).toEqual([
      { name: 'broth', quantity: 200, unit: 'ml' },
      { name: 'salt', quantity: 2.5, unit: 'g' },
    ]);
  });

  it('keeps ingredient order and names', async () => {
    const result = await scaleRecipe(
      [
        { name: 'b', quantity: 1, unit: 'g' },
        { name: 'a', quantity: 1, unit: 'cup' },
      ],
      1,
      'metric',
    );
    expect(result.ingredients.map((i) => i.name)).toEqual(['b', 'a']);
  });

  it('returns an empty result for an empty ingredient list', async () => {
    expect(await scaleRecipe([], 2, 'metric')).toEqual({ ingredients: [], warnings: [] });
  });
});

describe('R10 InvalidScale', () => {
  it.each([0, -1, -0.5, Number.NaN])('rejects scale factor %s', async (factor) => {
    await expect(
      scaleRecipe([{ name: 'flour', quantity: 1, unit: 'lb' }], factor, 'metric'),
    ).rejects.toMatchObject({
      name: 'InvalidScale',
      message: 'Scale must be greater than zero',
    });
  });

  it('checks the scale before the target system', async () => {
    // Source behavior; the spec does not order these two errors.
    await expect(scaleRecipe([], 0, 'us')).rejects.toMatchObject({ name: 'InvalidScale' });
  });
});

describe('R11 UnknownSystem', () => {
  it.each(['us', 'Metric', 'METRIC', '', 'toString', '__proto__'])(
    'rejects target system %j',
    async (system) => {
      await expect(
        scaleRecipe([{ name: 'flour', quantity: 1, unit: 'lb' }], 1, system),
      ).rejects.toMatchObject({
        name: 'UnknownSystem',
        message: `Unknown system: ${system}`,
      });
    },
  );
});

describe('R11 UnsupportedUnit', () => {
  it('fails the whole call and returns no partial result', async () => {
    const call = scaleRecipe(
      [
        { name: 'flour', quantity: 1, unit: 'lb' },
        { name: 'spice', quantity: 1, unit: 'pinch' },
        { name: 'milk', quantity: 1, unit: 'cup' },
      ],
      1,
      'metric',
    );
    await expect(call).rejects.toMatchObject({
      name: 'UnsupportedUnit',
      message: 'Unsupported unit: pinch',
    });
  });

  it('is case-sensitive about unit names', async () => {
    await expect(
      scaleRecipe([{ name: 'milk', quantity: 1, unit: 'ML' }], 1, 'metric'),
    ).rejects.toMatchObject({ name: 'UnsupportedUnit', message: 'Unsupported unit: ML' });
  });

  it('rejects units from other categories such as temperature', async () => {
    await expect(
      scaleRecipe([{ name: 'oven', quantity: 200, unit: 'C' }], 1, 'metric'),
    ).rejects.toMatchObject({ name: 'UnsupportedUnit', message: 'Unsupported unit: C' });
  });
});
