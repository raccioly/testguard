import { label } from './price';

export function total(subtotal: number, tax: number): number {
  return subtotal + tax;
}

export function line(subtotal: number, tax: number): string {
  return label(total(subtotal, tax));
}
