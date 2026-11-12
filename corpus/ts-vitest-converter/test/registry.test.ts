import { beforeEach, describe, it, expect, vi } from 'vitest';

// The registry caches plugins in module state, so every test starts from a fresh module graph.
async function fresh() {
  vi.resetModules();
  const registry = await import('../src/registry.ts');
  const errors = await import('../src/errors.ts');
  return { ...registry, ...errors };
}

describe('R1 lazy plugin loading and caching', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('exposes exactly the three valid categories', async () => {
    const { CATEGORIES } = await fresh();
    expect([...CATEGORIES]).toEqual(['volume', 'mass', 'temperature']);
  });

  it.each(['volume', 'mass', 'temperature'])('loads the %s plugin on request', async (category) => {
    const { getPlugin } = await fresh();
    const plugin = await getPlugin(category);
    expect(typeof plugin.convert).toBe('function');
  });

  it('loads each plugin once: repeated requests return the same load', async () => {
    const { getPlugin } = await fresh();
    const first = getPlugin('volume');
    const second = getPlugin('volume');
    expect(second).toBe(first);
    expect(await second).toBe(await first);
    expect(getPlugin('volume')).toBe(first);
  });

  it('shares one load between concurrent first requests', async () => {
    const { getPlugin } = await fresh();
    const [a, b, c] = await Promise.all([getPlugin('mass'), getPlugin('mass'), getPlugin('mass')]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('keeps categories separate: each gets its own plugin', async () => {
    const { getPlugin } = await fresh();
    const volume = await getPlugin('volume');
    const mass = await getPlugin('mass');
    const temperature = await getPlugin('temperature');
    expect(volume).not.toBe(mass);
    expect(mass).not.toBe(temperature);
    expect(volume).not.toBe(temperature);
    // Each plugin behaves as its own category.
    expect(volume.convert('cup', 'ml', 1)).toBe(240);
    expect(mass.convert('kg', 'g', 1)).toBe(1000);
    expect(temperature.convert('C', 'F', 100)).toBe(212);
  });

  it('does not load a plugin again within one registry, but a fresh registry does', async () => {
    const first = await fresh();
    const pluginA = await first.getPlugin('volume');
    expect(await first.getPlugin('volume')).toBe(pluginA);

    const second = await fresh();
    const pluginB = await second.getPlugin('volume');
    expect(pluginB).not.toBe(pluginA);
    expect(await second.getPlugin('volume')).toBe(pluginB);
  });

  it('serves convert() through the cached plugins', async () => {
    const { convert, getPlugin } = await fresh();
    const before = getPlugin('volume');
    const outcome = await convert('volume', 'cup', 'ml', 2);
    expect(outcome.result).toBe(480);
    expect(getPlugin('volume')).toBe(before);
  });
});

describe('R2 unknown categories', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects an unknown category with UnknownCategory and the exact message', async () => {
    const { getPlugin, UnknownCategory } = await fresh();
    const failure = await getPlugin('length').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(UnknownCategory);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('UnknownCategory');
    expect((failure as Error).message).toBe('Unknown category: length');
  });

  it('is case-sensitive', async () => {
    const { getPlugin } = await fresh();
    await expect(getPlugin('Volume')).rejects.toMatchObject({
      name: 'UnknownCategory',
      message: 'Unknown category: Volume',
    });
    await expect(getPlugin('MASS')).rejects.toMatchObject({
      message: 'Unknown category: MASS',
    });
  });

  it.each(['', ' volume', 'volume ', 'volumes', 'toString', '__proto__', 'constructor'])(
    'echoes the requested text exactly as given: %j',
    async (name) => {
      const { getPlugin } = await fresh();
      await expect(getPlugin(name)).rejects.toMatchObject({
        name: 'UnknownCategory',
        message: `Unknown category: ${name}`,
      });
    },
  );

  it('fails convert() with UnknownCategory too', async () => {
    const { convert } = await fresh();
    await expect(convert('length', 'm', 'km', 1)).rejects.toMatchObject({
      name: 'UnknownCategory',
      message: 'Unknown category: length',
    });
  });

  it('is not cached: a valid request after a failed one still works', async () => {
    const { getPlugin } = await fresh();
    await expect(getPlugin('length')).rejects.toMatchObject({ name: 'UnknownCategory' });
    await expect(getPlugin('length')).rejects.toMatchObject({ name: 'UnknownCategory' });
    const plugin = await getPlugin('mass');
    expect(plugin.convert('lb', 'oz', 1)).toBe(16);
  });

  it('rejects asynchronously instead of throwing synchronously', async () => {
    const { getPlugin } = await fresh();
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = getPlugin('nope');
    }).not.toThrow();
    await expect(promise).rejects.toMatchObject({ name: 'UnknownCategory' });
  });
});
