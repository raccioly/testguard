import { join, resolve } from 'node:path';
import { computeChangedGate, resolveChangedRef, renderGate, DEFAULT_EXCLUDES } from '../gate/changed.mjs';
import { writeSpecDoc } from '../evidence/writer.mjs';

export const gatePath = (projectDir) => join(projectDir, '.testguard', 'gate.json');

/**
 * `testguard gate --changed <ref>`: fail when a changed source file carries
 * no claim and no excusing ignore entry. Exit 0 covered · 1 uncovered (or
 * --strict with nothing evaluated) · 2 cannot evaluate · 3 no reference.
 */
export async function gateCommand({ projectDir, values, version }, io) {
  if (values.explain) {
    io.out('Files that are source by extension but never carry claims (excluded by default; add more with --exclude <glob>):');
    for (const g of DEFAULT_EXCLUDES) io.out(`  ${g}`);
    io.out('Non-source files (anything but .js .mjs .cjs .ts .mts .cts .jsx .tsx) are excluded before these patterns apply.');
    return 0;
  }
  const resolved = resolveChangedRef({ explicit: values.changed });
  if (!resolved) {
    io.err('gate needs a reference to measure the change against: --changed <ref> (e.g. origin/main), or set TESTGUARD_CHANGED_REF. In GitHub Actions and GitLab CI the base branch is detected automatically.');
    return 3;
  }
  const ref = resolved.ref;
  // The gate itself never degrades: a detected reference that does not resolve is exit 2 here, because the gate's whole job is the measurement.
  if (!resolved.required && !values.json && !values.quiet) io.err(`--changed not given; using ${ref} from ${resolved.from}`);
  const doc = computeChangedGate({
    projectDir,
    ref,
    includeDirty: values['include-dirty'],
    exclude: values.exclude ?? [],
    strict: values.strict,
    toolVersion: version,
    claimsPath: values.claims ? resolve(values.claims) : undefined,
    ignorePath: values.ignore ? resolve(values.ignore) : undefined,
  });
  const outPath = values.out ? resolve(values.out) : gatePath(projectDir);
  writeSpecDoc('gate', outPath, doc);
  if (values.json) {
    io.out(JSON.stringify(doc, null, 2));
  } else {
    io.out(renderGate(doc));
    if (doc.uncovered.length) io.out(`Next: state the claim for each UNCLAIMED file (scaffold proposes the faults), or add a testguard.ignore.json path entry with a reason that a reviewer will accept.`);
    if (!values.quiet) io.out(`gate: ${outPath}`);
  }
  return doc.exitCode;
}
