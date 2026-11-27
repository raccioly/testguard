// A fake `mvnw` / `gradlew` for the JVM adapter tests (#329). It is a small
// Node script that does what Maven and Gradle are documented to do for a test
// run: print a version, write JUnit XML under the module's report directory,
// print compile errors on stdout and exit non-zero. Nothing here starts a real
// build tool or touches the network (rule 12). Behavior is data in
// `.fake-jvm.json` in the directory the tool runs in.
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = `
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const cfgPath = path.join(process.cwd(), '.fake-jvm.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const kind = cfg.kind || 'maven';
const logPath = path.join(process.cwd(), '.fake-argv.json');
const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];
log.push(argv);
fs.writeFileSync(logPath, JSON.stringify(log));
if (argv[0] === '--version') {
  if (cfg.versionHang) { fs.writeFileSync(path.join(process.cwd(), '.fake-pid'), String(process.pid)); setInterval(() => {}, 1000); return; }
  if (cfg.versionFails) { console.error('boom'); process.exit(3); }
  process.stdout.write(cfg.versionText || (kind === 'maven' ? 'Apache Maven 3.9.6 (fake)\\n' : '\\n-----\\nGradle 8.5\\n-----\\n'));
  process.exit(0);
}
if (cfg.mode === 'hang') {
  fs.writeFileSync(path.join(process.cwd(), '.fake-pid'), String(process.pid));
  const t = Date.now(); while (Date.now() - t < 60000) {}
}
const classes = [];
const modules = new Set();
if (kind === 'maven') {
  const t = argv.find((a) => a.startsWith('-Dtest='));
  for (const c of (t ? t.slice(7).split(',') : [])) classes.push([c, '']);
  const at = argv.indexOf('-pl');
  for (const m of (at === -1 ? [''] : argv[at + 1].split(',').map((x) => (x === '.' ? '' : x)))) modules.add(m);
} else {
  let current = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith(':') && a.endsWith(':test')) { current = a.slice(1, -':test'.length).split(':').filter(Boolean).join('/'); modules.add(current); }
    if (a === '--tests') classes.push([argv[i + 1], current]);
  }
}
if (cfg.mode === 'compile-error') {
  process.stdout.write('[INFO] Compiling 1 source file\\n[ERROR] COMPILATION ERROR :\\n[ERROR] /w/src/main/java/demo/Discount.java:[5,9] illegal start of expression\\n[INFO] BUILD FAILURE\\n');
  process.exit(1);
}
if (cfg.mode === 'no-report') process.exit(cfg.exit || 0);
const dirFor = (m) => path.join(process.cwd(), m, kind === 'maven' ? 'target/surefire-reports' : 'build/test-results/test');
const xml = (cls, how) => {
  const head = '<?xml version="1.0"?>\\n<testsuite name="' + cls + '" tests="1" errors="' + (how === 'exception' ? 1 : 0) + '" failures="' + (how === 'assert' ? 1 : 0) + '">';
  const body = how === 'pass' ? '<testcase name="t" classname="' + cls + '"/>'
    : how === 'assert' ? '<testcase name="t" classname="' + cls + '"><failure message="expected 90" type="org.opentest4j.AssertionFailedError">x</failure></testcase>'
    : how === 'exception' ? '<testcase name="t" classname="' + cls + '"><error message="boom" type="java.lang.IllegalStateException">x</error></testcase>'
    : '<testcase name="t" classname="' + cls + '"><error message="slow" type="java.util.concurrent.TimeoutException">x</error></testcase>';
  return head + body + '</testsuite>';
};
let failed = false;
for (const [cls, forced] of classes) {
  const how = (cfg.classes || {})[cls];
  if (how === undefined || how === 'missing') continue;
  const m = (cfg.modules || {})[cls] !== undefined ? cfg.modules[cls] : forced;
  if (!modules.has(m)) continue;
  fs.mkdirSync(dirFor(m), { recursive: true });
  fs.writeFileSync(path.join(dirFor(m), 'TEST-' + cls + '.xml'), xml(cls, how));
  if (how !== 'pass') failed = true;
}
process.exit(cfg.mode === 'exit1-green' ? 1 : failed ? 1 : 0);
`;

/** Write an executable fake tool named `name` (`mvnw`, `gradlew`, `mvn`) into `dir`. */
export function writeFakeTool(dir, name, config = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!${process.execPath}\n${SCRIPT}`);
  chmodSync(file, 0o755);
  setFakeBehavior(dir, config);
  return file;
}

/** The behavior of the fake tool when it runs with `dir` as its working directory. */
export function setFakeBehavior(cwd, config) {
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, '.fake-jvm.json'), JSON.stringify(config));
}

/** Every argv the fake tool was started with, in order. */
export const fakeArgv = (cwd) => {
  const path = join(cwd, '.fake-argv.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
};
