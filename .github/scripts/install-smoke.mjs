#!/usr/bin/env node
/**
 * Prove the package works AS INSTALLED, not as checked out: pack it, install
 * the tarball into a scratch project with production dependencies only, and
 * run the CLI from there. This is the gate that would have caught 0.1.0,
 * which shipped with its schema validator's dependency declared as a
 * devDependency and crashed on startup for every npm/npx/pip/brew user.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, cpSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[1], '..', '..', '..');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const scratch = mkdtempSync(join(tmpdir(), 'testguard-install-smoke-'));
const annotationRecovery = [];
try {
  const packDir = join(scratch, 'pack');
  mkdirSync(packDir);
  run(npm, ['pack', '--pack-destination', packDir, '--ignore-scripts'], root);
  const tgz = join(packDir, readdirSync(packDir).find((f) => f.endsWith('.tgz')));

  const consumer = join(scratch, 'consumer');
  cpSync(join(root, 'fixtures', 'known-answer'), consumer, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
  run(npm, ['init', '-y'], consumer);
  run(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', tgz], consumer);

  const bin = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'testguard.cmd' : 'testguard');
  const version = run(bin, ['--version'], consumer).trim();
  const emptyProject = join(scratch, 'empty-adoption');
  mkdirSync(emptyProject);
  writeFileSync(join(emptyProject, 'testguard.claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }));
  const emptyStatus = JSON.parse(run(bin, ['probe', emptyProject, '--allow-empty', '--json'], consumer));
  if (emptyStatus.state !== 'no-claims' || emptyStatus.run || existsSync(join(emptyProject, '.testguard', 'evidence.json'))) throw new Error('installed empty-adoption probe invented verification evidence');
  const replayHelp = run(bin, ['replay', '--help'], consumer);
  if (!replayHelp.includes('--since') || replayHelp.includes('--node-modules')) throw new Error('installed command help is not command-specific');
  writeFileSync(join(emptyProject, 'vite.config.mjs'), "export default { base: '/', plugins: [{ configureServer(s) { s.middlewares.use('/__rooms', () => {}); const parts = '/__room'.split('/'); } }] };\n");
  const installedDiscovery = join(consumer, 'node_modules', 'testguard-cli', 'src', 'probe', 'runners', 'discovery.mjs');
  run(process.execPath, ['--input-type=module', '-e',
    "import { pathToFileURL } from 'node:url'; const { hashDiscoveryConfigs } = await import(pathToFileURL(process.argv[1])); hashDiscoveryConfigs(process.argv[2], ['vite.config.mjs']);",
    installedDiscovery, emptyProject,
  ], consumer);
  const installedRunner = join(consumer, 'node_modules', 'testguard-cli', 'src', 'probe', 'runners', 'shared.mjs');
  run(process.execPath, ['--input-type=module', '-e',
    `import { pathToFileURL } from 'node:url'; const { parseReport } = await import(pathToFileURL(process.argv[1]));
     const result = parseReport({ success: false, numTotalTests: 2, numFailedTests: 2, testResults: [{ name: 'test.mjs', status: 'failed', assertionResults: [
       { status: 'failed', failureMessages: ['AssertionError: expected /specify timed out/'] },
       { status: 'failed', failureMessages: ['Error: Test timed out in 1000ms.'] },
     ] }] }, 1);
     if (result.timeouts !== 1 || result.run.assertionFailures !== 1) throw new Error('installed runner confuses assertion text with timeout identity');`,
    installedRunner,
  ], consumer);
  const claims = run(bin, ['claims', '.'], consumer);
  const draft = JSON.parse(run(bin, ['scaffold', 'src/redact.mjs', '--json'], consumer));
  const installedValidator = join(consumer, 'node_modules', 'testguard-cli', 'spec', 'lib', 'validate.mjs');
  run(process.execPath, ['--input-type=module', '-e',
    `import { pathToFileURL } from 'node:url';
     const { intentInputRequest } = await import(new URL('../../src/scaffold/request.mjs', pathToFileURL(process.argv[1])));
     const doc = intentInputRequest({ command: 'scaffold', values: { 'from-document': ['requirements.md'] }, suppliedOptions: ['from-document', 'json'] });
     if (JSON.stringify(doc) !== JSON.stringify({ kind: 'document', file: 'requirements.md' }) || !Object.isFrozen(doc)) throw new Error('installed intent request promotes or mutates input');
     let refused = false;
     try { intentInputRequest({ command: 'scaffold', values: { 'from-fix': ['HEAD'] } }); } catch (error) { refused = /full-object-id/.test(error.message); }
     if (!refused) throw new Error('installed intent request accepts symbolic fix reference');`,
    installedValidator,
  ], consumer);
  const fixProject = join(scratch, 'fix-input');
  mkdirSync(fixProject);
  const fixGit = args => run('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', `core.hooksPath=${devNull}`, ...args], fixProject).trim();
  fixGit(['init', '-q']);
  writeFileSync(join(fixProject, 'guard.mjs'), 'export const x = 1;');
  mkdirSync(join(fixProject, 'child'));
  writeFileSync(join(fixProject, 'child', 'testguard.claims.json'), 'untrusted historical marker');
  fixGit(['add', '.']); fixGit(['commit', '-qm', 'Initial fixture']);
  const fixParent = fixGit(['rev-parse', 'HEAD']);
  writeFileSync(join(fixProject, 'guard.mjs'), 'export const x = 2;');
  fixGit(['add', '.']); fixGit(['commit', '-qm', 'Supplied fix metadata']);
  const fixCommit = fixGit(['rev-parse', 'HEAD']);
  writeFileSync(join(fixProject, 'placeholder.mjs'), 'export function guard(x) {\n if (!x) return false;\n}\n');
  const placeholderDraft = JSON.parse(run(bin, ['scaffold', 'placeholder.mjs', '--json'], fixProject));
  if (!placeholderDraft.claims.length || placeholderDraft.claims.some(claim => !/^TODO-CLAIM-[1-9][0-9]*$/.test(claim.id))) throw new Error('installed scaffold still emits finished file-derived default IDs');
  const rootInputCli = JSON.parse(run(bin, ['scaffold', '--from-fix', fixCommit, '--json'], fixProject));
  if (rootInputCli.input.scope !== 'project-root' || rootInputCli.input.commit !== fixCommit || rootInputCli.verification !== 'not-performed') throw new Error('installed root input CLI lost fixed identity or truthful verification');
  run(process.execPath, ['--input-type=module', '-e',
    `import { pathToFileURL } from 'node:url';
     const { readFixCommitMetadata, readFixCommitInventory } = await import(new URL('../../src/scaffold/fix-input.mjs', pathToFileURL(process.argv[1])));
     const metadata = readFixCommitMetadata({ projectDir: process.argv[2], commit: process.argv[3] });
     if (metadata.commit !== process.argv[3] || metadata.parent !== process.argv[4] || metadata.subject !== 'Supplied fix metadata' || metadata.claims !== undefined || !Object.isFrozen(metadata)) throw new Error('installed fix metadata failed identity or no-claims boundary');
     const scoped = readFixCommitInventory({ projectDir: process.argv[2], commit: process.argv[3] });
     const { planIntentInput } = await import(new URL('../../src/scaffold/plan-intent-input.mjs', pathToFileURL(process.argv[1])));
     const plan = planIntentInput({ projectDir: process.argv[2], values: { 'from-fix': [process.argv[3]] } });
     if (plan.doc.input.scope !== 'project-root' || plan.doc.input.commit !== metadata.commit || plan.doc.input.parent !== metadata.parent || plan.doc.input.counts.supported !== 1 || plan.doc.verification !== 'not-performed' || JSON.stringify(JSON.parse(plan.output)) !== JSON.stringify(plan.doc) || !Object.isFrozen(plan.doc.input.paths[0])) throw new Error('installed root input planner lost validated identity or scope');
     if (scoped.commit !== metadata.commit || scoped.parent !== metadata.parent || scoped.counts.total !== 1 || scoped.counts.supported !== 1 || scoped.paths[0].file !== 'guard.mjs' || !Object.isFrozen(scoped) || !Object.isFrozen(scoped.paths) || scoped.claims !== undefined) throw new Error('installed scoped inventory failed identity or no-claims boundary');
     const { parseFixChangedPaths, parseFixProjectMarkers } = await import(new URL('../../src/scaffold/fix-paths.mjs', pathToFileURL(process.argv[1])));
     const { execFileSync } = await import('node:child_process');
     const raw = execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', 'diff-tree', '--raw', '--no-abbrev', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '-r', '--no-commit-id', metadata.parent, metadata.commit, '--'], { cwd: process.argv[2], timeout: 5000, maxBuffer: 128 * 1024 });
     const inventory = parseFixChangedPaths(raw);
     if (inventory.counts.total !== 1 || inventory.counts.supported !== 1 || inventory.paths[0].file !== 'guard.mjs' || inventory.claims !== undefined || !Object.isFrozen(inventory.paths)) throw new Error('installed raw fix decoder lost complete identity or no-claims boundary');
     const tree = id => execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', 'ls-tree', '-r', '--name-only', '-z', '--full-tree', id], { cwd: process.argv[2], timeout: 5000, maxBuffer: 128 * 1024 });
     const projects = parseFixProjectMarkers(tree(metadata.parent), tree(metadata.commit));
     if (projects.length !== 1 || projects[0] !== 'child' || !Object.isFrozen(projects) || projects.claims !== undefined) throw new Error('installed historical project decoder lost immutable delegation');`,
    installedValidator, fixProject, fixCommit, fixParent,
  ], consumer);
  const nestedFixProject = join(fixProject, 'nested[1]');
  mkdirSync(nestedFixProject);
  writeFileSync(join(nestedFixProject, 'testguard.claims.json'), '{"schemaVersion":1,"claims":[]}');
  writeFileSync(join(nestedFixProject, 'guard.mjs'), 'export const x = 1;');
  fixGit(['add', '.']); fixGit(['commit', '-qm', 'Nested fixture']);
  const nestedFixParent = fixGit(['rev-parse', 'HEAD']);
  writeFileSync(join(nestedFixProject, 'guard.mjs'), 'export const x = 2;');
  fixGit(['add', '.']); fixGit(['commit', '-qm', 'Nested fix']);
  const nestedFixCommit = fixGit(['rev-parse', 'HEAD']);
  const nestedInputCli = JSON.parse(run(bin, ['scaffold', '--from-fix', nestedFixCommit, '--json'], nestedFixProject));
  if (nestedInputCli.input.scope !== 'selected-nested-project' || nestedInputCli.input.counts.supported !== 1 || nestedInputCli.input.paths[0].file !== 'guard.mjs') throw new Error('installed nested input CLI lost literal project scope');
  writeFileSync(join(fixProject, 'intent.md'), 'UNTRUSTED INPUT TEXT');
  const documentInputCli = run(bin, ['scaffold', '--from-document', 'intent.md', '--json'], fixProject);
  if (JSON.parse(documentInputCli).input.bytes !== Buffer.byteLength('UNTRUSTED INPUT TEXT') || documentInputCli.includes('UNTRUSTED INPUT TEXT')) throw new Error('installed document input CLI leaked text or lost size');
  const humanInputCli = run(bin, ['scaffold', '--from-document', 'intent.md'], fixProject);
  if (!humanInputCli.includes('verification not performed') || !humanInputCli.includes('independent intent') || humanInputCli.includes('UNTRUSTED INPUT TEXT') || existsSync(join(fixProject, '.testguard'))) throw new Error('installed human input CLI lost read-only or truthful boundary');
  run(process.execPath, ['--input-type=module', '-e',
    `import { pathToFileURL } from 'node:url';
     const { readNestedFixCommitInventory } = await import(new URL('../../src/scaffold/fix-input.mjs', pathToFileURL(process.argv[1])));
     const inventory = readNestedFixCommitInventory({ projectDir: process.argv[2], commit: process.argv[3] });
     const { planIntentInput } = await import(new URL('../../src/scaffold/plan-intent-input.mjs', pathToFileURL(process.argv[1])));
     const plan = planIntentInput({ projectDir: process.argv[2], values: { 'from-fix': [process.argv[3]] } });
     if (plan.doc.input.scope !== 'selected-nested-project' || plan.doc.input.commit !== inventory.commit || plan.doc.input.parent !== inventory.parent || plan.doc.input.paths[0].file !== 'guard.mjs' || plan.doc.input.counts.total !== 1 || plan.doc.verification !== 'not-performed' || !Object.isFrozen(plan.doc.input.counts)) throw new Error('installed nested input planner lost validated literal scope');
     if (inventory.commit !== process.argv[3] || inventory.parent !== process.argv[4] || inventory.counts.total !== 1 || inventory.counts.supported !== 1 || inventory.paths[0].file !== 'guard.mjs' || inventory.claims !== undefined || !Object.isFrozen(inventory) || !Object.isFrozen(inventory.paths[0])) throw new Error('installed nested inventory lost literal scope or immutable identity');`,
    installedValidator, nestedFixProject, nestedFixCommit, nestedFixParent,
  ], consumer);
  const annotationProject = join(scratch, 'annotation-authoring');
  mkdirSync(annotationProject);
  writeFileSync(join(annotationProject, 'guard.mjs'), 'export const allowed = true;\n');
  const annotationClaims = JSON.stringify({ schemaVersion: 1, claims: [{ id: 'A-1', statement: 'The intended condition holds.', severity: 'high', source: { kind: 'manual' }, producedBy: { producer: 'human' }, faults: [{ id: 'F1', description: 'Break condition.', faultClass: 'other', file: 'guard.mjs', find: 'true', replace: 'false', producedBy: { producer: 'human' } }] }] });
  writeFileSync(join(annotationProject, 'testguard.claims.json'), annotationClaims);
  const annotationInspection = JSON.parse(run(bin, ['claims', annotationProject, '--json'], consumer));
  if (annotationInspection.annotationAdvisory.missingIds.join(',') !== 'A-1' || !annotationInspection.annotationAdvisory.notes.some((n) => n.includes('testguard claims --annotate'))) throw new Error('installed claims omitted source-link advice');
  let annotationStatusText;
  try { annotationStatusText = run(bin, ['status', annotationProject, '--json'], consumer); }
  catch (error) { if (error.status !== 2) throw error; annotationStatusText = error.stdout; }
  const annotationStatus = JSON.parse(annotationStatusText);
  if (annotationStatus.origins?.basis !== 'declared' || annotationStatus.origins.claims.total !== 1 || annotationStatus.origins.claims.byKind.manual !== 1) throw new Error('installed status omitted current declared origins');
  if (annotationStatus.state !== 'unprobed' || annotationStatus.next.action !== 'probe' || !annotationStatus.notes.some((n) => n.includes('ANNOTATION ADVISORY'))) throw new Error('installed annotation advice changed or omitted verification guidance');
  const annotationPreview = JSON.parse(run(bin, ['claims', annotationProject, '--annotate', '--json'], consumer));
  if (annotationPreview.state !== 'preview' || readFileSync(join(annotationProject, 'guard.mjs'), 'utf8') !== 'export const allowed = true;\n') throw new Error('installed annotation preview wrote source or failed');
  const annotationApply = JSON.parse(run(bin, ['claims', annotationProject, '--annotate', '--apply', '--json'], consumer));
  if (annotationApply.outcome?.recoveryDir) annotationRecovery.push(annotationApply.outcome.recoveryDir);
  if (annotationApply.state !== 'applied' || annotationApply.outcome?.changed.join(',') !== 'guard.mjs' || readFileSync(join(annotationProject, 'guard.mjs'), 'utf8') !== '// @claim A-1\nexport const allowed = true;\n' || readFileSync(join(annotationProject, 'testguard.claims.json'), 'utf8') !== annotationClaims || existsSync(join(annotationProject, '.testguard'))) throw new Error('installed annotation apply failed its source/claims/evidence boundary');
  run(process.execPath, ['--input-type=module', '-e',
    `import { pathToFileURL } from 'node:url'; const { validate } = await import(pathToFileURL(process.argv[1]));
     for (const doc of JSON.parse(process.argv[2])) if (!validate('annotations', doc).ok) throw new Error('installed authoring result failed its own validator');`,
    installedValidator, JSON.stringify([annotationPreview, annotationApply]),
  ], consumer);
  const candidateEvidence = join(root, 'spec', 'conformance', 'examples', 'evidence.json');
  const validatesCandidateEvidence = run(process.execPath, [
    '--input-type=module',
    '-e',
    `import { pathToFileURL } from 'node:url'; import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'; import { createHash } from 'node:crypto';
     const { validate } = await import(pathToFileURL(process.argv[1]));
     const candidate = JSON.parse(readFileSync(process.argv[2], 'utf8'));
     for (const r of candidate.records) {
       r.defenders.selectionSource = r.defenders.requested.length ? 'claim' : 'discovery';
       if (!r.defenders.requested.length) r.defenders.discovered = true;
     }
     candidate.run.workers = 1;
     candidate.run.measurements = { elapsedMs: 12, runnerMs: 9, overheadMs: 3, runnerInvocations: 6 };
     const result = validate('evidence', candidate);
     if (!result.ok) throw new Error(result.errors.map((error) => \`${'${error.path}: ${error.message}'}\`).join('; '));
     candidate.run.measurements.overheadMs = 4;
     if (validate('evidence', candidate).ok) throw new Error('installed package accepted inconsistent resource timing');
     candidate.run.measurements.overheadMs = 3;
     const claims = JSON.parse(readFileSync(process.argv[4], 'utf8'));
     claims.claims[0].faults[0].defendedBy = [];
     if (!validate('claims', claims).ok) throw new Error('installed package rejected a fault discovery override');
     claims.claims[0].faults[0].defendedBy = ['test/unit.test.mjs'];
     if (!validate('claims', claims).ok) throw new Error('installed package rejected a fault defender override');
     const { appendDraft } = await import(new URL('../../src/scaffold/append.mjs', pathToFileURL(process.argv[1])));
     const appendProposals = structuredClone(claims);
     appendProposals.claims = [appendProposals.claims[0]];
     appendProposals.claims[0].faults = [{ ...appendProposals.claims[0].faults[0], file: 'src/append-new.mjs' }];
     const originalDraft = JSON.stringify(claims);
     const appended = appendDraft({ draft: claims, proposals: appendProposals, claimId: claims.claims[0].id });
     if (!validate('claims', appended).ok || appended.claims[0].faults.length !== claims.claims[0].faults.length + 1 || JSON.stringify(claims) !== originalDraft || JSON.stringify(appended.claims[0].source) !== JSON.stringify(claims.claims[0].source)) throw new Error('installed append lost preservation or admission');
     const repeated = appendDraft({ draft: appended, proposals: appendProposals, claimId: claims.claims[0].id });
     if (JSON.stringify(repeated) !== JSON.stringify(appended)) throw new Error('installed append is not idempotent');
     const { poolDrafts } = await import(new URL('../../src/sweep/pool.mjs', pathToFileURL(process.argv[1])));
     const pooledDrafts = poolDrafts([claims, structuredClone(claims)]);
     if (!validate('claims', { schemaVersion: 1, claims: pooledDrafts.flatMap((d) => d.claims) }).ok || pooledDrafts.flatMap((d) => d.claims).length !== claims.claims.length * 2 || JSON.stringify(claims) !== originalDraft) throw new Error('installed sweep pool lost identity or preservation');
     const { scaffoldFile } = await import(new URL('../../src/scaffold/scaffold.mjs', pathToFileURL(process.argv[1])));
     const admittedArgs = { projectDir: process.cwd(), file: 'missing-admitted-source.mjs', source: ['export function guard(x) {', '  if (!x) throw new Error("absent");', '}'].join(String.fromCharCode(10)) };
     const admitted = scaffoldFile({ ...admittedArgs, maxProposals: 10 });
     if (!validate('claims', admitted.doc).ok || admitted.stats.proposals < 1) throw new Error('installed scaffold did not scan admitted source');
     if (scaffoldFile({ ...admittedArgs, source: '', maxProposals: 0 }).stats.proposals !== 0) throw new Error('installed scaffold reread empty source');
     let refusedLimit = false;
     try { scaffoldFile({ ...admittedArgs, maxProposals: 0 }); } catch (error) { refusedLimit = error.message.includes('proposal limit'); }
     if (!refusedLimit) throw new Error('installed scaffold ignored proposal limit');
     const { admitDraftAppend, admitIntentDocument, admitIntentProject } = await import(new URL('../../src/scaffold/admission.mjs', pathToFileURL(process.argv[1])));
     const intentProjectRoot = process.cwd() + '/intent-project-marker';
     mkdirSync(intentProjectRoot); const markerBytes = JSON.stringify({ schemaVersion: 1, claims: [] });
     writeFileSync(intentProjectRoot + '/testguard.claims.json', markerBytes);
     const intentProject = admitIntentProject({ projectDir: intentProjectRoot });
     if (intentProject.marker.hash !== createHash('sha256').update(markerBytes).digest('hex') || !Object.isFrozen(intentProject) || !Object.isFrozen(intentProject.marker) || !Object.isFrozen(intentProject.marker.identity) || intentProject.claims !== undefined || intentProject.marker.source !== undefined || readFileSync(intentProjectRoot + '/testguard.claims.json', 'utf8') !== markerBytes) throw new Error('installed project marker admission lost bounded identity or no-claims boundary');
     writeFileSync('intent-input.md', 'Absent input must be rejected.');
     const intentInput = admitIntentDocument({ projectDir: process.cwd(), file: 'intent-input.md' });
     if (intentInput.source !== 'Absent input must be rejected.' || !Object.isFrozen(intentInput) || !Object.isFrozen(intentInput.identity) || intentInput.claims !== undefined || readFileSync('intent-input.md', 'utf8') !== intentInput.source) throw new Error('installed document admission lost text, immutability or no-claims boundary');
     const inputReport = { schemaVersion: 1, tool: { name: 'testguard', version: 'test' }, purpose: 'authoring-input', verification: 'not-performed', next: 'supply-independent-intent', input: { kind: 'document', file: intentInput.file, hash: intentInput.hash, bytes: intentInput.identity.size } };
     if (!validate('authoring-input', inputReport).ok) throw new Error('installed input report contract rejected admitted metadata');
     const { planIntentInput } = await import(new URL('../../src/scaffold/plan-intent-input.mjs', pathToFileURL(process.argv[1])));
     const documentPlan = planIntentInput({ projectDir: process.cwd(), values: { 'from-document': ['intent-input.md'] }, toolVersion: 'test' });
     if (JSON.stringify(documentPlan.doc) !== JSON.stringify(inputReport) || JSON.stringify(JSON.parse(documentPlan.output)) !== JSON.stringify(inputReport) || documentPlan.output.includes(intentInput.source) || !Object.isFrozen(documentPlan) || !Object.isFrozen(documentPlan.doc.input)) throw new Error('installed document planner lost metadata-only validated projection');
     const { writeSpecDoc, readSpecDoc } = await import(new URL('../../src/evidence/writer.mjs', pathToFileURL(process.argv[1])));
     let inputReportBytes;
     writeSpecDoc('authoring-input', 'unused.json', inputReport, { publish: bytes => { inputReportBytes = bytes; } });
     if (JSON.stringify(readSpecDoc('authoring-input', 'unused.json', { source: inputReportBytes })) !== JSON.stringify(inputReport) || inputReportBytes.includes(intentInput.source)) throw new Error('installed input report lost validation or leaked document text');
     const optimisticReport = { ...inputReport, verification: 'killed' };
     if (validate('authoring-input', optimisticReport).ok) throw new Error('installed input report admits an optimistic verification label');
     let refusedPrivateDocument = false;
     try { admitIntentDocument({ projectDir: process.cwd(), file: '.local/secret.md' }); } catch (error) { refusedPrivateDocument = error.message.includes('excluded-document'); }
     if (!refusedPrivateDocument) throw new Error('installed document admission accepted private input');
     writeFileSync('append-admission-draft.json', JSON.stringify(claims));
     writeFileSync('append-admission-source.mjs', admittedArgs.source);
     const admittedInputs = admitDraftAppend({ projectDir: process.cwd(), draftPath: 'append-admission-draft.json', files: ['append-admission-source.mjs'], claimId: claims.claims[0].id });
     if (!validate('claims', admittedInputs.draft.doc).ok || admittedInputs.sources[0].source !== admittedArgs.source || readFileSync('append-admission-draft.json', 'utf8') !== JSON.stringify(claims)) throw new Error('installed draft admission lost validated input or wrote the draft');
     const { planDraftAppend } = await import(new URL('../../src/scaffold/plan-append.mjs', pathToFileURL(process.argv[1])));
     const planRequest = { projectDir: process.cwd(), draftPath: 'append-admission-draft.json', files: ['append-admission-source.mjs'], claimId: claims.claims[0].id };
     const planned = planDraftAppend(planRequest);
     if (!validate('claims', planned.doc).ok || !planned.changed || planned.stats.appended < 1 || readFileSync('append-admission-draft.json', 'utf8') !== JSON.stringify(claims)) throw new Error('installed append planner lost proposals or published during preview');
     const { prepareDraftAppend } = await import(new URL('../../src/scaffold/prepare-append.mjs', pathToFileURL(process.argv[1])));
     const preparedDraftBytes = readFileSync('append-admission-draft.json', 'utf8');
     const prepared = prepareDraftAppend({ request: planRequest, plan: planned });
     try {
       if (!prepared.ready || readFileSync('append-admission-draft.json', 'utf8') !== preparedDraftBytes || readFileSync(prepared.recoveryDir + '/draft.original', 'utf8') !== preparedDraftBytes) throw new Error('installed append preparation changed draft or lost recovery');
       prepared.assertOwned();
     } finally {
       const released = prepared.release();
       rmSync(prepared.recoveryDir, { recursive: true, force: true });
       if (!released.released) throw new Error('installed append preparation lost lock ownership');
     }
     const { openDraftAppend } = await import(new URL('../../src/scaffold/open-append.mjs', pathToFileURL(process.argv[1])));
     const openedDraft = openDraftAppend({ request: planRequest, plan: planned });
     try {
       openedDraft.assertCurrent();
       if (typeof openedDraft.fd !== 'number' || readFileSync('append-admission-draft.json', 'utf8') !== preparedDraftBytes) throw new Error('installed append descriptor changed the draft');
     } finally {
       const released = openedDraft.release();
       rmSync(openedDraft.recoveryDir, { recursive: true, force: true });
       if (!released.released) throw new Error('installed append descriptor release failed');
     }
     const { applyDraftAppend } = await import(new URL('../../src/scaffold/apply-append.mjs', pathToFileURL(process.argv[1])));
     const appliedDraft = applyDraftAppend({ request: planRequest, plan: planned });
     try {
       if (!appliedDraft.ok || appliedDraft.state !== 'updated' || readFileSync('append-admission-draft.json', 'utf8') !== planned.output) throw new Error('installed append publication failed');
       const repeatedDraft = applyDraftAppend({ request: planRequest, plan: planDraftAppend(planRequest) });
       if (!repeatedDraft.ok || repeatedDraft.state !== 'unchanged' || repeatedDraft.recoveryDir) throw new Error('installed append repeat wrote or lost idempotence');
     } finally { if (appliedDraft.recoveryDir) rmSync(appliedDraft.recoveryDir, { recursive: true, force: true }); }
     if (planDraftAppend(planRequest).changed) throw new Error('installed append planner lost repeat idempotence');
     for (const kind of ['spec', 'adr', 'annotation', 'comment', 'manual', 'doc', 'bug', 'incident', 'review', 'inferred']) {
       claims.claims[0].source.kind = kind; candidate.records[0].claim.source.kind = kind;
       if (!validate('claims', claims).ok || !validate('evidence', candidate).ok) throw new Error('installed package rejected a declared origin: ' + kind);
     }
     const { recordedOriginSummary } = await import(new URL('./origins.mjs', pathToFileURL(process.argv[1])));
     candidate.origins = recordedOriginSummary(candidate.records);
     if (!validate('evidence', candidate).ok) throw new Error('installed package rejected its recorded origin summary');
     const { buildBrief } = await import(new URL('../../src/brief/brief.mjs', pathToFileURL(process.argv[1])));
     const brief = buildBrief(candidate, undefined, { max: 0 });
     if (!validate('brief', brief).ok || brief.origins.records.total !== candidate.records.length || !brief.text.includes('declared origins, not authenticated independence')) throw new Error('installed brief lost full recorded origins or caveat');
     const oldKind = Object.keys(candidate.origins.claims.byKind).find((kind) => candidate.origins.claims.byKind[kind] > 0);
     candidate.origins.claims.byKind[oldKind]--; candidate.origins.claims.byKind.bug++;
     if (validate('evidence', candidate).ok) throw new Error('installed package accepted an invented origin split');
     delete candidate.origins;
     candidate.originPolicy = {
       state: 'unavailable', eligibleKinds: ['spec'],
       claims: new Set(candidate.records.map((r) => r.claim.id)).size,
       faults: candidate.records.length, ineligibleClaims: [],
       nonKilledFaults: [...new Map(candidate.records.filter((r) => r.verdict !== 'killed').map((r) => [JSON.stringify([r.claim.id, r.subject.id]), { claimId: r.claim.id, faultId: r.subject.id }])).values()],
       unavailableReasons: ['stale-inputs'],
     };
     if (!validate('evidence', candidate).ok) throw new Error('installed package rejected the unavailable origin policy contract');
     const policyBrief = buildBrief(candidate, undefined, { max: 0 });
     if (!validate('brief', policyBrief).ok || JSON.stringify(policyBrief.originPolicy) !== JSON.stringify(candidate.originPolicy) || !policyBrief.text.includes('not current freshness') || policyBrief.text.includes('Every probed claim is defended')) throw new Error('installed brief lost policy scope or invented capped defense');
     candidate.originPolicy.state = 'passed';
     if (validate('evidence', candidate).ok) throw new Error('installed package accepted an optimistic origin policy');
     delete candidate.originPolicy;
     const { originPolicyRequest } = await import(new URL('../../src/probe/origin-policy.mjs', pathToFileURL(process.argv[1])));
     if (JSON.stringify(originPolicyRequest({ 'require-origin': ['spec,bug', 'spec'] })) !== JSON.stringify(['bug', 'spec'])) throw new Error('installed candidate lost origin-policy request admission');
     let refusedPartialPolicy = false;
     try { originPolicyRequest({ 'require-origin': ['spec'], claim: ['C-1'] }); } catch (e) { refusedPartialPolicy = e instanceof TypeError; }
     if (!refusedPartialPolicy) throw new Error('installed candidate accepted a partial origin policy request');
     const { hashNativeTestUniverse } = await import(new URL('../../src/probe/universe.mjs', pathToFileURL(process.argv[1])));
     const { createDiscoveryManifest } = await import(new URL('../../src/probe/runners/discovery.mjs', pathToFileURL(process.argv[1])));
     const nativeManifest = createDiscoveryManifest({ runner: 'vitest', version: '1', files: ['test/a.test.mjs'] });
     const initialUniverse = hashNativeTestUniverse(new Map([[{ name: 'vitest' }, nativeManifest]]));
     const changedManifest = createDiscoveryManifest({ runner: 'vitest', version: '1', files: ['test/a.test.mjs', 'test/b.test.mjs'] });
     if (initialUniverse === hashNativeTestUniverse(new Map([[{ name: 'vitest' }, changedManifest]]))) throw new Error('installed package ignored native universe membership');
     const { originPolicyInputsFresh } = await import(new URL('../../src/probe/policy-freshness.mjs', pathToFileURL(process.argv[1])));
     if (originPolicyInputsFresh({ claims, evidence: candidate }) !== false) throw new Error('installed package admitted missing runtime policy bindings');
     const { main: candidateMain } = await import(new URL('../../src/cli.mjs', pathToFileURL(process.argv[1])));
     writeFileSync('append-cli-draft.json', JSON.stringify(claims));
     const appendCliArgs = ['scaffold', 'append-admission-source.mjs', '--into', 'append-cli-draft.json', '--claim', claims.claims[0].id];
     const appendPreview = [];
     const appendPreviewCode = await candidateMain([...appendCliArgs, '--json'], { out: s => appendPreview.push(s), err: s => { throw new Error(s); } });
     if (appendPreviewCode !== 0 || !validate('claims', JSON.parse(appendPreview.join(''))).ok || readFileSync('append-cli-draft.json', 'utf8') !== JSON.stringify(claims)) throw new Error('installed append CLI preview failed or wrote');
     const appendCliOutput = [];
     try {
       const appendCliCode = await candidateMain(appendCliArgs, { out: s => appendCliOutput.push(s), err: s => { throw new Error(s); } });
       if (appendCliCode !== 0 || !appendCliOutput.some(s => s.startsWith('unproven draft updated:')) || !validate('claims', JSON.parse(readFileSync('append-cli-draft.json', 'utf8'))).ok) throw new Error('installed append CLI update failed');
     } finally {
       for (const line of appendCliOutput) if (line.startsWith('private recovery: ')) rmSync(line.slice('private recovery: '.length), { recursive: true, force: true });
     }
     const policyErrors = [];
     const policyCode = await candidateMain(['probe', '--require-origin', 'spec', '--confirm', '1', '--claims', '/nonexistent/policy-smoke.claims.json'], { out: () => { throw new Error('invalid policy emitted output'); }, err: (s) => policyErrors.push(s) });
     if (policyCode !== 3 || !policyErrors.some((s) => s.includes('--require-origin'))) throw new Error('installed candidate lost CLI origin-policy admission');
     claims.claims[0].source.kind = 'authenticated'; candidate.records[0].claim.source.kind = 'authenticated';
     if (validate('claims', claims).ok || validate('evidence', candidate).ok) throw new Error('installed package accepted an unsupported origin');
     const gate = JSON.parse(readFileSync(process.argv[3], 'utf8'));
     gate.nested = [{ project: 'backend', files: ['backend/src/guard.mjs'] }]; gate.changed++;
     const nestedResult = validate('gate', gate);
     if (!nestedResult.ok) throw new Error('installed package rejected the nested-project gate contract');
     process.stdout.write('ok');`,
    installedValidator,
    candidateEvidence,
    join(root, 'spec', 'conformance', 'examples', 'gate.json'),
    join(root, 'spec', 'conformance', 'examples', 'claims.json'),
  ], consumer).trim();
  if (!draft.claims?.length) throw new Error('scaffold produced no claims from the installed tarball');
  const suppliedClaims = JSON.parse(readFileSync(join(consumer, 'testguard.claims.json'), 'utf8')).claims;
  let inferredDrafts = 0;
  for (const claim of draft.claims) {
    const supplied = suppliedClaims.find((c) => c.id === claim.id);
    if (supplied) {
      if (claim.statement !== supplied.statement || JSON.stringify(claim.source) !== JSON.stringify(supplied.source)) throw new Error('installed scaffold overwrote supplied intent');
    } else {
      inferredDrafts++;
      if (claim.source.kind !== 'inferred' || !claim.statement.includes('intended observable behavior')) throw new Error('installed scaffold lost inferred intent handoff');
    }
  }
  if (!inferredDrafts) throw new Error('installed smoke did not exercise a new inferred draft');
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected --version output: ${version}`);
  if (!/^\d+ claims in /.test(claims)) throw new Error(`claims did not list the fixture:\n${claims}`);
  if (validatesCandidateEvidence !== 'ok') throw new Error('installed package did not validate candidate-format evidence');
  const deps = Object.keys(JSON.parse(run(npm, ['ls', '--omit=dev', '--json', '--depth=0'], consumer)).dependencies ?? {});
  console.log(`install smoke OK — testguard ${version} runs from the installed tarball; consumer deps: ${deps.join(', ')}`);
} finally {
  for (const dir of annotationRecovery) rmSync(dir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
