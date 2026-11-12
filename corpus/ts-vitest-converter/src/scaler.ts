import type { AuditWriteFailed } from "./errors.ts";
import { InvalidScale, UnknownSystem, UnsupportedUnit } from "./errors.ts";
import { convert } from "./registry.ts";
import { checkQuantity } from "./util.ts";

export interface Ingredient {
  name: string;
  quantity: number;
  unit: string;
}

export interface ScaleResult {
  ingredients: Ingredient[];
  warnings: AuditWriteFailed[];
}

const VOLUME = ["ml", "l", "tsp", "tbsp", "cup"];
const MASS = ["g", "kg", "oz", "lb"];
const TARGETS = {
  metric: { volume: "ml", mass: "g" },
  imperial: { volume: "cup", mass: "oz" },
} as const;

export async function scaleRecipe(
  ingredients: readonly Ingredient[],
  factor: number,
  system: string,
): Promise<ScaleResult> {
  if (!(typeof factor === "number" && factor > 0)) throw new InvalidScale();
  if (!Object.hasOwn(TARGETS, system)) throw new UnknownSystem(system);
  const target = TARGETS[system as keyof typeof TARGETS];

  // Validate everything first so a failure leaves no partial result and no audit entries.
  const plan = ingredients.map((item) => {
    const category = VOLUME.includes(item.unit) ? "volume" : MASS.includes(item.unit) ? "mass" : undefined;
    if (!category) throw new UnsupportedUnit(String(item.unit));
    const quantity = item.quantity * factor;
    checkQuantity(quantity);
    return { item, category, quantity, to: target[category] };
  });

  const scaled: Ingredient[] = [];
  const warnings: AuditWriteFailed[] = [];
  for (const { item, category, quantity, to } of plan) {
    if (item.unit === to) {
      scaled.push({ name: item.name, quantity, unit: to });
      continue;
    }
    const outcome = await convert(category, item.unit, to, quantity);
    if (outcome.warning) warnings.push(outcome.warning);
    scaled.push({ name: item.name, quantity: outcome.result, unit: to });
  }
  return { ingredients: scaled, warnings };
}
