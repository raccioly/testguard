import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_RESULTS = 100_000;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const boundedText = (value) => String(value ?? '').slice(0, 1000);

/** Keep only structured identity, never arbitrary error objects or assertion values. */
const errorIdentity = (error) => error == null ? undefined : {
  failureType: boundedText(error.failureType),
  code: boundedText(error.code),
  message: boundedText(error.message ?? error),
  fileExit: Object.hasOwn(error, 'exitCode') || Object.hasOwn(error, 'signal'),
};

/** Pure report accumulator. File/suite summaries never count as assertion kills. */
export function createReport({ projectDir, version, collect = false }) {
  const cases = [];
  const parents = [];
  const pending = new Map();
  let bytes = 0;
  let failed = false;
  let diagnostic = '';
  const add = (item) => {
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (cases.length >= MAX_RESULTS || bytes > MAX_REPORT_BYTES) throw new Error('node-test results exceeded their report bound');
    cases.push(item);
  };
  const accept = ({ type, data }) => {
    if (['test:stderr', 'test:diagnostic'].includes(type)) {
      diagnostic = `${diagnostic}\n${String(data?.message ?? '')}`.slice(-65536);
      return;
    }
    if (!['test:start', 'test:pass', 'test:fail'].includes(type)) return;
    if (!data || typeof data.name !== 'string' || !Number.isSafeInteger(data.nesting) || data.nesting < 0) throw new Error('malformed node-test event identity');
    const file = typeof data.file === 'string' ? resolve(projectDir, data.file) : undefined;
    const names = parents;
    const key = JSON.stringify([file, data.nesting, data.name]);
    if (type === 'test:start') {
      if (pending.size >= MAX_RESULTS || data.nesting > 1000) throw new Error('node-test pending results exceeded their bound');
      pending.set(key, (pending.get(key) ?? 0) + 1);
      names.length = data.nesting;
      names[data.nesting] = data.name;
      return;
    }
    if (!pending.has(key)) throw new Error('node-test finished a result without its start');
    if (pending.get(key) === 1) pending.delete(key);
    else pending.set(key, pending.get(key) - 1);
    const error = errorIdentity(data.details?.error);
    const skipped = ['skip', 'todo', 'expectFailure'].some((key) => Object.hasOwn(data, key) && data[key] !== false);
    if (type === 'test:fail' && !skipped) failed = true;
    const container = data.nesting === 0 && (isAbsolute(data.name) || file && resolve(projectDir, data.name) === file)
      && (data.line === undefined || data.line === 1) && (data.column === undefined || data.column === 1);
    const suite = data.details?.type === 'suite' || error?.failureType === 'subtestsFailed';
    const name = [...names.slice(0, data.nesting), data.name].join(' > ');
    const rel = file ? relative(projectDir, file).split(sep).join('/') : '';
    // Refuse ambiguous/escaped attribution rather than invent a killer id.
    const outside = rel === '..' || rel.startsWith('../') || isAbsolute(rel);
    if (!container && (!rel || outside || !name || name.length > 1000)) throw new Error(outside ? 'node-test result attribution is outside the selected project' : 'node-test result has unavailable or unsupported attribution');
    add({ file: rel, name, container, suite, skipped, passed: type === 'test:pass', ...(error ? { error } : {}) });
  };
  const finish = (entries) => {
    if (pending.size) throw new Error('node-test stopped before every started result finished');
    return { schemaVersion: 1, engine: 'node-test', version, collect, complete: true, failed, entries, cases, diagnostic };
  };
  return { accept, finish };
}
