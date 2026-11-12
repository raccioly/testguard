class BookingError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidTimeError extends BookingError {}
export class InvalidRangeError extends BookingError {}
export class MalformedSlotError extends BookingError {}
export class UnknownCustomerError extends BookingError {}
export class InvalidAmountError extends BookingError {}
