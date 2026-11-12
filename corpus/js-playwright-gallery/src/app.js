import { photos } from "./data.js";
import { loadCards, allTags, renderCard } from "./cards.js";
import { filterCards, statusText } from "./filter.js";
import { sortCards } from "./sort.js";
import { toggleFavorite, favoritesText } from "./favorites.js";

const $ = (id) => document.getElementById(id);
const cards = loadCards(photos);
const state = { query: "", active: new Set(), sort: "title", favorites: new Set() };

function render() {
  const visible = sortCards(filterCards(cards, state.query, state.active), state.sort);
  const grid = $("grid");
  grid.replaceChildren(...visible.map((c) => renderCard(c, state.favorites.has(c.id))));
  $("status").textContent = statusText(visible.length, cards.length);
  $("favorites").textContent = favoritesText(state.favorites);
  $("empty").hidden = visible.length !== 0;
}

function buildTagButtons() {
  const box = $("tags");
  for (const tag of allTags(cards)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = tag;
    b.dataset.tag = tag;
    b.setAttribute("aria-pressed", "false");
    box.append(b);
  }
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tag]");
    if (!b) return;
    const tag = b.dataset.tag;
    if (state.active.has(tag)) state.active.delete(tag);
    else state.active.add(tag);
    b.setAttribute("aria-pressed", String(state.active.has(tag)));
    render();
  });
}

$("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  render();
});
$("sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  render();
});
$("grid").addEventListener("click", (e) => {
  const b = e.target.closest("button.fav");
  const card = b && b.closest(".card");
  if (!card) return;
  state.favorites = toggleFavorite(state.favorites, card.dataset.id, cards);
  render();
});

$("sort").value = state.sort;
buildTagButtons();
render();
