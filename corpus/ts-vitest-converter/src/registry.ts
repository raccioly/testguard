import { record } from "./audit.ts";
import { UnknownCategory, type AuditWriteFailed } from "./errors.ts";
import type { ConvertOptions, Plugin } from "./util.ts";

export const CATEGORIES = ["volume", "mass", "temperature"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface ConversionOutcome {
  result: number;
  warning?: AuditWriteFailed;
}

// Caches the promise, so concurrent first requests share one load.
const loaded = new Map<Category, Promise<Plugin>>();

export function getPlugin(category: string): Promise<Plugin> {
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    return Promise.reject(new UnknownCategory(category));
  }
  const key = category as Category;
  let plugin = loaded.get(key);
  if (!plugin) {
    plugin = import(`./plugins/${key}.ts`) as Promise<Plugin>;
    loaded.set(key, plugin);
    plugin.catch(() => {
      if (loaded.get(key) === plugin) loaded.delete(key);
    });
  }
  return plugin;
}

export async function convert(
  category: string,
  from: string,
  to: string,
  quantity: unknown,
  options?: ConvertOptions,
): Promise<ConversionOutcome> {
  const plugin = await getPlugin(category);
  const result = plugin.convert(from, to, quantity, options);
  const warning = await record({ category, from, to, quantity: quantity as number, result });
  return warning ? { result, warning } : { result };
}
