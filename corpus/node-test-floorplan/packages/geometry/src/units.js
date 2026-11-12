import { UnknownUnit } from './errors.js';

const METERS = { m: 1, cm: 0.01, ft: 0.3048, in: 0.0254 };

function factor(from, to) {
  for (const u of [from, to]) {
    if (!Object.hasOwn(METERS, u)) throw new UnknownUnit(u);
  }
  return METERS[from] / METERS[to];
}

export function round(value, places) {
  const f = 10 ** places;
  return (Math.sign(value) * Math.round(Math.abs(value) * f * (1 + 1e-12))) / f;
}

export function convertLength(value, from, to) {
  return round(value * factor(from, to), 4);
}

export function convertArea(value, from, to) {
  return round(value * factor(from, to) ** 2, 4);
}

export function overlaps(a, b) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}
