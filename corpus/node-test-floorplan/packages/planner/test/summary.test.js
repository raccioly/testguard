import { test } from 'node:test';
import { Plan, placeRoom, summarize } from '../src/index.js';

test('summarize runs on a plan in metric', () => {
  const plan = new Plan();
  placeRoom(plan, 'Den', { x: 0, y: 0 }, { width: 3, height: 4 });
  placeRoom(plan, 'Attic', { x: 10, y: 0 }, { width: 2, height: 2.5 });
  summarize(plan, 'metric');
  summarize(plan);
});

test('summarize runs on a plan in imperial', () => {
  const plan = new Plan();
  placeRoom(plan, 'Den', { x: 0, y: 0 }, { width: 3, height: 4 });
  placeRoom(plan, 'attic', { x: 10, y: 0 }, { width: 2, height: 2.5 });
  placeRoom(plan, 'Bath', { x: 20, y: 0 }, { width: 1.5, height: 2 });
  summarize(plan, 'imperial');
});

test('summarize runs on an empty plan', () => {
  const plan = new Plan();
  summarize(plan, 'metric');
  summarize(plan, 'imperial');
});

test('summarize runs on a single-room plan', () => {
  const plan = new Plan();
  placeRoom(plan, 'Solo', { x: 0, y: 0 }, { width: 5, height: 5 });
  summarize(plan, 'metric');
  summarize(plan, 'imperial');
});
