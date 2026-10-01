import { existsSync } from 'node:fs';
import { join, resolve, relative, basename, extname } from 'node:path';
import { scaffoldFile } from '../scaffold/scaffold.mjs';
import { intentHandoff } from '../scaffold/intent.mjs';
import { loadClaims, defaultClaimsPath } from '../claims/load.mjs';
import { writeSpecDoc } from '../evidence/writer.mjs';
import { PreconditionError } from '../probe/worktree.mjs';
import { draftAppendRequest, intentInputRequest } from '../scaffold/request.mjs';
import { planIntentInput } from '../scaffold/plan-intent-input.mjs';
import { planDraftAppend } from '../scaffold/plan-append.mjs';
import { applyDraftAppend } from '../scaffold/apply-append.mjs';

export async function scaffoldCommand({ projectDir, file, files = file ? [file] : [], values, suppliedOptions = [], version }, io) {
  let input;
  try { input = intentInputRequest({ command: 'scaffold', values, suppliedOptions, files }); }
  catch (error) { io.err(error.message); return 3; }
  if (input) {
    try {
      const plan = planIntentInput({ projectDir, command: 'scaffold', values, suppliedOptions, files, toolVersion: version });
      if (values.json) io.out(plan.output.trimEnd());
      else {
        io.out(`authoring input inspection (${input.kind}); verification not performed`);
        if (input.kind === 'fix') {
          const counts = plan.doc.input.counts;
          io.out(`${counts.total} changed paths: ${counts.supported} supported, ${counts.deleted} deleted, ${counts.unsupported} unsupported, ${counts.excluded} excluded`);
        }
        io.out('Next: supply independent intent, review proposed faults, then probe. Input inspection is not verification.');
      }
      return 0;
    } catch (error) { io.err(`intent input refused: ${error.message}`); return 2; }
  }
  let append;
  try { append = draftAppendRequest({ command: 'scaffold', values, suppliedOptions, files }); }
  catch (error) { io.err(error.message); return 3; }
  if (append) {
    try {
      const request = { ...append, projectDir, toolVersion: version };
      const plan = planDraftAppend(request);
      if (values.json) {
        writeSpecDoc('claims', plan.draft.path, plan.doc, { publish: output => io.out(output.trimEnd()) });
        return 0;
      }
      const report = applyDraftAppend({ request, plan });
      if (!report.ok) {
        io.err(`draft append ${report.state}: ${report.failed.map(f => `${f.stage}: ${f.reason}`).join('; ')}; write attempted: ${report.writeAttempted}; bytes written: ${report.bytesWritten}`);
        if (report.recoveryDir) io.err(`private recovery: ${report.recoveryDir}`);
        return 2;
      }
      io.out(`unproven draft ${report.state}: ${plan.draft.path} (${plan.stats.appended} appended faults)`);
      if (report.recoveryDir) io.out(`private recovery: ${report.recoveryDir}`);
      io.out('Next: review the proposed faults against supplied intent, then probe the draft. Authoring is not verification.');
      return 0;
    } catch (error) { io.err(`draft append refused: ${error.message}`); return 2; }
  }
  if (files.length > 1) { io.err('ordinary scaffold accepts one source file; use --into for multiple sources'); return 3; }
  if (!file) {
    io.err('usage: testguard scaffold <source-file> [--claim <ID>] [--out <path>] [--json]');
    return 3;
  }
  if (values.claim?.length > 1 || values.claim?.[0]?.includes(',')) {
    io.err('scaffold accepts exactly one --claim <ID>');
    return 3;
  }
  const claimId = values.claim?.[0]?.trim();
  if (values.claim && !claimId) {
    io.err('--claim must name one claim id');
    return 3;
  }
  const abs = resolve(file);
  if (!existsSync(abs)) throw new PreconditionError(`no such file: ${file}`);
  const rel = relative(projectDir, abs);
  if (rel.startsWith('..')) throw new PreconditionError(`${file} is outside the project directory ${projectDir}`);

  const claimsPath = values.claims ? resolve(values.claims) : defaultClaimsPath(projectDir);
  const existingClaims = existsSync(claimsPath) ? loadClaims(claimsPath) : undefined;
  const { doc, stats } = scaffoldFile({ projectDir, file: rel, claimId, existingClaims, toolVersion: version });

  if (values.json) {
    io.out(JSON.stringify(doc, null, 2));
    return 0;
  }
  const outPath = values.out ? resolve(values.out) : join(projectDir, '.testguard', `scaffold-${basename(rel, extname(rel))}.json`);
  writeSpecDoc('claims', outPath, doc);
  const shapes = Object.entries(stats.byClass).map(([k, v]) => `${v} ${k}`).join(', ');
  io.out(`${stats.proposals} proposed fault${stats.proposals === 1 ? '' : 's'} in ${stats.claims} draft claim${stats.claims === 1 ? '' : 's'} for ${rel}${shapes ? ` — ${shapes}` : ''}`);
  io.out(stats.defendedBy.length ? `defendedBy prefilled from imports: ${stats.defendedBy.join(', ')}` : 'no test file imports this module; probing the draft as-is will report NOCOVER');
  io.out(`draft: ${outPath}`);
  io.out(`Next: ${intentHandoff} Replace each TODO statement, drop proposals that do not express the intended claim, then review before moving the claims into testguard.claims.json.`);
  return 0;
}
