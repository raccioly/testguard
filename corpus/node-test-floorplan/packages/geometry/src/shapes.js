import { InvalidDimension } from './errors.js';

export function requirePositive(value, label = 'dimension') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new InvalidDimension(`Invalid ${label}: ${value}`);
  }
  return value;
}

export class Rectangle {
  constructor(width, height) {
    this.width = requirePositive(width, 'width');
    this.height = requirePositive(height, 'height');
  }

  get area() {
    return this.width * this.height;
  }

  get perimeter() {
    return 2 * (this.width + this.height);
  }
}

export class LShape {
  constructor(outerWidth, outerHeight, notchWidth, notchHeight) {
    this.outerWidth = requirePositive(outerWidth, 'outer width');
    this.outerHeight = requirePositive(outerHeight, 'outer height');
    this.notchWidth = requirePositive(notchWidth, 'notch width');
    this.notchHeight = requirePositive(notchHeight, 'notch height');
    if (this.notchWidth >= this.outerWidth) {
      throw new InvalidDimension('Notch width must be less than outer width');
    }
    if (this.notchHeight >= this.outerHeight) {
      throw new InvalidDimension('Notch height must be less than outer height');
    }
  }

  get area() {
    return this.outerWidth * this.outerHeight - this.notchWidth * this.notchHeight;
  }

  get perimeter() {
    return 2 * (this.outerWidth + this.outerHeight);
  }
}
