import { constants, closeSync, fstatSync, openSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { planDraftAppend } from './plan-append.mjs';
import { prepareDraftAppend } from './prepare-append.mjs';

/** Acquire a checked descriptor; no draft writes and no implicit truncation. */
export function openDraftAppend({ request, plan }) {
  const prepared = prepareDraftAppend({ request, plan });
  let fd, closed = false, releaseResult;
  function release() {
    if (closed) return releaseResult;
    closed = true;
    let closeError;
    try { if (fd !== undefined) closeSync(fd); } catch (error) { closeError = error; }
    let lockRelease;
    try { lockRelease = prepared.release(); }
    catch (error) { lockRelease = { released: false, reason: 'lock-release-failed', error: error.message }; }
    releaseResult = closeError ? { released: false, reason: 'descriptor-close-failed', error: closeError.message, lockRelease } : lockRelease;
    return releaseResult;
  }
  function assertCurrent() {
    if (closed) throw new Error('draft append descriptor closed');
    prepared.assertOwned();
    if (!isDeepStrictEqual(planDraftAppend(request), prepared.plan)) throw new Error('draft append inputs changed before write');
    if (fd !== undefined) {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || Object.entries(prepared.plan.draft.identity).some(([key, value]) => stat[key] !== value)) throw new Error('draft append descriptor changed');
    }
    prepared.assertOwned();
  }
  try {
    assertCurrent();
    if (prepared.plan.changed) {
      if (constants.O_NOFOLLOW === undefined) throw new Error('draft append nofollow unavailable');
      fd = openSync(prepared.plan.draft.path, constants.O_RDWR | constants.O_NOFOLLOW);
      assertCurrent();
    }
    return Object.freeze({ ...prepared, fd, assertCurrent, release });
  } catch (error) {
    if (prepared.recoveryDir) error.recoveryDir = prepared.recoveryDir;
    error.lockRelease = release();
    throw error;
  }
}
