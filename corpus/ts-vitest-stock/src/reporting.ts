import { InvalidFilter } from '@/errors';
import { PricedBook } from '@/pricing';

export type StockStatus = 'out' | 'low' | 'ok';

export interface StockEntry {
  sku: string;
  onHand: number;
  reserved: number;
  available: number;
  status: StockStatus;
}

export interface StockTotals {
  skuCount: number;
  onHand: number;
  reserved: number;
  available: number;
}

const STATUSES: readonly StockStatus[] = ['out', 'low', 'ok'];

function statusOf(available: number): StockStatus {
  return available === 0 ? 'out' : available < 10 ? 'low' : 'ok';
}

/** The complete warehouse: reservations, adjustments, pricing and reporting. */
export class Warehouse extends PricedBook {
  stockReport(filter?: StockStatus): StockEntry[] {
    if (filter !== undefined && !STATUSES.includes(filter)) throw new InvalidFilter();
    const entries: StockEntry[] = [];
    for (const [sku, onHand] of this.onHandBySku) {
      const reserved = this.reservedOf(sku);
      const available = onHand - reserved;
      entries.push({ sku, onHand, reserved, available, status: statusOf(available) });
    }
    return entries
      .filter((e) => filter === undefined || e.status === filter)
      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  }

  reportTotals(): StockTotals {
    const totals: StockTotals = { skuCount: 0, onHand: 0, reserved: 0, available: 0 };
    for (const e of this.stockReport()) {
      totals.skuCount++;
      totals.onHand += e.onHand;
      totals.reserved += e.reserved;
      totals.available += e.available;
    }
    return totals;
  }
}
