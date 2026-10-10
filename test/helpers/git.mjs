import { devNull } from 'node:os';

/**
 * Leading options for every git call a test makes to build or inspect a
 * fixture repository. A fixture must not depend on the machine's global git
 * config: a global `core.hooksPath` (agent sandboxes, husky-style setups) or
 * `commit.gpgsign=true` once turned 142 tests red on a contributor machine
 * while CI, whose runners carry no global config, stayed green and could
 * never reproduce it.
 *
 * Per invocation, never environment-wide: the product code under test still
 * runs against the ambient config, and the CI `hermeticity` job runs the
 * suite under a hostile one so both halves stay honest.
 */
export const FIXTURE_GIT = Object.freeze([
  '-c', `core.hooksPath=${devNull}`,
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
]);
