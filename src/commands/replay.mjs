import { dirname, join, resolve } from 'node:path';
import { replay, calibrationFrom, renderReplay } from '../replay/replay.mjs';
import { writeSpecDoc } from '../evidence/writer.mjs';

export const replayPath = (projectDir) => join(projectDir, '.testguard', 'replay.json');
export const calibrationPath = (projectDir) => join(projectDir, '.testguard', 'calibration.json');

export async function replayCommand({ projectDir, values, version }, io) {
  const range = values.since ?? values.changed;
  if (!range) {
    io.err('usage: testguard replay [dir] --since <range>   (e.g. --since HEAD~50..HEAD, or a tag)');
    return 3;
  }
  const confirmRuns = Number(values.confirm);
  const budgetMs = Number(values.budget);
  const limit = values.max ? Number(values.max) : undefined;
  if (!Number.isInteger(confirmRuns) || confirmRuns < 1 || !Number.isInteger(budgetMs) || budgetMs < 1000) {
    io.err('--confirm must be a positive integer and --budget at least 1000');
    return 3;
  }

  const doc = await replay({
    projectDir,
    range,
    confirmRuns,
    budgetMs,
    runnerCommand: values['runner-cmd'],
    runnerName: values.runner,
    nodeModules: values['node-modules'] ? resolve(values['node-modules']) : process.env.TESTGUARD_NODE_MODULES,
    limit,
    toolVersion: version,
    onStage: !values.quiet && !values.json && process.stderr.isTTY ? ({ commit, i, n, stage }) => process.stderr.write(`\r\x1b[K  … ${commit.slice(0, 9)} (${i}/${n}) ${stage}`) : undefined,
    onProgress: values.quiet || values.json ? undefined : () => {
      if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
    },
  });

  const outPath = values.out ? resolve(values.out) : replayPath(projectDir);
  writeSpecDoc('replay', outPath, doc);
  const calibration = calibrationFrom(doc, { toolVersion: version });
  // Beside the replay document, whatever --out says: the two are one result,
  // and splitting them across directories loses the pairing — and leaves a
  // file behind in a repository the run is only meant to read.
  const calPath = values.baseline ? resolve(values.baseline) : values.out ? join(dirname(outPath), 'calibration.json') : calibrationPath(projectDir);
  writeSpecDoc('calibration', calPath, calibration);

  if (values.json) {
    io.out(JSON.stringify({ replay: doc, calibration, paths: { replay: outPath, calibration: calPath } }, null, 2));
  } else {
    io.out(renderReplay(doc));
    io.out('');
    for (const [cls, b] of Object.entries(calibration.buckets).sort((a, b2) => b2[1].n - a[1].n)) {
      io.out(`  ${cls.padEnd(22)} missed ${String(b.positives).padStart(3)}/${String(b.n).padEnd(3)}  p=${b.p.toFixed(2)}  ci [${b.ci[0].toFixed(2)}, ${b.ci[1].toFixed(2)}]`);
    }
    if (Object.keys(calibration.buckets).length === 0) io.out('  no measurable bug in this range: nothing to calibrate from yet.');
    io.out('');
    io.out(`replay: ${outPath}`);
    io.out(`calibration: ${calPath}`);
  }
  // Replay reports; it never gates. A bug that escaped is history, not a
  // regression in this change, and a gate on history is a gate nobody can pass.
  return 0;
}
