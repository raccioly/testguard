import { ratioConvert } from "../util.ts";

const GRAMS = { g: 1, kg: 1000, lb: 453.6, oz: 28.35 } as const;

export function convert(from: string, to: string, quantity: unknown): number {
  return ratioConvert(GRAMS, 1, from, to, quantity);
}
