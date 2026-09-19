import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { git } from '../git.mjs';
import { SOURCE_EXT, isDefaultExcluded, isTestFile } from '../gate/changed.mjs';
import { walk } from '../util/glob.mjs';

export const HISTORY_COMMITS = 200;
export const HIGH_CHURN_MODULES = 20;
export const RANKED_UNCLAIMED = 10;

const RISK_SIGNALS = Object.freeze([
  ['security', /(^|[._/-])(auth|authn|authz|authorization|credential|crypto|login|password|permission|rbac|secret|security|session|token)([._/-]|$)/i],
  ['money', /(^|[._/-])(billing|checkout|invoice|money|payment|payout|price|pricing|refund)([._/-]|$)/i],
]);

const pathRiskSignals = (file) => RISK_SIGNALS.filter(([, re]) => re.test(file)).map(([name]) => name);

function listedFiles(projectDir) {
  try {
    return git(['ls-files', '-co', '--exclude-standard', '-z', '--', '.'], projectDir).split('\0').filter(Boolean);
  } catch {
    return walk(projectDir);
  }
}

function claimableModules(projectDir) {
  return listedFiles(projectDir).filter((file) =>
    existsSync(join(projectDir, file)) &&
    SOURCE_EXT.has(extname(file)) &&
    !isTestFile(file) &&
    !isDefaultExcluded(file));
}

function recentChanges(projectDir, sourceModules) {
  const counts = new Map();
  try {
    const commitsRead = Number(git(['rev-list', '--count', `--max-count=${HISTORY_COMMITS}`, 'HEAD', '--', '.'], projectDir));
    const paths = git(['log', '--relative', '-n', String(HISTORY_COMMITS), '--pretty=format:', '--name-only', '-z', '--', '.'], projectDir).split('\0').filter(Boolean);
    for (const file of paths) if (sourceModules.has(file)) counts.set(file, (counts.get(file) ?? 0) + 1);
    return { available: true, commitsRead, counts };
  } catch {
    return { available: false, commitsRead: 0, counts };
  }
}

/**
 * The denominator `probe` cannot provide: current source modules carrying at
 * least one fault, plus concrete unclaimed modules ranked by bounded git
 * history. Churn and path-risk remain separate facts; there is no score.
 */
export function computeClaimedSurface({ projectDir, claims }) {
  const modules = new Set(claimableModules(projectDir));
  const claimedFiles = new Set((claims?.claims ?? []).flatMap((claim) => claim.faults.map((fault) => fault.file)));
  const claimed = new Set([...modules].filter((file) => claimedFiles.has(file)));
  const history = recentChanges(projectDir, modules);
  const describe = (file) => ({ file, changes: history.counts.get(file) ?? 0, riskSignals: pathRiskSignals(file) });
  const ranked = [...modules].map(describe).sort((a, b) =>
    b.changes - a.changes || b.riskSignals.length - a.riskSignals.length || a.file.localeCompare(b.file));
  const highChurn = ranked.slice(0, Math.min(HIGH_CHURN_MODULES, ranked.length));
  const rankedUnclaimed = ranked.filter((item) => !claimed.has(item.file)).slice(0, RANKED_UNCLAIMED);
  return {
    sourceModules: modules.size,
    claimedModules: claimed.size,
    unclaimedModules: modules.size - claimed.size,
    history: { available: history.available, maxCommits: HISTORY_COMMITS, commitsRead: history.commitsRead },
    highChurn: { modules: highChurn.length, claimed: highChurn.filter((item) => claimed.has(item.file)).length },
    rankedUnclaimed,
  };
}

/** Expand the claim surface only when most current source modules are unseen. */
export const needsClaimExpansion = (surface) => surface.unclaimedModules > surface.claimedModules && surface.rankedUnclaimed.length > 0;
