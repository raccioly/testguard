import { cleanOrphans } from '../clean/orphans.mjs';
import { scratchRoot } from '../scratch-dir.mjs';
import { repoRoot } from '../git.mjs';

const KIND_NAMES = { 'scratch-tree': 'scratch tree', 'scratch-file': 'scratch file', 'stale-lock': 'stale lock', 'owner-record': 'owner record' };

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** The human report: one line per kind of thing removed, then the total. */
export function renderClean(report) {
  const verb = report.dryRun ? 'would remove' : 'removed';
  const lines = [];
  for (const kind of Object.keys(KIND_NAMES)) {
    const of = report.removed.filter((r) => r.kind === kind);
    if (!of.length) continue;
    lines.push(`${verb} ${of.length} ${KIND_NAMES[kind]}${of.length === 1 ? '' : 's'}${kind === 'scratch-tree' ? ` (${formatBytes(of.reduce((n, r) => n + (r.bytes ?? 0), 0))})` : ''}`);
    if (report.dryRun) for (const r of of) lines.push(`  ${r.path} — ${r.reason}`);
  }
  if (report.worktrees.length) {
    lines.push(`${verb} ${report.worktrees.length} stale git worktree registration${report.worktrees.length === 1 ? '' : 's'}`);
    if (report.dryRun) for (const w of report.worktrees) lines.push(`  ${w.registration}`);
  }
  for (const f of report.failed) lines.push(`could not remove ${f.path} (${f.error})`);
  if (!lines.length) lines.push(`nothing to clean under ${report.base}`);
  else lines.push(`${report.dryRun ? 'would free' : 'freed'} ${formatBytes(report.bytes)} under ${report.base}`);
  return lines.join('\n');
}

/**
 * `testguard clean [dir] [--dry-run] [--json]`: remove what interrupted runs
 * left under the scratch root — scratch trees whose owner is gone, stale
 * worker-slot and worktree locks, and the stale `git worktree` registrations
 * of this repository (#311). A live owner's tree, another host's and a young
 * tree without an owner record are never touched. Exit 0; 2 only when an
 * entry could not be removed.
 */
export async function cleanCommand({ projectDir, values }, io) {
  let root;
  try { root = repoRoot(projectDir); } catch { root = undefined; }
  const report = cleanOrphans({ base: scratchRoot(), repoRoot: root, dryRun: values['dry-run'], measure: true });
  io.out(values.json ? JSON.stringify(report, null, 2) : renderClean(report));
  return report.failed.length ? 2 : 0;
}
