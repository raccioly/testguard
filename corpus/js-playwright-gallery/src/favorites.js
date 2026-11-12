import { makeError } from "./errors.js";

// `known` is an iterable of cards or of ids.
export function toggleFavorite(favorites, id, known) {
  const ids = new Set([...known].map((k) => (k !== null && typeof k === "object" ? k.id : k)));
  if (!ids.has(id)) throw makeError("UnknownCardId", `Unknown card id: ${id}`);
  const next = new Set(favorites);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function favoritesText(favorites) {
  return `Favorites: ${favorites.size}`;
}
