import { InvalidDimension, UnknownUnit, convertArea } from '@floorplan/geometry';
import { UnknownMaterial } from './errors.js';

const WASTE = { tile: 1.1, carpet: 1.05 };

export function estimateFlooring(area, material) {
  const value = typeof area === 'object' && area !== null ? area.area : area;
  if (!Object.hasOwn(WASTE, material)) throw new UnknownMaterial(material);
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new InvalidDimension(`Invalid area: ${value}`);
  }
  return Math.ceil(value * WASTE[material] * 2 - 1e-9) / 2;
}

const round2 = (v) => Math.round(v * 100 + 1e-9) / 100;

export function summarize(plan, system = 'metric') {
  if (system !== 'metric' && system !== 'imperial') throw new UnknownUnit(system);
  const total = plan.rooms.reduce((sum, r) => sum + r.width * r.height, 0);
  const area = round2(system === 'imperial' ? convertArea(total, 'm', 'ft') : total);
  const names = plan.rooms
    .map((r) => r.name)
    .sort((a, b) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  return { count: plan.rooms.length, totalArea: area, area, names };
}
