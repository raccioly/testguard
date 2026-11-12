import { beforeEach, describe, it, expect, vi } from 'vitest';

vi.mock('../src/sink.ts', () => ({
  write: vi.fn(),
  now: vi.fn(),
}));

import { write, now } from '../src/sink.ts';
import { convert } from '../src/registry.ts';
import { AuditWriteFailed } from '../src/errors.ts';

const writeMock = vi.mocked(write);
const nowMock = vi.mocked(now);

beforeEach(() => {
  writeMock.mockReset();
  nowMock.mockReset();
  nowMock.mockReturnValue(1234);
});

describe('R8 one audit entry per successful conversion', () => {
  it('sends exactly one entry with every field for a volume conversion', async () => {
    const outcome = await convert('volume', 'cup', 'ml', 2);

    expect(outcome).toEqual({ result: 480 });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith({
      category: 'volume',
      from: 'cup',
      to: 'ml',
      quantity: 2,
      result: 480,
      timestamp: 1234,
    });
  });

  it('logs the input quantity and the rounded result', async () => {
    await convert('volume', 'ml', 'ml', 1.234);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith({
      category: 'volume',
      from: 'ml',
      to: 'ml',
      quantity: 1.234,
      result: 1.23,
      timestamp: 1234,
    });
  });

  it('logs mass conversions', async () => {
    await convert('mass', 'lb', 'oz', 1);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith({
      category: 'mass',
      from: 'lb',
      to: 'oz',
      quantity: 1,
      result: 16,
      timestamp: 1234,
    });
  });

  it('logs temperature conversions, including deltas', async () => {
    await convert('temperature', 'C', 'F', 100);
    await convert('temperature', 'C', 'F', 10, { delta: true });
    expect(writeMock).toHaveBeenCalledTimes(2);
    expect(writeMock).toHaveBeenNthCalledWith(1, {
      category: 'temperature',
      from: 'C',
      to: 'F',
      quantity: 100,
      result: 212,
      timestamp: 1234,
    });
    expect(writeMock).toHaveBeenNthCalledWith(2, {
      category: 'temperature',
      from: 'C',
      to: 'F',
      quantity: 10,
      result: 18,
      timestamp: 1234,
    });
  });

  it('logs a zero conversion', async () => {
    await convert('mass', 'kg', 'g', 0);
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock).toHaveBeenCalledWith({
      category: 'mass',
      from: 'kg',
      to: 'g',
      quantity: 0,
      result: 0,
      timestamp: 1234,
    });
  });

  it('takes the timestamp from the sink clock, once per entry', async () => {
    nowMock.mockReset();
    nowMock.mockReturnValueOnce(111).mockReturnValueOnce(222);

    await convert('volume', 'l', 'ml', 1);
    await convert('volume', 'l', 'ml', 2);

    expect(nowMock).toHaveBeenCalledTimes(2);
    expect(writeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ quantity: 1, timestamp: 111 }));
    expect(writeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ quantity: 2, timestamp: 222 }));
  });

  it('sends one entry per conversion across several calls', async () => {
    await convert('volume', 'cup', 'ml', 1);
    await convert('mass', 'g', 'kg', 1);
    await convert('temperature', 'F', 'C', 32);
    expect(writeMock).toHaveBeenCalledTimes(3);
  });

  it('returns no warning on success', async () => {
    const outcome = await convert('volume', 'cup', 'ml', 1);
    expect('warning' in outcome).toBe(false);
    expect(outcome.warning).toBeUndefined();
  });
});

describe('R8 failed conversions send no entry', () => {
  it('sends nothing for an unknown category', async () => {
    await expect(convert('length', 'm', 'km', 1)).rejects.toMatchObject({ name: 'UnknownCategory' });
    expect(writeMock).not.toHaveBeenCalled();
    expect(nowMock).not.toHaveBeenCalled();
  });

  it('sends nothing for an unsupported unit', async () => {
    await expect(convert('volume', 'ml', 'kg', 1)).rejects.toMatchObject({ name: 'UnsupportedUnit' });
    expect(writeMock).not.toHaveBeenCalled();
    expect(nowMock).not.toHaveBeenCalled();
  });

  it('sends nothing for an invalid quantity', async () => {
    await expect(convert('mass', 'g', 'kg', -1)).rejects.toMatchObject({ name: 'InvalidQuantity' });
    await expect(convert('mass', 'g', 'kg', Number.NaN)).rejects.toMatchObject({
      name: 'InvalidQuantity',
    });
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('sends nothing below absolute zero', async () => {
    await expect(convert('temperature', 'C', 'F', -300)).rejects.toMatchObject({
      name: 'BelowAbsoluteZero',
    });
    expect(writeMock).not.toHaveBeenCalled();
  });
});

describe('R9 sink failures', () => {
  it('still returns the result and a warning when write throws synchronously', async () => {
    const boom = new Error('disk full');
    writeMock.mockImplementation(() => {
      throw boom;
    });

    const outcome = await convert('volume', 'cup', 'ml', 2);

    expect(outcome.result).toBe(480);
    expect(outcome.warning).toBeInstanceOf(AuditWriteFailed);
    expect(outcome.warning?.name).toBe('AuditWriteFailed');
    expect(outcome.warning?.message).toBe('Audit write failed');
    expect(outcome.warning?.cause).toBe(boom);
  });

  it('handles an asynchronously rejecting sink the same way', async () => {
    const boom = new Error('network down');
    writeMock.mockRejectedValue(boom);

    const outcome = await convert('mass', 'lb', 'oz', 1);

    expect(outcome.result).toBe(16);
    expect(outcome.warning).toBeInstanceOf(AuditWriteFailed);
    expect(outcome.warning?.cause).toBe(boom);
  });

  it('never retries a failed write', async () => {
    writeMock.mockImplementation(() => {
      throw new Error('nope');
    });
    await convert('volume', 'l', 'ml', 1);
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it('reports a warning only for the failing conversion', async () => {
    writeMock.mockImplementationOnce(() => {
      throw new Error('once');
    });
    const failing = await convert('volume', 'l', 'ml', 1);
    const healthy = await convert('volume', 'l', 'ml', 2);

    expect(failing.warning).toBeInstanceOf(AuditWriteFailed);
    expect(healthy).toEqual({ result: 2000 });
    expect(writeMock).toHaveBeenCalledTimes(2);
  });

  it('does not swallow conversion errors when the sink is also broken', async () => {
    writeMock.mockImplementation(() => {
      throw new Error('nope');
    });
    await expect(convert('volume', 'ml', 'kg', 1)).rejects.toMatchObject({ name: 'UnsupportedUnit' });
  });
});
