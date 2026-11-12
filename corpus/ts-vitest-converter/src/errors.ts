export class UnknownCategory extends Error {
  override name = "UnknownCategory";
  constructor(category: string) {
    super(`Unknown category: ${category}`);
  }
}

export class UnsupportedUnit extends Error {
  override name = "UnsupportedUnit";
  constructor(unit: string) {
    super(`Unsupported unit: ${unit}`);
  }
}

export class InvalidQuantity extends Error {
  override name = "InvalidQuantity";
  constructor() {
    super("Invalid quantity");
  }
}

export class BelowAbsoluteZero extends Error {
  override name = "BelowAbsoluteZero";
  constructor() {
    super("Temperature is below absolute zero");
  }
}

export class AuditWriteFailed extends Error {
  override name = "AuditWriteFailed";
  constructor(cause?: unknown) {
    super("Audit write failed", { cause });
  }
}

export class InvalidScale extends Error {
  override name = "InvalidScale";
  constructor() {
    super("Scale must be greater than zero");
  }
}

export class UnknownSystem extends Error {
  override name = "UnknownSystem";
  constructor(system: string) {
    super(`Unknown system: ${system}`);
  }
}
