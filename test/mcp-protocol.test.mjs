import {describe,it,expect} from 'vitest';
import {cpSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {handle,PROTOCOL_VERSION} from '../src/mcp/server.mjs';
import {TOOLS,TOOL_NAMES} from '../src/mcp/tools.mjs';
import { FIXTURE_GIT } from './helpers/git.mjs';
const FIXTURE=join(dirname(fileURLToPath(import.meta.url)),'..','fixtures','known-answer');

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
    spawnSync('git', [...FIXTURE_GIT, 'init', '-q'], { cwd: dir });
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
