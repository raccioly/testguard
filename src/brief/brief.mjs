import { gate } from '../baseline/baseline.mjs';
import { summarize, formatVerdict } from '../render.mjs';

export const HEADING = '## TEST BLINDSPOT CONTEXT';
const ORDER = ['survived', 'nocover', 'unverifiable', 'fault-invalid', 'timeout', 'flaky-defender'];

/** One line the agent can act on. Names the mechanism, never just the verdict. */
export function hintFor(r) {
  const defenders = r.defenders.resolved.join(', ');
  const base = hintBase(r, defenders);
  const mocked = (r.defenders.mocking ?? []);
  const never = (r.defenders.signals ?? []).filter((s) => s.signal === 'mocked-never-asserted').map((s) => s.file);
  const extra = [
    mocked.length ? `${mocked.length} importing test${mocked.length === 1 ? '' : 's'} mock${mocked.length === 1 ? 's' : ''} the target and cannot detect this (${mocked.join(', ')})` : '',
    never.length ? `${never.join(', ')} mock${never.length === 1 ? 's' : ''} it and never assert${never.length === 1 ? 's' : ''} on it` : '',
  ].filter(Boolean);
  return extra.length ? `${base} ${extra.join('; ')}.` : base;
}

function hintBase(r, defenders) {
  switch (r.verdict) {
    case 'survived':
      return r.detail.reason === 'killed-by-undeclared-tests'
        ? `Only tests outside its declared defenders (${defenders}) catch this; fix the claim's defendedBy or move the assertion.`
        : `${defenders} stayed green with this fault applied; add an assertion that fails on it and passes on HEAD. If no test's outcome can change, first check the fault is observable at all.`;
    case 'nocover':
      return r.defenders.discovered
        ? 'No test file imports the target without mocking it; nothing defends this claim.'
        : `No test file matches ${r.defenders.requested.join(', ') || '(no defenders declared)'}; nothing defends this claim.`;
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

export function buildBrief(evidence, baseline, { max = 20, generatedAt = new Date().toISOString(), next, changes } = {}) {
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
  const kills = evidence.records.filter((r) => r.verdict === 'killed');
  const coAuthored = kills.filter((r) => r.detail.independence?.class === 'co-authored').length;
  const unclaimed = changes?.uncovered?.length ? { ref: changes.ref, files: changes.uncovered } : undefined;
  const doc = { schemaVersion: 1, tool: evidence.tool, generatedAt, head: evidence.run.repo.head, heading: HEADING, summary, ...(next ? { next: { action: next.action, command: next.command, why: next.why } } : {}), ...(unclaimed ? { unclaimed } : {}), items, text: '' };
  doc.text = renderBriefText({ ...doc, provisional: Boolean(evidence.run.provisional) }, { hasBaseline: Boolean(baseline), total: evidence.records.length, independence: kills.length ? { coAuthored, kills: kills.length } : undefined });
  return doc;
}

export function renderBriefText(brief, { hasBaseline, total, independence }) {
  const unproven = total - (brief.summary.byVerdict.killed ?? 0);
  const lines = [
    brief.heading,
    '',
    ...(brief.provisional ? ['**PROVISIONAL** — this evidence came from fewer than three confirmation runs; treat every verdict below as unconfirmed and re-probe with --confirm 3 before acting on it.', ''] : []),
    `testguard ${brief.tool.version}${brief.head ? ` @ ${brief.head.slice(0, 12)}` : ''} — ${brief.summary.claims} claims, ${total} faults probed, ${unproven} unproven` +
      (unproven === 0 ? '.' : hasBaseline ? ` (${brief.summary.new} new since baseline).` : ' (no baseline; everything is new).'),
  ];
  // Unclaimed changes come before everything else: the claim is written
  // before more code, and TestGuard is silent about unclaimed code otherwise.
  if (brief.unclaimed) {
    const n = brief.unclaimed.files.length;
    lines.push('', `UNCLAIMED CHANGES since ${brief.unclaimed.ref}: ${n} changed file${n === 1 ? '' : 's'} carr${n === 1 ? 'ies' : 'y'} no claim. State the claim first; nothing below can see this code.`);
    for (const u of brief.unclaimed.files) lines.push(`  - ${u.file} (${u.kind}) → ${u.suggestion}`);
  }
  // L3: a kill written in the same change as the code it guards is not
  // independent evidence. One line, no per-item noise.
  if (independence?.coAuthored) lines.push('', `${independence.coAuthored} of ${independence.kills} kills are co-authored with the code they defend — the test and the code were written in the same change, so those kills are not independent evidence.`);
  if (brief.next) lines.push('', `NEXT [${brief.next.action}]: ${brief.next.command}`, `  why: ${brief.next.why}`);
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

/**
 * A brief for a project that has unclaimed changes but no evidence yet. The
 * session-start hook must still tell the agent to write the claim; an empty
 * summary is honest, silence is not.
 */
export function buildUnclaimedBrief({ tool, next, changes, generatedAt = new Date().toISOString() }) {
  const summary = { claims: 0, byVerdict: {}, new: 0, baselined: 0 };
  const doc = { schemaVersion: 1, tool, generatedAt, heading: HEADING, summary, ...(next ? { next: { action: next.action, command: next.command, why: next.why } } : {}), unclaimed: { ref: changes.ref, files: changes.uncovered }, items: [], text: '' };
  const lines = [HEADING, '', `testguard ${tool.version} — no evidence yet; ${changes.uncovered.length} unclaimed changed file${changes.uncovered.length === 1 ? '' : 's'} since ${changes.ref}.`];
  lines.push('', `UNCLAIMED CHANGES since ${changes.ref}: state the claim first; nothing can be probed for this code until it has one.`);
  for (const u of changes.uncovered) lines.push(`  - ${u.file} (${u.kind}) → ${u.suggestion}`);
  if (next) lines.push('', `NEXT [${next.action}]: ${next.command}`, `  why: ${next.why}`);
  doc.text = lines.join('\n') + '\n';
  return doc;
}
