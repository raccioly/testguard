import { InvalidQuantity, UnsupportedUnit } from "./errors.ts";

export interface ConvertOptions {
  delta?: boolean;
}

export interface Plugin {
  convert(from: string, to: string, quantity: unknown, options?: ConvertOptions): number;
}

/** Rounds half away from zero; the toPrecision step removes binary float noise (0.005 * 100). */
export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  const rounded = Math.round(Number((Math.abs(value) * factor).toPrecision(12))) / factor;
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

export function checkQuantity(quantity: unknown, allowNegative = false): asserts quantity is number {
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || (!allowNegative && quantity < 0)) {
    throw new InvalidQuantity();
  }
}

/** Source is checked before target; unit names are case-sensitive. */
export function checkUnits(supported: (unit: string) => boolean, from: string, to: string): void {
  for (const unit of [from, to]) {
    if (typeof unit !== "string" || !supported(unit)) throw new UnsupportedUnit(String(unit));
  }
}

export function ratioConvert(
  ratios: Readonly<Record<string, number>>,
  digits: number,
  from: string,
  to: string,
  quantity: unknown,
): number {
  checkUnits((u) => Object.hasOwn(ratios, u), from, to);
  checkQuantity(quantity);
  return round((quantity * ratios[from]!) / ratios[to]!, digits);
}
