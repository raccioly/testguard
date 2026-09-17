import { initProject } from '../init/init.mjs';

export async function initCommand({ projectDir, values }, io) {
  const { done, skipped } = initProject({ projectDir, force: values.force, ciEvidence: values['ci-evidence'] });
  if (values.json) {
    io.out(JSON.stringify({ done, skipped }, null, 2));
    return 0;
  }
  for (const d of done) io.out(`+ ${d}`);
  for (const s of skipped) io.out(`= ${s}`);
  io.out('');
  io.out('Agents in this project now start with the blind-spot brief and can run `testguard status --json` to learn what to do next.');
  io.out(done.length ? 'Commit these files.' : 'Nothing to change.');
  return 0;
}
