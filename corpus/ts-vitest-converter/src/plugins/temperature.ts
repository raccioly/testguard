import { BelowAbsoluteZero } from "../errors.ts";
import { checkQuantity, checkUnits, round, type ConvertOptions } from "../util.ts";

const ABSOLUTE_ZERO = { C: -273.15, F: -459.67 } as const;

export function convert(from: string, to: string, quantity: unknown, options: ConvertOptions = {}): number {
  checkUnits((u) => u === "C" || u === "F", from, to);
  checkQuantity(quantity, true);
  const delta = options.delta === true;
  if (!delta && quantity < ABSOLUTE_ZERO[from as "C" | "F"]) throw new BelowAbsoluteZero();
  if (from === to) return round(quantity, 0);
  if (delta) return round(from === "C" ? (quantity * 9) / 5 : (quantity * 5) / 9, 0);
  return round(from === "C" ? (quantity * 9) / 5 + 32 : ((quantity - 32) * 5) / 9, 0);
}
