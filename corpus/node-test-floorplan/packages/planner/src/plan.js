import { Rectangle, InvalidDimension, overlaps } from '@floorplan/geometry';
import { RoomOverlap, DuplicateRoom } from './errors.js';

export class Plan {
  constructor() {
    this.rooms = [];
  }

  placeRoom(name, position, size) {
    return placeRoom(this, name, position, size);
  }
}

export function placeRoom(plan, name, position, size) {
  const { x, y } = position;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new InvalidDimension(`Invalid position: (${x}, ${y})`);
  }
  const { width, height } = new Rectangle(size.width, size.height);
  if (plan.rooms.some((r) => r.name === name)) throw new DuplicateRoom(name);
  const room = { name, x, y, width, height };
  const hit = plan.rooms.find((r) => overlaps(room, r));
  if (hit) throw new RoomOverlap(name, hit.name);
  plan.rooms.push(room);
  return room;
}

export function fitsInLot(plan, lot, setback = 0) {
  if (typeof setback !== 'number' || !Number.isFinite(setback) || setback < 0) {
    throw new InvalidDimension(`Invalid setback: ${setback}`);
  }
  return plan.rooms.every(
    (r) =>
      r.x >= setback &&
      r.y >= setback &&
      r.x + r.width <= lot.width - setback &&
      r.y + r.height <= lot.height - setback,
  );
}
