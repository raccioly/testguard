import { gate } from '../baseline/baseline.mjs';
import { summarize, formatVerdict } from '../render.mjs';

export const HEADING = '## TEST BLINDSPOT CONTEXT';
const ORDER = ['survived', 'nocover', 'unverifiable', 'fault-invalid', 'timeout', 'flaky-defender'];

/** One line the agent can act on. Names the mechanism, never just the verdict. */
export function hintFor(r) {
  const defenders = r.defenders.resolved.join(', ');
  switch (r.verdict) {
    case 'survived':
      return r.detail.reason === 'killed-by-undeclared-tests'
        ? `Only tests outside its declared defenders (${defenders}) catch this; fix the claim's defendedBy or move the assertion.`
        : `${defenders} stayed green with this fault applied; add an assertion that fails on it and passes on HEAD.`;
    case 'nocover':
      return `No test file matches ${r.defenders.requested.join(', ') || '(no defenders declared)'}; nothing defends this claim.`;
    case 'unverifiable':
      return `Anchor ${r.detail.reason}; re-author fault ${r.subject.id} in the claims file before trusting this claim.`;
    case 'fault-invalid':
      return `Replacement does not load (${r.detail.reason}); fix the fault definition, not the code.`;
    case 'timeout':
      return 'Defenders time out with this fault applied; a hang is not a detection.';
    case 'flaky-defender':
      return `${defenders} not reliably green (${r.detail.reason}); fix the flake before trusting any verdict here.`;
    default:
      return '';
  }
}

function orderItems(a, b) {
  return (b.isNew - a.isNew) || (ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict)) || ((b.rank ?? 0) - (a.rank ?? 0));
}

export function buildBrief(evidence, baseline, { max = 20, generatedAt = new Date().toISOString() } = {}) {
  const g = gate(evidence.records, baseline);
  const toItem = (r, isNew) => ({
    fingerprint: r.fingerprint,
    claimId: r.claim.id,
    subjectId: r.subject.id,
    statement: r.claim.statement,
    verdict: r.verdict,
    severity: r.claim.severity,
    ...(r.subject.file ? { file: r.subject.file } : {}),
    ...(r.rank ? { rank: r.rank.score } : {}),
    hint: hintFor(r),
    isNew,
  });
  const items = [...g.new.map((r) => toItem(r, true)), ...g.belowFloor.map((r) => toItem(r, true)), ...g.baselined.map((r) => toItem(r, false))]
    .sort(orderItems)
    .slice(0, max);
  const summary = {
    claims: new Set(evidence.records.map((r) => r.claim.id)).size,
    byVerdict: summarize(evidence.records),
    new: g.new.length + g.belowFloor.length,
    baselined: g.baselined.length,
  };
  const doc = { schemaVersion: 1, tool: evidence.tool, generatedAt, head: evidence.run.repo.head, heading: HEADING, summary, items, text: '' };
  doc.text = renderBriefText(doc, { hasBaseline: Boolean(baseline), total: evidence.records.length });
  return doc;
}

export function renderBriefText(brief, { hasBaseline, total }) {
  const unproven = total - (brief.summary.byVerdict.killed ?? 0);
  const lines = [
    brief.heading,
    '',
    `testguard ${brief.tool.version}${brief.head ? ` @ ${brief.head.slice(0, 12)}` : ''} — ${brief.summary.claims} claims, ${total} faults probed, ${unproven} unproven` +
      (hasBaseline ? ` (${brief.summary.new} new since baseline).` : ' (no baseline; everything is new).'),
  ];
  if (brief.items.length === 0) {
    lines.push('', 'Every probed claim is defended. Keep it that way: new claims need a fault and a test that fails on it.');
    return lines.join('\n') + '\n';
  }
  lines.push(
    '',
    'Where the test suite is blind, ranked. A SURVIVED fault means its defenders stayed green while the claim was false.',
    'Do not close these by asserting current behaviour; write a test that fails on the described fault and passes on HEAD.',
    '',
  );
  brief.items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.isNew ? '[NEW] ' : ''}${formatVerdict(it.verdict)}  ${it.claimId}/${it.subjectId ?? '?'} (${it.severity})${it.file ? ` ${it.file}` : ''}`);
    lines.push(`   claim: ${it.statement}`);
    if (it.hint) lines.push(`   ${it.hint}`);
  });
  if (unproven > brief.items.length) lines.push('', `… and ${unproven - brief.items.length} more in the evidence file.`);
  return lines.join('\n') + '\n';
}
