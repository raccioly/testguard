import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, linkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { admitIntentProject } from '../src/scaffold/admission.mjs';

const roots = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'testguard-intent-project-'))); roots.push(root);
  const marker = join(root, 'testguard.claims.json');
  writeFileSync(marker, '{"schemaVersion":1,"claims":[]}'); return { root, marker };
}
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('read-only selected intent project marker admission', () => {
  it('validates exact marker bytes without exposing claims, source or modifying the marker', () => {
    const f = fixture(), bytes = readFileSync(f.marker);
    const result = admitIntentProject({ projectDir: f.root });
    expect(result.projectDir).toBe(f.root); expect(result.marker.file).toBe('testguard.claims.json');
    expect(result.marker.hash).toBe(createHash('sha256').update(bytes).digest('hex')); expect(result.marker.identity.size).toBe(bytes.length);
    expect(Object.keys(result).sort()).toEqual(['marker', 'projectDir']);
    expect(Object.keys(result.marker).sort()).toEqual(['file', 'hash', 'identity']);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.marker)).toBe(true); expect(Object.isFrozen(result.marker.identity)).toBe(true);
    expect(readFileSync(f.marker)).toEqual(bytes); expect(result.claims).toBeUndefined(); expect(result.source).toBeUndefined();
  });
  it('requires a conforming actual claims document, not marker presence or prose', () => {
    const f = fixture();
    for (const source of ['untrusted instructions', '{"schemaVersion":1,"claims":[{}]}', '{"schemaVersion":1,"claims":[],"foreign":true}']) {
      writeFileSync(f.marker, source); expect(() => admitIntentProject({ projectDir: f.root })).toThrow(/JSON|schema|claims|valid/i);
    }
    unlinkSync(f.marker); expect(() => admitIntentProject({ projectDir: f.root })).toThrow(/ENOENT/);
  });
  it.each(['.local', '.wolf', '.git', '.testguard', 'graphify-out'])('refuses %s roots before opening even missing markers', component => {
    const f = fixture(); const nested = join(f.root, component); mkdirSync(nested);
    expect(() => admitIntentProject({ projectDir: nested })).toThrow(/excluded-project/);
  });
  it('refuses root/marker symlinks, hardlinks and nonregular markers', () => {
    const f = fixture(); const alias = join(f.root, 'alias'); symlinkSync(f.root, alias);
    expect(() => admitIntentProject({ projectDir: alias })).toThrow(/unsafe-root/);
    const saved = join(f.root, 'saved.json'); writeFileSync(saved, readFileSync(f.marker)); unlinkSync(f.marker); symlinkSync(saved, f.marker);
    expect(() => admitIntentProject({ projectDir: f.root })).toThrow(/symlink/);
    unlinkSync(f.marker); linkSync(saved, f.marker);
    expect(() => admitIntentProject({ projectDir: f.root })).toThrow(/not-single-regular-file/);
    unlinkSync(f.marker); mkdirSync(f.marker);
    expect(() => admitIntentProject({ projectDir: f.root })).toThrow(/not-single-regular-file/);
  });
  it('refuses oversize and malformed text before schema admission', () => {
    const f = fixture(); writeFileSync(f.marker, Buffer.alloc(2 * 1024 * 1024 + 1, 32));
    expect(() => admitIntentProject({ projectDir: f.root })).toThrow(/file-byte-limit/);
    writeFileSync(f.marker, Buffer.from([0xff])); expect(() => admitIntentProject({ projectDir: f.root })).toThrow(/invalid-utf8/);
    writeFileSync(f.marker, '\0'); expect(() => admitIntentProject({ projectDir: f.root })).toThrow(/invalid-encoding/);
  });
});
