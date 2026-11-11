export function applyDiscount(cents: number, percent: number): number {
  return Math.round((cents * (100 - percent)) / 100);
}

export function label(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
