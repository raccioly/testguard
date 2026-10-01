import { chmodSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { authoringLock, persistRecovery, recoveryBase } from '../claims/annotation-placement.mjs';
import { sha256 } from '../util/hash.mjs';
import { planDraftAppend } from './plan-append.mjs';

function freezeOwned(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

/** Preparation only: current-plan replay and recovery, never draft writes. */
export function prepareDraftAppend({ request, plan }) {
  const initial = planDraftAppend(request);
  if (!isDeepStrictEqual(initial, plan)) throw new Error('draft append plan changed');
  if (!initial.changed) return freezeOwned({ ready: true, plan: initial, release: () => ({ released: true }), assertOwned: () => {} });
  // All cooperative source/draft authoring in the checkout shares this lock.
  const lock = authoringLock(initial.projectDir);
  let recoveryDir;
  try {
    const fresh = planDraftAppend(request);
    if (!isDeepStrictEqual(fresh, initial)) throw new Error('draft append plan changed under lock');
    lock.assertOwned();
    recoveryDir = mkdtempSync(join(recoveryBase(fresh.projectDir), 'testguard-draft-recovery-'));
    chmodSync(recoveryDir, 0o700);
    persistRecovery(join(recoveryDir, 'draft.original'), Buffer.from(fresh.draft.source, 'utf8'));
    const manifest = {
      state: 'prepared', projectDir: fresh.projectDir, draftPath: fresh.draft.path,
      claimId: fresh.claimId, sourceHash: fresh.draft.hash,
      proposedHash: sha256(Buffer.from(fresh.output, 'utf8')), identity: fresh.draft.identity,
      sources: fresh.sources.map(({ file, hash, identity }) => ({ file, hash, identity })),
    };
    persistRecovery(join(recoveryDir, 'manifest.json'), Buffer.from(JSON.stringify(manifest), 'utf8'));
    lock.assertOwned();
    return freezeOwned({ ready: true, plan: fresh, recoveryDir, release: lock.release, assertOwned: lock.assertOwned });
  } catch (error) {
    if (recoveryDir) error.recoveryDir = recoveryDir;
    try { error.lockRelease = lock.release(); }
    catch (releaseError) { error.lockRelease = { released: false, reason: 'lock-release-failed', error: releaseError.message }; }
    throw error;
  }
}
