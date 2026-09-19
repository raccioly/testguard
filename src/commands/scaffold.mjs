import { existsSync } from 'node:fs';
import { join, resolve, relative, basename, extname } from 'node:path';
import { scaffoldFile } from '../scaffold/scaffold.mjs';
import { loadClaims, defaultClaimsPath } from '../claims/load.mjs';
import { writeSpecDoc } from '../evidence/writer.mjs';
import { PreconditionError } from '../probe/worktree.mjs';

export async function scaffoldCommand({ projectDir, file, values, version }, io) {
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
  io.out('Next: replace each TODO statement, drop proposals that are not claims, then move the claims into testguard.claims.json.');
  return 0;
}
