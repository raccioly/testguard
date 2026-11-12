import {
  MissingPrice,
  MixedCustomerTypes,
  ReservationNotActive,
  UnknownReservation,
} from '@/errors';
import { AdjustableBook } from '@/adjustments';
import type { CustomerType } from '@/reservations';

export interface PriceQuote {
  subtotal: number;
  discount: number;
  total: number;
}

const MEMBER_PERCENT = 10;
const BULK_PERCENT = 5;
const BULK_THRESHOLD = 100;

/** Integer-exact round-half-up of cents * percent / 100. */
function percentOf(cents: number, percent: number): number {
  return Math.floor((2 * cents * percent + 100) / 200);
}

export class PricedBook extends AdjustableBook {
  priceOrder(reservationIds: string[], prices: Record<string, number>): PriceQuote {
    let subtotal = 0;
    let units = 0;
    const types = new Set<CustomerType>();
    for (const id of reservationIds) {
      const r = this.reservations.get(id);
      if (!r) throw new UnknownReservation();
      if (r.status !== 'active') throw new ReservationNotActive();
      if (!Object.prototype.hasOwnProperty.call(prices, r.sku)) throw new MissingPrice();
      subtotal += r.quantity * prices[r.sku]!;
      units += r.quantity;
      types.add(r.customerType);
    }
    if (types.size > 1) throw new MixedCustomerTypes();
    let percent = types.has('member') ? MEMBER_PERCENT : 0;
    if (units >= BULK_THRESHOLD) percent += BULK_PERCENT;
    const discount = percentOf(subtotal, percent);
    return { subtotal, discount, total: subtotal - discount };
  }
}
