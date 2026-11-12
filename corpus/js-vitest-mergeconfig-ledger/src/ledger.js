import { InvalidSplit } from './errors.js';
import { splitExpense } from './split.js';

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MAX_EXACT = 20;

function pick(items, sign) {
  let best = null;
  for (const it of items) {
    if (Math.sign(it.amt) !== sign) continue;
    if (!best || Math.abs(it.amt) > Math.abs(best.amt) ||
        (Math.abs(it.amt) === Math.abs(best.amt) && byName(it.name, best.name) < 0)) {
      best = it;
    }
  }
  return best;
}

function greedy(entries) {
  const items = entries.map((e) => ({ ...e }));
  const payments = [];
  for (;;) {
    const debtor = pick(items, -1);
    const creditor = pick(items, 1);
    if (!debtor || !creditor) return payments;
    const amount = Math.min(-debtor.amt, creditor.amt);
    payments.push({ payer: debtor.name, recipient: creditor.name, amount });
    debtor.amt += amount;
    creditor.amt -= amount;
  }
}

// Largest number of disjoint zero-sum groups: every group costs (size - 1) payments.
function zeroSumGroups(entries) {
  const n = entries.length;
  const size = 1 << n;
  const sum = new Float64Array(size);
  const dp = new Int32Array(size);
  for (let mask = 1; mask < size; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    sum[mask] = sum[mask & (mask - 1)] + entries[low].amt;
    let best = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) best = Math.max(best, dp[mask ^ (1 << i)]);
    }
    dp[mask] = best + (sum[mask] === 0 ? 1 : 0);
  }
  const order = [];
  for (let mask = size - 1; mask; ) {
    let pickI = -1;
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) && dp[mask ^ (1 << i)] === dp[mask] - (sum[mask] === 0 ? 1 : 0)) {
        pickI = i;
        break;
      }
    }
    order.push(pickI);
    mask ^= 1 << pickI;
  }
  order.reverse();
  const groups = [];
  let current = [];
  let running = 0;
  for (const i of order) {
    current.push(entries[i]);
    running += entries[i].amt;
    if (running === 0) {
      groups.push(current);
      current = [];
    }
  }
  return groups.sort((a, b) => byName(a[0].name, b[0].name));
}

function minimalPayments(entries) {
  const plain = greedy(entries);
  if (entries.length > MAX_EXACT) return plain;
  const groups = zeroSumGroups(entries);
  if (plain.length === entries.length - groups.length) return plain;
  return groups.flatMap((g) => greedy(g.sort((a, b) => byName(a.name, b.name))));
}

export function createLedger() {
  const expenses = [];

  return {
    record(expense) {
      const portions = splitExpense(expense);
      if (typeof expense.payer !== 'string' || expense.payer === '') {
        throw new InvalidSplit('payer must be a non-empty string');
      }
      expenses.push({ payer: expense.payer, amount: expense.amount, portions });
    },

    balances() {
      const totals = new Map();
      const add = (name, delta) => totals.set(name, (totals.get(name) ?? 0) + delta);
      for (const e of expenses) {
        add(e.payer, e.amount);
        for (const [name, cents] of Object.entries(e.portions)) add(name, -cents);
      }
      const result = {};
      for (const name of [...totals.keys()].sort(byName)) result[name] = totals.get(name) || 0;
      return result;
    },

    settleUp() {
      const entries = Object.entries(this.balances())
        .filter(([, amt]) => amt !== 0)
        .map(([name, amt]) => ({ name, amt }));
      return minimalPayments(entries);
    },
  };
}
