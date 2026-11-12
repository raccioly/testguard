import { InvalidAmount, InvalidSplit, UnknownSplitType } from './errors.js';

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function validateAmount(amount) {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new InvalidAmount('amount must be a positive whole number of cents');
  }
}

function validateParticipants(participants) {
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new InvalidSplit('participants must be a non-empty list');
  }
  if (participants.some((p) => typeof p !== 'string' || p === '')) {
    throw new InvalidSplit('participant names must be non-empty strings');
  }
  if (new Set(participants).size !== participants.length) {
    throw new InvalidSplit('participants must be unique');
  }
}

function equalPortions(amount, participants) {
  const count = participants.length;
  const base = Math.floor(amount / count);
  const extra = amount % count;
  const portions = {};
  [...participants].sort(byName).forEach((name, i) => {
    portions[name] = base + (i < extra ? 1 : 0);
  });
  return portions;
}

function sharePortions(amount, participants, shares) {
  if (shares === null || typeof shares !== 'object') {
    throw new InvalidSplit('shares are required for a shares split');
  }
  const weights = participants.map((name) => {
    const w = Object.prototype.hasOwnProperty.call(shares, name) ? shares[name] : undefined;
    if (!Number.isSafeInteger(w) || w <= 0) {
      throw new InvalidSplit(`invalid share weight for ${name}`);
    }
    return BigInt(w);
  });
  const total = weights.reduce((a, b) => a + b, 0n);
  const amt = BigInt(amount);
  const rows = participants.map((name, i) => {
    const product = amt * weights[i];
    return { name, floor: product / total, rem: product % total };
  });
  let leftover = Number(amt - rows.reduce((a, r) => a + r.floor, 0n));
  rows.sort((a, b) => (a.rem === b.rem ? byName(a.name, b.name) : a.rem > b.rem ? -1 : 1));
  const portions = {};
  for (const r of rows) {
    portions[r.name] = Number(r.floor) + (leftover > 0 ? 1 : 0);
    if (leftover > 0) leftover -= 1;
  }
  return portions;
}

/** Returns { name: cents } for one expense, throwing the spec's errors on invalid input. */
export function splitExpense(expense) {
  const { amount, participants, split, shares } = expense ?? {};
  validateAmount(amount);
  if (split !== 'equal' && split !== 'shares') {
    throw new UnknownSplitType(`unknown split type: ${String(split)}`);
  }
  validateParticipants(participants);
  return split === 'equal'
    ? equalPortions(amount, participants)
    : sharePortions(amount, participants, shares);
}
