import { InsufficientStock, InvalidSku, UnknownSku } from '@/errors';
import { ReservationBook, assertPositiveInteger } from '@/reservations';

const SKU_PATTERN = /^[A-Z0-9-]{3,12}$/;

export class AdjustableBook extends ReservationBook {
  receive(sku: string, quantity: number): void {
    assertPositiveInteger(quantity);
    if (typeof sku !== 'string' || !SKU_PATTERN.test(sku)) throw new InvalidSku();
    this.onHandBySku.set(sku, (this.onHandBySku.get(sku) ?? 0) + quantity);
  }

  writeOff(sku: string, quantity: number): void {
    assertPositiveInteger(quantity);
    const onHand = this.onHandBySku.get(sku);
    if (onHand === undefined) throw new UnknownSku();
    if (onHand - quantity < this.reservedOf(sku)) throw new InsufficientStock();
    this.onHandBySku.set(sku, onHand - quantity);
  }
}
