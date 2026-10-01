import { fstatSync, fsyncSync, ftruncateSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { persistRecovery } from '../claims/annotation-placement.mjs';
import { readSpecDoc, writeSpecDoc } from '../evidence/writer.mjs';
import { admitDraftAppend } from './admission.mjs';
import { openDraftAppend } from './open-append.mjs';

/** Explicit internal draft publication. Partial writes never auto-rollback. */
export function applyDraftAppend({ request, plan }) {
  let handle, stage = 'preparation';
  const report = { ok: false, state: 'refused', writeAttempted: false, bytesWritten: 0, failed: [] };
  const fail = (error) => {
    report.ok = false; report.state = report.writeAttempted ? 'write-unconfirmed' : 'refused';
    report.failed.push({ stage, reason: error.message });
  };
  try {
    handle = openDraftAppend({ request, plan }); report.recoveryDir = handle.recoveryDir;
    if (handle.plan.changed) {
      stage = 'spec-publication';
      writeSpecDoc('claims', handle.plan.draft.path, handle.plan.doc, { publish: (output) => {
        if (output !== handle.plan.output) throw new Error('draft append serialized output changed');
        stage = 'started-journal';
        persistRecovery(join(handle.recoveryDir, 'started.json'), Buffer.from(JSON.stringify({ draft: handle.plan.draft.file, state: 'started' })));
        stage = 'write-preflight'; handle.assertCurrent();
        const bytes = Buffer.from(output, 'utf8');
        stage = 'draft-write'; report.writeAttempted = true;
        while (report.bytesWritten < bytes.length) {
          const offset = report.bytesWritten;
          const count = writeSync(handle.fd, bytes, offset, bytes.length - offset, offset);
          if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) throw new Error('draft write made no valid progress');
          report.bytesWritten += count;
        }
        stage = 'truncate'; ftruncateSync(handle.fd, bytes.length);
        stage = 'draft-fsync'; fsyncSync(handle.fd);
        stage = 'verification'; handle.assertOwned();
        const stat = fstatSync(handle.fd), identity = handle.plan.draft.identity;
        if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== identity.dev || stat.ino !== identity.ino || stat.mode !== identity.mode || stat.size !== bytes.length) throw new Error('draft descriptor verification failed');
        const buffer = Buffer.alloc(bytes.length + 1); let length = 0;
        while (length < buffer.length) {
          const count = readSync(handle.fd, buffer, length, buffer.length - length, length);
          if (!count) break;
          length += count;
        }
        if (length !== bytes.length || !buffer.subarray(0, length).equals(bytes)) throw new Error('draft byte verification failed');
        readSpecDoc('claims', handle.plan.draft.path, { source: buffer.subarray(0, length).toString('utf8') });
        const current = admitDraftAppend(request);
        if (current.projectDir !== handle.plan.projectDir || current.draft.source !== output || current.draft.identity.dev !== identity.dev || current.draft.identity.ino !== identity.ino || current.draft.identity.mode !== identity.mode || !isDeepStrictEqual(current.sources, handle.plan.sources)) throw new Error('draft or sources changed after write');
        handle.assertOwned();
      } });
      report.state = 'updated';
    } else { handle.assertCurrent(); report.state = 'unchanged'; }
    report.ok = true;
  } catch (error) {
    if (error.recoveryDir) report.recoveryDir = error.recoveryDir;
    if (error.lockRelease) report.release = error.lockRelease;
    fail(error);
  } finally {
    if (handle) {
      report.release = handle.release();
      if (!report.release.released) { stage = 'release'; fail(new Error(report.release.reason || 'resource release failed')); }
    }
  }
  if (report.recoveryDir) {
    stage = 'result-journal';
    try { persistRecovery(join(report.recoveryDir, 'result.json'), Buffer.from(JSON.stringify(report))); }
    catch (error) { fail(error); }
  }
  report.failed.forEach(Object.freeze); Object.freeze(report.failed);
  return Object.freeze(report);
}
