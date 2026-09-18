/**
 * The single Wilson interval implementation, as `fingerprint.mjs` is the
 * single fingerprint: a producer emits with it, the validator recomputes with
 * it, and "conforms" means the two agree. Before this file existed the emitter
 * and the validator had no shared arithmetic at all — the validator checked
 * that `p` sat inside `ci` and nothing else, and the spec's own example
 * carried a truncated lower bound (6/30 → 0.09, where Wilson gives 0.0950 →
 * 0.10) that nothing could notice.
 */

// Inverse normal CDF: Acklam's rational approximation, |relative error| < 1.2e-9.
// Enough to reproduce an interval to 6 decimal places, which is the most any
// producer writes (websec-validator 3, testguard 4, docguard 6).
const A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
const C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
const P_LOW = 0.02425;

/** The standard normal quantile: z such that Φ(z) = p. */
export function probit(p) {
  if (!(p > 0 && p < 1)) throw new RangeError(`probit is defined on (0, 1), got ${p}`);
  let q;
  if (p < P_LOW) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }
  if (p <= 1 - P_LOW) {
    q = p - 0.5;
    const r = q * q;
    return (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
}

/**
 * The textbook roundings of z that producers actually type. testguard and
 * docguard use 1.96; websec-validator uses the exact quantile. Across n ≤ 200
 * the two differ by at most 9.2e-6 in the interval, which can still flip a
 * rounding boundary at 4 dp — so the validator accepts either, and a document
 * never fails for having used the number in the textbook.
 */
export const CONVENTIONAL_Z = Object.freeze({ 0.9: 1.645, 0.95: 1.96, 0.99: 2.576 });

/** Every z a producer may legitimately have used for a two-sided interval at `confidence`. */
export function zCandidates(confidence) {
  const exact = probit(1 - (1 - confidence) / 2);
  const conventional = CONVENTIONAL_Z[confidence];
  return conventional === undefined ? [exact] : [exact, conventional];
}

/**
 * Wilson score interval for `positives` in `n`, unrounded, clamped to [0, 1].
 * Wilson rather than the normal approximation because it stays sane at small
 * n and extreme p — exactly the regime a young corpus is in. n = 0 is maximal
 * ignorance: [0, 1].
 */
export function wilsonInterval(positives, n, z) {
  if (n === 0) return [0, 1];
  const p = positives / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Round half away from zero to `places` decimals — what `toFixed` does on the value's binary form. */
export const roundTo = (x, places) => Number(x.toFixed(places));

/**
 * How many decimal places a parsed JSON number still shows. Parsing drops
 * trailing zeros (0.10 → 0.1), so a single value under-reports; the validator
 * takes the maximum across a document, which is the precision the producer
 * wrote at as long as at least one value did not end in zero.
 */
export function decimals(x) {
  if (!Number.isFinite(x)) return 0;
  const s = String(x);
  const e = s.indexOf('e-');
  if (e !== -1) {
    const mantissa = s.slice(0, e);
    const dot = mantissa.indexOf('.');
    return Number(s.slice(e + 2)) + (dot === -1 ? 0 : mantissa.length - dot - 1);
  }
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** The most decimal places the validator will hold a document to; beyond it the quantile approximation is the noise. */
export const MAX_PLACES = 6;

const near = (a, b) => Math.abs(a - b) < 1e-9;

/**
 * Does a cell's declared `p` and `ci` reproduce from its own `n` and
 * `positives`? Everything is compared after rounding to `places` — the
 * precision the document wrote at — so a producer at 3 dp and one at 4 dp
 * both reproduce, and a truncated bound does not. A `p` of `null` is a cell
 * that declines to give a point estimate; only its interval is checked.
 */
export function reproduces(cell, { confidence, places }) {
  const { n, positives, p, ci } = cell;
  const pl = Math.min(places, MAX_PLACES);
  const expectedP = n === 0 ? null : roundTo(positives / n, pl);
  const candidates = zCandidates(confidence).map((z) => wilsonInterval(positives, n, z).map((v) => roundTo(v, pl)));
  return {
    p: p === null || n === 0 || near(expectedP, p),
    ci: candidates.some(([lo, hi]) => near(lo, ci[0]) && near(hi, ci[1])),
    expected: { p: expectedP, ci: candidates[0] },
  };
}
