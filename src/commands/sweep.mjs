import { join, resolve } from 'node:path';
import { sweep, renderSweep } from '../sweep/sweep.mjs';
import { resolveChangedRef } from '../gate/changed.mjs';
import { writeSpecDoc } from '../evidence/writer.mjs';

export const sweepPath = (projectDir) => join(projectDir, '.testguard', 'sweep.json');

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
  const resolved = resolveChangedRef({ explicit: values.changed, projectDir });
  if (!resolved) {
    io.err('sweep needs a reference to measure the change against: --changed <ref> (e.g. origin/main), or set TESTGUARD_CHANGED_REF. CI bases and a safe local remote default or differently named upstream are detected automatically.');
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
  if (!resolved.required && !values.json && !values.quiet) io.err(`sweep: comparing against ${resolved.ref} (${resolved.from})`);

  const doc = await sweep({
    projectDir,
    ref: resolved.ref,
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

  const outPath = values.out ? resolve(values.out) : sweepPath(projectDir);
  writeSpecDoc('sweep', outPath, doc);
  if (values.json) {
    io.out(JSON.stringify(doc, null, 2));
  } else {
    io.out(renderSweep(doc, { limit: Number(values.max) || 20 }));
    if (!values.quiet) io.out(`\nsweep: ${outPath}`);
  }
  return doc.exitCode;
}
