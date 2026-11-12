export class InvalidDateError extends Error {
  constructor(input) {
    super(`Invalid date: ${input}`);
    this.name = 'InvalidDateError';
  }
}

export class FutureDateError extends Error {
  constructor(date) {
    super(`Check-in date is in the future: ${date}`);
    this.name = 'FutureDateError';
  }
}

export class ConflictError extends Error {
  constructor(date) {
    super(`Date already has a check-in: ${date}`);
    this.name = 'ConflictError';
  }
}
