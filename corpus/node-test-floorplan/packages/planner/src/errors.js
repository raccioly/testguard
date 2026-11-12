export class RoomOverlap extends Error {
  constructor(name, existing) {
    super(`Room "${name}" overlaps "${existing}"`);
    this.name = 'RoomOverlap';
  }
}

export class DuplicateRoom extends Error {
  constructor(name) {
    super(`Duplicate room: ${name}`);
    this.name = 'DuplicateRoom';
  }
}

export class UnknownMaterial extends Error {
  constructor(material) {
    super(`Unknown material: ${material}`);
    this.name = 'UnknownMaterial';
  }
}
