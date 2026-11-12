import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Plan, placeRoom, fitsInLot } from '../src/index.js';

describe('R7 placeRoom', () => {
  test('places a room and returns it', () => {
    const plan = new Plan();
    const room = placeRoom(plan, 'Den', { x: 1, y: 2 }, { width: 3, height: 4 });
    assert.deepEqual(room, { name: 'Den', x: 1, y: 2, width: 3, height: 4 });
    assert.equal(plan.rooms.length, 1);
  });

  test('Plan#placeRoom delegates to placeRoom', () => {
    const plan = new Plan();
    plan.placeRoom('Den', { x: 0, y: 0 }, { width: 3, height: 4 });
    assert.equal(plan.rooms.length, 1);
  });

  test('overlap is rejected with RoomOverlap and exact message', () => {
    const plan = new Plan();
    placeRoom(plan, 'A', { x: 0, y: 0 }, { width: 4, height: 4 });
    assert.throws(
      () => placeRoom(plan, 'B', { x: 3, y: 0 }, { width: 2, height: 2 }),
      { name: 'RoomOverlap', message: 'Room "B" overlaps "A"' },
    );
    assert.equal(plan.rooms.length, 1);
  });

  test('message names the first overlapping room in insertion order', () => {
    const plan = new Plan();
    placeRoom(plan, 'A', { x: 0, y: 0 }, { width: 4, height: 4 });
    placeRoom(plan, 'B', { x: 4, y: 0 }, { width: 4, height: 4 });
    assert.throws(
      () => placeRoom(plan, 'C', { x: 3, y: 0 }, { width: 2, height: 2 }),
      { name: 'RoomOverlap', message: 'Room "C" overlaps "A"' },
    );
  });

  test('edge-touching rooms are allowed', () => {
    const plan = new Plan();
    placeRoom(plan, 'A', { x: 0, y: 0 }, { width: 4, height: 4 });
    placeRoom(plan, 'B', { x: 4, y: 0 }, { width: 2, height: 2 });
    assert.equal(plan.rooms.length, 2);
  });

  test('duplicate name is rejected with DuplicateRoom', () => {
    const plan = new Plan();
    placeRoom(plan, 'A', { x: 0, y: 0 }, { width: 2, height: 2 });
    assert.throws(
      () => placeRoom(plan, 'A', { x: 10, y: 10 }, { width: 2, height: 2 }),
      { name: 'DuplicateRoom' },
    );
    assert.equal(plan.rooms.length, 1);
  });

  test('invalid size is rejected with InvalidDimension', () => {
    const plan = new Plan();
    assert.throws(
      () => placeRoom(plan, 'A', { x: 0, y: 0 }, { width: 0, height: 2 }),
      { name: 'InvalidDimension' },
    );
  });
});

describe('R8 fitsInLot', () => {
  const lot = { width: 5, height: 5 };

  test('room at (0,0) 5x5 fits a 5x5 lot', () => {
    const plan = new Plan();
    placeRoom(plan, 'A', { x: 0, y: 0 }, { width: 5, height: 5 });
    assert.equal(fitsInLot(plan, lot), true);
  });

  test('room at (1,0) 5x5 does not fit a 5x5 lot', () => {
    const plan = new Plan();
    placeRoom(plan, 'A', { x: 1, y: 0 }, { width: 5, height: 5 });
    assert.equal(fitsInLot(plan, lot), false);
  });

  test('room strictly inside fits', () => {
    const plan = new Plan();
    placeRoom(plan, 'A', { x: 1, y: 1 }, { width: 2, height: 2 });
    assert.equal(fitsInLot(plan, lot), true);
  });

  test('room sticking out the top does not fit', () => {
    const plan = new Plan();
    placeRoom(plan, 'A', { x: 0, y: 1 }, { width: 2, height: 5 });
    assert.equal(fitsInLot(plan, lot), false);
  });

  test('room with negative origin does not fit', () => {
    const plan = new Plan();
    placeRoom(plan, 'A', { x: -1, y: 0 }, { width: 2, height: 2 });
    assert.equal(fitsInLot(plan, lot), false);
  });

  test('one outside room makes the whole plan not fit', () => {
    const plan = new Plan();
    placeRoom(plan, 'In', { x: 0, y: 0 }, { width: 2, height: 2 });
    placeRoom(plan, 'Out', { x: 4, y: 4 }, { width: 3, height: 3 });
    assert.equal(fitsInLot(plan, lot), false);
  });

  test('room touching the lot boundary on the far side fits', () => {
    const plan = new Plan();
    placeRoom(plan, 'A', { x: 3, y: 3 }, { width: 2, height: 2 });
    assert.equal(fitsInLot(plan, lot), true);
  });

  test('empty plan fits any lot', () => {
    assert.equal(fitsInLot(new Plan(), lot), true);
    assert.equal(fitsInLot(new Plan(), { width: 1, height: 1 }), true);
  });
});
