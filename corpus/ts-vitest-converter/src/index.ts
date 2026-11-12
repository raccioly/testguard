export { convert, getPlugin, CATEGORIES } from "./registry.ts";
export type { Category, ConversionOutcome } from "./registry.ts";
export { record } from "./audit.ts";
export type { AuditRecord } from "./audit.ts";
export { scaleRecipe } from "./scaler.ts";
export type { Ingredient, ScaleResult } from "./scaler.ts";
export type { ConvertOptions, Plugin } from "./util.ts";
export {
  AuditWriteFailed,
  BelowAbsoluteZero,
  InvalidQuantity,
  InvalidScale,
  UnknownCategory,
  UnknownSystem,
  UnsupportedUnit,
} from "./errors.ts";
