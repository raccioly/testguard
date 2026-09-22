import { join, resolve } from 'node:path';
import { sweep, renderSweep } from '../sweep/sweep.mjs';
import { resolveChangedRef } from '../gate/changed.mjs';
import { writeSpecDoc } from '../evidence/writer.mjs';

export const sweepPath = (projectDir) => join(projectDir, '.testguard', 'sweep.json');
/**
 * A sweep's own evidence, beside the canonical one and never replacing it.
 * The next sweep reads it to learn which fault classes are productive HERE,
 * which is the feedback half of the selection Google reports taking from 15%
 * to 89% productive. Machine-proposed faults, so it is the closest observation
 * of the distribution the ranker actually orders.
 */
export const sweepEvidencePath = (projectDir) => join(projectDir, '.testguard', 'sweep-evidence.json');

/**
 * `testguard sweep [dir] --changed <ref>`: propose faults for the changed
 * source files that carry no claim, probe a bounded selection, and report what
 * a green suite did not notice.
 *
 * Exit 0 nothing survived · 1 a survivor or an untested file · 2 cannot
 * evaluate · 3 no reference.
 *
 * The sweep document goes to `.testguard/sweep.json` and NEVER to
 * `.testguard/evidence.json`. The canonical evidence is the record of what the
 * project claims; a sweep probes faults nobody stated, under TODO statements,
 * and folding one into the other would corrupt what `status` and `baseline`
 * read.
 */
export async function sweepCommand({ projectDir, values, version }, io) {
  const mode = values['save-paths'] ? 'save-paths' : 'changed';
  // `--save-paths` scans the whole write surface, so it needs no diff. The gate
  // is still computed underneath (the document reports `changed`), and HEAD is
  // a reference every repository has.
  const resolved = resolveChangedRef({ explicit: values.changed, projectDir })
    ?? (mode === 'save-paths' ? { ref: 'HEAD', from: 'save-paths', required: false } : null);
  if (!resolved) {
    io.err('sweep needs a reference to measure the change against: --changed <ref> (e.g. origin/main), or set TESTGUARD_CHANGED_REF. CI bases and a safe local remote default or differently named upstream are detected automatically. Or sweep the write surface instead with --save-paths.');
    return 3;
  }
  const confirmRuns = Number(values.confirm);
  const budgetMs = Number(values.budget);
  if (!Number.isInteger(confirmRuns) || confirmRuns < 1 || !Number.isInteger(budgetMs) || budgetMs < 1000) {
    io.err('--confirm must be a positive integer and --budget at least 1000');
    return 3;
  }
  let cap;
  if (values.cap !== undefined) {
    cap = Number(values.cap);
    if (!Number.isInteger(cap) || cap < 1) {
      io.err('--cap must be a positive integer');
      return 3;
    }
  }
  if (mode === 'changed' && !resolved.required && !values.json && !values.quiet) io.err(`sweep: comparing against ${resolved.ref} (${resolved.from})`);

  const doc = await sweep({
    projectDir,
    ref: resolved.ref,
    mode,
    includeDirty: values['include-dirty'],
    exclude: values.exclude ?? [],
    cap,
    confirmRuns,
    budgetMs,
    runnerCommand: values['runner-cmd'],
    runnerName: values.runner,
    nodeModules: values['node-modules'] ? resolve(values['node-modules']) : process.env.TESTGUARD_NODE_MODULES,
    toolVersion: version,
    claimsPath: values.claims ? resolve(values.claims) : undefined,
    ignorePath: values.ignore ? resolve(values.ignore) : undefined,
    onStage: !values.quiet && !values.json && process.stderr.isTTY
      ? ({ claimId, faultId, stage, i, n }) => process.stderr.write(`\r\x1b[K  … ${claimId}/${faultId} ${stage} ${i}/${n}`)
      : undefined,
    onWarn: (m) => { if (!values.quiet) io.err(`warning: ${m}`); },
  });
  if (process.stderr.isTTY && !values.quiet && !values.json) process.stderr.write('\r\x1b[K');

  const { evidence, ...document } = doc;
  const outPath = values.out ? resolve(values.out) : sweepPath(projectDir);
  writeSpecDoc('sweep', outPath, document);
  // Written only when something was actually probed: an empty document would
  // teach the next run that every class is unproductive.
  if (evidence?.records?.length) writeSpecDoc('evidence', sweepEvidencePath(projectDir), evidence);
  if (values.json) {
    io.out(JSON.stringify(document, null, 2));
  } else {
    io.out(renderSweep(document, { limit: Number(values.max) || 20 }));
    if (!values.quiet) io.out(`\nsweep: ${outPath}`);
  }
  return doc.exitCode;
}
