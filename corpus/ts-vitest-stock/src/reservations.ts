import {
  InsufficientStock,
  InvalidQuantity,
  ReservationNotActive,
  UnknownReservation,
  UnknownSku,
} from '@/errors';

export type CustomerType = 'member' | 'guest';
export type ReservationStatus = 'active' | 'released' | 'expired';

/** Times are epoch milliseconds. */
export interface Reservation {
  id: string;
  sku: string;
  quantity: number;
  customerType: CustomerType;
  reservedAt: number;
  expiresAt: number;
  status: ReservationStatus;
}

const HOUR_MS = 3_600_000;
const LIFETIME_MS: Record<CustomerType, number> = {
  member: 48 * HOUR_MS,
  guest: 2 * HOUR_MS,
};

export function assertPositiveInteger(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new InvalidQuantity();
}

export class ReservationBook {
  protected readonly onHandBySku = new Map<string, number>();
  protected readonly reservations = new Map<string, Reservation>();
  private nextId = 1;

  protected reservedOf(sku: string): number {
    let total = 0;
    for (const r of this.reservations.values()) {
      if (r.sku === sku && r.status === 'active') total += r.quantity;
    }
    return total;
  }

  protected availableOf(sku: string): number {
    return (this.onHandBySku.get(sku) ?? 0) - this.reservedOf(sku);
  }

  reserve(sku: string, quantity: number, customerType: CustomerType, reservedAt: number): Reservation {
    assertPositiveInteger(quantity);
    if (!this.onHandBySku.has(sku)) throw new UnknownSku();
    if (quantity > this.availableOf(sku)) throw new InsufficientStock();
    const reservation: Reservation = {
      id: `RES-${this.nextId++}`,
      sku,
      quantity,
      customerType,
      reservedAt,
      expiresAt: reservedAt + LIFETIME_MS[customerType],
      status: 'active',
    };
    this.reservations.set(reservation.id, reservation);
    return { ...reservation };
  }

  release(id: string): void {
    const reservation = this.reservations.get(id);
    if (!reservation) throw new UnknownReservation();
    if (reservation.status !== 'active') throw new ReservationNotActive();
    reservation.status = 'released';
  }

  sweep(now: number): number {
    let expired = 0;
    for (const r of this.reservations.values()) {
      if (r.status === 'active' && r.expiresAt <= now) {
        r.status = 'expired';
        expired++;
      }
    }
    return expired;
  }
}
