export class InvalidQuantity extends Error {
  override name = 'InvalidQuantity';
  constructor(message = 'quantity must be a positive integer') {
    super(message);
  }
}

export class UnknownSku extends Error {
  override name = 'UnknownSku';
  constructor(message = 'unknown SKU') {
    super(message);
  }
}

export class InvalidSku extends Error {
  override name = 'InvalidSku';
  constructor(message = 'SKU must be 3 to 12 characters of uppercase letters, digits or hyphens') {
    super(message);
  }
}

export class InsufficientStock extends Error {
  override name = 'InsufficientStock';
  constructor(message = 'insufficient stock') {
    super(message);
  }
}

export class UnknownReservation extends Error {
  override name = 'UnknownReservation';
  constructor(message = 'unknown reservation') {
    super(message);
  }
}

export class ReservationNotActive extends Error {
  override name = 'ReservationNotActive';
  constructor(message = 'reservation is not active') {
    super(message);
  }
}

export class MissingPrice extends Error {
  override name = 'MissingPrice';
  constructor(message = 'missing price for SKU') {
    super(message);
  }
}

export class MixedCustomerTypes extends Error {
  override name = 'MixedCustomerTypes';
  constructor(message = 'order mixes member and guest reservations') {
    super(message);
  }
}

export class InvalidFilter extends Error {
  override name = 'InvalidFilter';
  constructor(message = 'status must be one of out, low, ok') {
    super(message);
  }
}
