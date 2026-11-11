export class InvalidDimension extends Error {
  constructor(message = 'Invalid dimension') {
    super(message);
    this.name = 'InvalidDimension';
  }
}

export class UnknownUnit extends Error {
  constructor(unit) {
    super(`Unknown unit: ${unit}`);
    this.name = 'UnknownUnit';
  }
}
