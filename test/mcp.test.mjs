// @req FR-07
// @req FR-14
// Requirements live in docs-canonical/REQUIREMENTS.md; the matrix there must agree with these.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { handle, PROTOCOL_VERSION } from '../src/mcp/server.mjs';
import { TOOLS, TOOL_NAMES } from '../src/mcp/tools.mjs';
import { initProject } from '../src/init/init.mjs';
import { main } from '../src/cli.mjs';
import { validate } from '../spec/lib/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'known-answer');
const BIN = join(ROOT, 'cli', 'testguard.mjs');
const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (s) => lines.out.push(s), err: (s) => lines.err.push(s) } };
};

/** Speak the protocol to a real child process, one JSON object per line. */
function client(cwd) {
  const child = spawn(process.execPath, [BIN, 'mcp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = [];
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (waiters.length) waiters.shift()(msg);
      else pending.push(msg);
    }
  });
  let id = 0;
  return {
    child,
    request(method, params) {
      const mine = ++id;
      const answer = new Promise((res) => (pending.length ? res(pending.shift()) : waiters.push(res)));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, ...(params ? { params } : {}) }) + '\n');
      return answer;
    },
    notify(method) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    stop() {
      child.stdin.end();
      return new Promise((res) => child.on('close', res));
    },
  };
}

describe('handle — the protocol, in process', () => {
  it('initialize answers with the pinned protocol version and a read-only capability set', () => {
    const r = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { version: '9.9.9' });
    expect(r.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(r.result.serverInfo).toEqual({ name: 'testguard', version: '9.9.9' });
    // no prompts, no resources, no sampling: nothing here can change a file
    expect(Object.keys(r.result.capabilities)).toEqual(['tools']);
    expect(r.result.instructions).toMatch(/never run a probe/);
  });

  it('lists exactly the five read-only tools, each marked read-only', async () => {
    const r = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(r.result.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(r.result.tools).toHaveLength(5);
    for (const t of r.result.tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
    // no tool may write, probe, or otherwise act
    expect(TOOL_NAMES.some((n) => /probe|write|baseline|scaffold|init|fix|run/.test(n))).toBe(false);
  });

  it('a notification is never answered, and ping is', () => {
    expect(handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(handle({ jsonrpc: '2.0', method: 'tools/list' })).toBeNull(); // no id → notification
    expect(handle({ jsonrpc: '2.0', id: 3, method: 'ping' }).result).toEqual({});
  });

  it('an unknown method and an unknown tool are distinct errors, and neither is fatal', () => {
    expect(handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' }).error.code).toBe(-32601);
    const unknown = handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'testguard_probe' } });
    expect(unknown.error.code).toBe(-32602);
    expect(unknown.error.message).toMatch(/unknown tool: testguard_probe/);
  });

  it('a malformed request is an invalid-request error rather than a throw', () => {
    expect(handle(null).error.code).toBe(-32600);
    expect(handle([]).error.code).toBe(-32600);
    expect(handle('nope').error.code).toBe(-32600);
  });

  it('a tool that throws returns an isError result, so the connection survives', () => {
    // A real failure: a claims file that exists, and a reference that does not.
    const dir = mkdtempSync(join(tmpdir(), 'tg-mcp-throw-'));
    cpSync(join(FIXTURE, 'testguard.claims.json'), join(dir, 'testguard.claims.json'));
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const r = handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'testguard_claims', arguments: { dir, since: 'no-such-ref' } } });
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/testguard_claims failed:/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a missing project is answered, not thrown: the note says what is absent', () => {
    const r = handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'testguard_claims', arguments: { dir: join(tmpdir(), 'tg-definitely-absent-xyz') } } });
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent.note).toMatch(/no claims file/);
  });
});

describe('the tools agree with the CLI, on a real project', () => {
  let scratch;
  let c;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'tg-mcp-'));
    cpSync(FIXTURE, scratch, { recursive: true, filter: (s) => !/node_modules|\.flake-counter|\.testguard/.test(s) });
    // MCP protocol tests need the unprobed state; the known-answer fixture's
    // intentional bad anchors belong to probe acceptance, not this scenario.
    const claimsPath = join(scratch, 'testguard.claims.json');
    const claims = JSON.parse(readFileSync(claimsPath, 'utf8'));
    const anchors = claims.claims.find((claim) => claim.id === 'REDACT-005').faults;
    anchors[0].find = 'if (rule.id === id) return rule;';
    anchors[0].replace = 'if (rule.id === id) return rules[0];';
    anchors[1].find = '  return null;\n}\n\n/** Compile all rules.';
    anchors[1].replace = '  return rules[0];\n}\n\n/** Compile all rules.';
    delete anchors[1].expectHits;
    writeFileSync(claimsPath, JSON.stringify(claims, null, 2) + '\n');
    symlinkSync(join(ROOT, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const g = (...args) => {
      const r = spawnSync('git', ['-c', 'user.email=m@example.invalid', '-c', 'user.name=m', ...args], { cwd: scratch, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'fixture');
    c = client(scratch);
    await c.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {} });
    c.notify('notifications/initialized');
  }, 120_000);

  afterAll(async () => {
    if (c) await c.stop();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  const call = async (name, args = {}) => {
    const r = await c.request('tools/call', { name, arguments: { dir: scratch, ...args } });
    expect(r.result.isError, JSON.stringify(r.result).slice(0, 300)).toBe(false);
    return r.result.structuredContent;
  };

  it('testguard_status returns the same conforming document the CLI prints', async () => {
    const viaMcp = await call('testguard_status');
    expect(validate('status', viaMcp).errors).toEqual([]);
    const { lines, io } = capture();
    await main(['status', scratch, '--json'], io);
    const viaCli = JSON.parse(lines.out.join('\n'));
    // generatedAt differs by construction; everything that matters must not
    expect({ ...viaMcp, generatedAt: null, tool: null }).toEqual({ ...viaCli, generatedAt: null, tool: null });
    expect(viaMcp.state).toBe('unprobed');
    expect(viaMcp.next.action).toBe('probe');
  });

  it('testguard_next_command hands back the shell line and never runs it', async () => {
    const next = await call('testguard_next_command');
    expect(next).toMatchObject({ state: 'unprobed', action: 'probe', command: 'testguard probe' });
    expect(next.why).toMatch(/never been probed/);
    // nothing was executed: no evidence appeared
    const after = await call('testguard_status');
    expect(after.state).toBe('unprobed');
  });

  it('testguard_claims returns the claims file with drift, and reports a removed claim when given a ref', async () => {
    const before = await call('testguard_claims');
    expect(before.claims.claims.length).toBeGreaterThan(5);
    expect(before.drift.undeclared).toEqual([]);
    const claimsPath = join(scratch, 'testguard.claims.json');
    const doc = JSON.parse(readFileSync(claimsPath, 'utf8'));
    const kept = doc.claims.filter((x) => x.id !== 'REDACT-004');
    writeFileSync(claimsPath, JSON.stringify({ ...doc, claims: kept }, null, 2) + '\n');
    try {
      const after = await call('testguard_claims', { since: 'HEAD' });
      expect(after.removed.findings).toEqual([{ kind: 'removed-claim', claimId: 'REDACT-004', severity: 'medium', faults: ['F1'] }]);
    } finally {
      writeFileSync(claimsPath, JSON.stringify(doc, null, 2) + '\n');
    }
  });

  it('testguard_brief and testguard_evidence say honestly that nothing has been probed yet', async () => {
    const brief = await call('testguard_brief');
    expect(brief.note).toMatch(/nothing has been probed yet/);
    const evidence = await call('testguard_evidence');
    expect(evidence.note).toMatch(/run a probe first/);
  });

  it('after a probe, brief and evidence carry the findings, and evidence filters by claim', async () => {
    const { io } = capture();
    await main(['probe', scratch, '--claim', 'REDACT-001', '--budget', '30000', '--no-escalate', '--quiet', '--out', join(scratch, '.testguard', 'evidence.json')], io);
    const brief = await call('testguard_brief', { max: 3 });
    expect(validate('brief', brief).errors).toEqual([]);
    expect(brief.items.length).toBeGreaterThan(0);
    expect(brief.items.length).toBeLessThanOrEqual(3);
    const all = await call('testguard_evidence');
    expect(validate('evidence', all).errors).toEqual([]);
    const one = await call('testguard_evidence', { claim: 'REDACT-001', fault: 'F1' });
    expect(one.records).toHaveLength(1);
    expect(one.records[0].claim.id).toBe('REDACT-001');
    expect(one.filtered).toEqual({ claim: 'REDACT-001', fault: 'F1' });
  }, 180_000);
});

describe('init --mcp', () => {
  it('prints config for Claude Code, Cursor and Codex and writes no harness file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-mcp-init-'));
    const r = initProject({ projectDir: dir, mcp: true });
    const keys = Object.keys(r.mcpConfig);
    expect(keys).toHaveLength(3);
    expect(keys.join(' ')).toMatch(/Claude Code.*Cursor.*Codex/s);
    expect(r.mcpConfig[keys[0]].mcpServers.testguard).toEqual({ command: 'npx', args: ['-y', 'testguard-cli', 'mcp'] });
    // printed, never written: a harness config is the person's file
    expect(r.done.some((d) => /mcp\.json|config\.toml/.test(d))).toBe(false);
    expect(initProject({ projectDir: dir }).mcpConfig).toBeUndefined();
  });
});
