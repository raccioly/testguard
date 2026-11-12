export function matchesSearch(card, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (q === "") return true;
  return card.title.toLowerCase().includes(q) || card.photographer.toLowerCase().includes(q);
}

export function matchesTags(card, activeTags) {
  const active = [...(activeTags ?? [])];
  return active.every((t) => card.tags.includes(t));
}

export function filterCards(cards, query, activeTags) {
  return cards.filter((c) => matchesSearch(c, query) && matchesTags(c, activeTags));
}

export function statusText(shown, total) {
  return `Showing ${shown} of ${total} photos`;
}
