import { makeError } from "./errors.js";

const blank = (v) => typeof v !== "string" || v.trim() === "";

export function validateCard(card) {
  const c = card ?? {};
  let field = null;
  if (blank(c.title)) field = "title";
  else if (blank(c.photographer)) field = "photographer";
  else if (!Number.isInteger(c.year) || c.year < 1826 || c.year > 2026) field = "year";
  else if (!Array.isArray(c.tags) || c.tags.some(blank)) field = "tags";
  if (field) throw makeError("InvalidCard", `Invalid card: ${field}`);
  return card;
}

export function normalizeTags(tags) {
  const seen = new Set();
  for (const t of tags) seen.add(t.trim().toLowerCase());
  return [...seen];
}

export function loadCards(raw) {
  const ids = new Set();
  return raw.map((card) => {
    validateCard(card);
    if (ids.has(card.id)) throw makeError("DuplicateCardId", `Duplicate card id: ${card.id}`);
    ids.add(card.id);
    return { ...card, tags: normalizeTags(card.tags) };
  });
}

export function allTags(cards) {
  return [...new Set(cards.flatMap((c) => c.tags))].sort();
}

export function renderCard(card, favorited, doc = document) {
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const root = el("article", "card");
  root.dataset.id = card.id;
  root.append(
    el("h3", "title", card.title),
    el("p", "photographer", `by ${card.photographer}`),
    el("p", "year", String(card.year).padStart(4, "0")),
  );
  const tags = el("div", "tags");
  for (const t of card.tags) tags.append(el("span", "tag", t));
  const fav = el("button", "fav", "Favorite");
  fav.type = "button";
  fav.setAttribute("aria-pressed", String(favorited));
  root.append(tags, fav);
  return root;
}
