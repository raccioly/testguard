import { gate } from '../baseline/baseline.mjs';
import { summarize, formatVerdict } from '../render.mjs';

export const HEADING = '## TEST BLINDSPOT CONTEXT';
/** First line of every markdown brief, so a poster can find and update its own note instead of adding another. */
export const MARKDOWN_MARKER = '<!-- testguard:brief -->';
const ORDER = ['survived', 'nocover', 'unverifiable', 'fault-invalid', 'timeout', 'flaky-defender'];

/** One line the agent can act on. Names the mechanism, never just the verdict. */
export function hintFor(r) {
  const defenders = r.defenders.resolved.join(', ');
  switch (r.verdict) {
    case 'survived':
      return r.detail.reason === 'killed-by-undeclared-tests'
        ? `Only tests outside its declared defenders (${defenders}) catch this; fix the claim's defendedBy or move the assertion.`
        : `${defenders} stayed green with this fault applied; add an assertion that fails on it and passes on HEAD. If no test's outcome can change, first check the fault is observable at all.`;
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
  const unclaimed = changes?.uncovered?.length ? { ref: changes.ref, files: changes.uncovered } : undefined;
  const doc = { schemaVersion: 1, tool: evidence.tool, generatedAt, head: evidence.run.repo.head, heading: HEADING, summary, ...(next ? { next: { action: next.action, command: next.command, why: next.why } } : {}), ...(unclaimed ? { unclaimed } : {}), items, text: '' };
  doc.text = renderBriefText({ ...doc, provisional: Boolean(evidence.run.provisional) }, { hasBaseline: Boolean(baseline), total: evidence.records.length });
  return doc;
}

export function renderBriefText(brief, { hasBaseline, total }) {
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

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/**
 * The brief as a merge-request note: same content, same order as the text —
 * unclaimed changes first, then `next`, then the ranked findings, capped at
 * `--max` — in GitLab/GitHub-flavoured markdown. Rendering only; the document
 * it renders is the validated one.
 */
export function renderBriefMarkdown(brief, { hasBaseline, total, resolved } = {}) {
  const unproven = total - (brief.summary.byVerdict.killed ?? 0);
  const lines = [MARKDOWN_MARKER, brief.heading, ''];
  if (brief.provisional) lines.push('**PROVISIONAL** — fewer than three confirmation runs; nothing below is confirmed. Re-probe with `--confirm 3`.', '');
  lines.push(`\`testguard ${brief.tool.version}${resolved ? ` (${resolved})` : ''}\`${brief.head ? ` @ \`${brief.head.slice(0, 12)}\`` : ''} — **${brief.summary.claims}** claims, **${total}** faults probed, **${unproven}** unproven` +
    (unproven === 0 ? '.' : hasBaseline ? ` (**${brief.summary.new}** new since baseline).` : ' (no baseline; everything is new).'));
  if (brief.unclaimed) {
    const n = brief.unclaimed.files.length;
    lines.push('', `### Unclaimed changes since \`${brief.unclaimed.ref}\``, '', `${n} changed file${n === 1 ? '' : 's'} carr${n === 1 ? 'ies' : 'y'} no claim. State the claim first; nothing below can see this code.`, '');
    for (const u of brief.unclaimed.files) lines.push(`- \`${u.file}\` (${u.kind}) → \`${u.suggestion}\``);
  }
  if (brief.next) lines.push('', `**Next** \`[${brief.next.action}]\`: \`${brief.next.command}\``, '', `> ${brief.next.why}`);
  if (brief.items.length === 0) {
    lines.push('', 'Every probed claim is defended. Keep it that way: new claims need a fault and a test that fails on it.');
    return lines.join('\n') + '\n';
  }
  lines.push('', 'Where the test suite is blind, ranked. A **SURVIVED** fault means its defenders stayed green while the claim was false. Do not close these by asserting current behaviour; write a test that fails on the described fault and passes on HEAD.', '');
  lines.push('| # | verdict | claim / fault | severity | file | what to do |', '|---|---|---|---|---|---|');
  brief.items.forEach((it, i) => {
    lines.push(`| ${i + 1} | ${it.isNew ? '**NEW** ' : ''}${formatVerdict(it.verdict)} | \`${cell(it.claimId)}/${cell(it.subjectId ?? '?')}\`<br>${cell(it.statement)} | ${it.severity} | ${it.file ? `\`${cell(it.file)}\`` : ''} | ${cell(it.hint)} |`);
  });
  if (unproven > brief.items.length) lines.push('', `… and ${unproven - brief.items.length} more in the evidence file.`);
  return lines.join('\n') + '\n';
}

/** Markdown for the no-evidence-yet, unclaimed-changes-only brief. */
export function renderUnclaimedMarkdown({ tool, next, changes, resolved }) {
  const lines = [MARKDOWN_MARKER, HEADING, '', `\`testguard ${tool.version}${resolved ? ` (${resolved})` : ''}\` — no evidence yet; **${changes.uncovered.length}** unclaimed changed file${changes.uncovered.length === 1 ? '' : 's'} since \`${changes.ref}\`.`, '', `### Unclaimed changes since \`${changes.ref}\``, '', 'State the claim first; nothing can be probed for this code until it has one.', ''];
  for (const u of changes.uncovered) lines.push(`- \`${u.file}\` (${u.kind}) → \`${u.suggestion}\``);
  if (next) lines.push('', `**Next** \`[${next.action}]\`: \`${next.command}\``, '', `> ${next.why}`);
  return lines.join('\n') + '\n';
}

