/**
 * The admission decision. Pure: records in, verdict out.
 *
 * A test is admitted only when every probed fault of its claim is `killed`
 * — Gate A (green on unmodified HEAD, N/N) and Gate B (fails with the fault
 * applied, N/N) are both inside `killed` by construction. Anything else
 * blocks, and the first blocking record in gate order is named so the agent
 * knows which fault to work on.
 */
const ORDER = ['survived', 'nocover', 'unverifiable', 'fault-invalid', 'timeout', 'flaky-defender'];

export function decideAdmission(records) {
  if (records.length === 0) return { admitted: false, blocking: null };
  const admitted = records.every((r) => r.verdict === 'killed');
  const blocking = admitted ? null : [...records].filter((r) => r.verdict !== 'killed').sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict))[0];
  return { admitted, blocking };
}
