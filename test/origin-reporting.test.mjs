import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeStatus, renderStatus } from '../src/status/status.mjs';
import { buildBrief, renderBriefMarkdown } from '../src/brief/brief.mjs';
import { renderSummary } from '../src/render.mjs';
import { probe } from '../src/probe/probe.mjs';
import { writeSpecDoc } from '../src/evidence/writer.mjs';
import { validate } from '../spec/lib/validate.mjs';
import { fingerprint } from '../spec/lib/fingerprint.mjs';
import { hashFile } from '../src/util/hash.mjs';
import { main } from '../src/cli.mjs';

const example = JSON.parse(readFileSync(new URL('../spec/conformance/examples/evidence.json', import.meta.url), 'utf8'));
const caveat = 'declared origins, not authenticated independence';
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-origin-report-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/value.mjs'), 'export const value = 1;\n');
  const claims = { schemaVersion: 1, claims: [{ id: 'C-1', statement: 'Value is one.', severity: 'high', source: { kind: 'incident', ref: 'private-ref-not-echoed' }, producedBy: { producer: 'agent' }, defendedBy: ['test/missing.test.mjs'], faults: [2, 3].map((n) => ({ id: `F${n}`, description: 'Value is changed.', faultClass: 'other', file: 'src/value.mjs', find: 'value = 1', replace: `value = ${n}`, producedBy: { producer: 'agent' } })) }] };
  writeFileSync(join(dir, 'testguard.claims.json'), JSON.stringify(claims));
  return { dir, claims };
}

it('status counts current declarations before evidence and retains them when recorded labels are stale', () => {
  const { dir, claims } = project();
  try {
    const initial = computeStatus({ projectDir: dir });
    expect(initial.state).toBe('unprobed'); expect(initial.next.action).toBe('probe');
    expect(initial.origins).toMatchObject({ basis: 'declared', claims: { total: 1, mixed: 0, byKind: { incident: 1 } } });
    expect(initial.origins).not.toHaveProperty('records');
    const records = claims.claims[0].faults.map((f) => ({ fingerprint: fingerprint({ claimId: 'C-1', subjectId: f.id, file: f.file, verdict: 'nocover' }), claim: { id: 'C-1', statement: claims.claims[0].statement, severity: 'high', source: { kind: 'comment' } }, subject: { kind: 'fault', id: f.id, file: f.file, faultClass: 'other' }, verdict: 'nocover', detail: { baselineRuns: [], probeRuns: [] }, defenders: { requested: ['test/missing.test.mjs'], resolved: [], nocover: true }, inputs: { targetHash: hashFile(join(dir, f.file)), defenderHashes: {} } }));
    writeSpecDoc('evidence', join(dir, '.testguard/evidence.json'), { schemaVersion: 1, tool: { name: 'testguard', version: 'test' }, run: { id: 'R-1', startedAt: '2026-10-01T00:00:00Z', repo: { head: 'a'.repeat(40), dirty: false }, confirmRuns: 3, mode: 'worktree' }, records });
    const stale = computeStatus({ projectDir: dir });
    expect(stale.state).toBe('evidence-stale'); expect(stale.next.action).toBe('probe');
    expect(stale.origins).toEqual(initial.origins);
    expect(validate('status', stale).errors).toEqual([]);
    expect(renderStatus(stale)).toContain(caveat);
    expect(renderStatus(stale)).toContain('incident: 1');
    expect(renderStatus(stale)).not.toContain('private-ref-not-echoed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('brief and human probe summaries include all recorded origins before caps and baseline filtering', () => {
  const evidence = structuredClone(example);
  evidence.records[0].claim.source = { kind: 'bug', ref: 'private-ref-not-echoed' };
  const before = JSON.stringify(evidence);
  const baseline = { fingerprints: Object.fromEntries(evidence.records.map((r) => [r.fingerprint, 1])) };
  const brief = buildBrief(evidence, baseline, { max: 0 });
  expect(brief.items).toEqual([]);
  expect(brief.origins).toMatchObject({ basis: 'recorded', claims: { total: 2, mixed: 1 }, records: { total: evidence.records.length, byKind: { bug: 1 } } });
  expect(validate('brief', brief).errors).toEqual([]);
  for (const text of [brief.text, renderBriefMarkdown(brief, { hasBaseline: true, total: evidence.records.length }), renderSummary(evidence.records, evidence.run)]) {
    expect(text).toContain(caveat); expect(text).toContain('mixed: 1');
    expect(text).toContain(`${evidence.records.length} records`);
    expect(text).not.toContain('private-ref-not-echoed');
  }
  expect(JSON.stringify(evidence)).toBe(before);
});

it('actual probe writes a recorded summary for its full selected record universe, including nocover', async () => {
  const { dir, claims } = project();
  try {
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'test/unrelated.test.mjs'), "import { it, expect } from 'vitest'; it('unrelated', () => expect(1).toBe(1));\n");
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'fixture']]) {
      const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw Error(r.stderr);
    }
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const evidence = await probe({ projectDir: dir, claims, mode: 'in-place', confirmRuns: 3, serial: true, escalate: false, budgetMs: 30000 });
    expect(evidence.records.map((r) => r.verdict)).toEqual(['nocover', 'nocover']);
    expect(evidence.origins).toMatchObject({ basis: 'recorded', claims: { total: 1, mixed: 0, byKind: { incident: 1 } }, records: { total: 2, byKind: { incident: 2 } } });
    expect(validate('evidence', evidence).errors).toEqual([]);
    expect(readFileSync(join(dir, 'src/value.mjs'), 'utf8')).toBe('export const value = 1;\n');
    const custom = structuredClone(claims);
    custom.claims[0].source.kind = 'bug';
    const customPath = join(dir, 'selected.claims.json');
    writeFileSync(customPath, JSON.stringify(custom));
    const out = [], err = [];
    const code = await main(['probe', dir, '--claims', customPath, '--json', '--in-place', '--serial', '--no-escalate', '--no-reuse'], { out: (s) => out.push(s), err: (s) => err.push(s) });
    expect(code, err.join('\n')).toBe(1); // Both faults remain nocover; reporting never waives them.
    const status = JSON.parse(out.join('\n'));
    expect(status.origins).toMatchObject({ basis: 'declared', claims: { total: 1, byKind: { bug: 1, incident: 0 } } });
    expect(status.paths.claims).toBe('selected.claims.json');
    expect(validate('status', status).errors).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);
