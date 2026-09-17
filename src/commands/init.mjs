import { initProject } from '../init/init.mjs';

export async function initCommand({ projectDir, values }, io) {
  const r = initProject({ projectDir, force: values.force, here: values.here, ciEvidence: values['ci-evidence'], mcp: values.mcp });
  const { done, skipped, warnings, agentRoot, dir, mcpConfig } = r;
  if (values.json) {
    io.out(JSON.stringify({ done, skipped, warnings, agentRoot, dir, ...(mcpConfig ? { mcpConfig } : {}) }, null, 2));
    return warnings.length ? 1 : 0;
  }
  for (const d of done) io.out(`+ ${d}`);
  for (const s of skipped) io.out(`= ${s}`);
  for (const w of warnings) io.out(`! ${w}`);
  io.out('');
  if (dir !== '.') io.out(`Agent layer (skill, session-start hook, AGENTS.md section) installed at the git root ${agentRoot}, where agent sessions run; the project layer stays in ${dir}/. Use --here to keep everything in ${dir}/.`);
  io.out(`Agents now start with the blind-spot brief and can run \`testguard status --json${dir === '.' ? '' : ` ${dir}`}\` to learn what to do next. The hook prefers a local install and never fetches from the network.`);
  io.out(warnings.length ? 'Some written files are ignored by git — fix that before committing.' : done.length ? 'Commit these files.' : 'Nothing to change.');
  if (mcpConfig) {
    io.out('');
    io.out('MCP — five READ-ONLY tools (status, brief, claims, evidence, next_command), so the loop survives a change of harness. Nothing there runs a probe. Add ONE of these:');
    for (const [where, snippet] of Object.entries(mcpConfig)) {
      io.out('');
      io.out(`  ${where}`);
      const text = typeof snippet === 'string' ? snippet : JSON.stringify(snippet, null, 2);
      for (const line of text.split('\n')) io.out(`    ${line}`);
    }
  }
  return warnings.length ? 1 : 0;
}
