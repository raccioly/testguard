import { ratioConvert } from "../util.ts";

const ML = { ml: 1, l: 1000, cup: 240, tbsp: 15, tsp: 5 } as const;

export function convert(from: string, to: string, quantity: unknown): number {
  return ratioConvert(ML, 2, from, to, quantity);
}
