/**
 * API glue for .github/workflows/jules-triage.yml. Every decision is made by
 * jules-policy.mjs; this only gathers its inputs and carries out its answer.
 *
 * Runs under pull_request_target (write scope) from the default branch. It
 * reads PR metadata through the API and never checks out or executes PR code.
 *
 * Comments never mention the agent by handle: with Jules' Reactive Mode on,
 * a mention is an instruction, and a closed PR is not one to act on.
 */
import { DECLINE_WINDOW_DAYS, LABELS, isJules, triage } from './jules-policy.mjs';

const MARKER = '<!-- testguard-jules:triage -->';
const COLORS = {
  [LABELS.noise]: 'CCCCCC', [LABELS.duplicate]: 'CCCCCC', [LABELS.declined]: 'CCCCCC',
  [LABELS.queueFull]: 'FBCA04', [LABELS.review]: 'B60205', [LABELS.eligible]: '0E8A16',
};

export async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const number = context.payload.pull_request.number;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  if (!isJules(pr.user.login) || pr.state !== 'open') { core.info(`#${number}: not an open Jules PR`); return; }

  const filesOf = async (n) => (await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: n, per_page: 100 }))
    .map((f) => ({ filename: f.filename, status: f.status }));
  const shape = async (p) => ({
    number: p.number, title: p.title, labels: p.labels, mergedAt: p.merged_at, closedAt: p.closed_at,
    files: (await filesOf(p.number)).map((f) => f.filename),
  });

  const now = new Date().toISOString();
  const openJules = (await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', per_page: 100 }))
    .filter((p) => isJules(p.user.login) && p.number !== number);
  const cutoff = Date.now() - DECLINE_WINDOW_DAYS * 86_400_000;
  const { data: recent } = await github.rest.pulls.list({ owner, repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 });
  const closedJules = recent.filter((p) => isJules(p.user.login) && p.closed_at && Date.parse(p.closed_at) >= cutoff);

  const decision = triage({
    pr: { number, title: pr.title, files: await filesOf(number) },
    open: await Promise.all(openJules.map(shape)),
    closed: await Promise.all(closedJules.map(shape)),
    now,
  });
  core.info(`#${number}: ${decision.action} (${decision.label}) — ${decision.reason}`);

  await github.rest.issues.createLabel({ owner, repo, name: decision.label, color: COLORS[decision.label] ?? 'CCCCCC' }).catch(() => {});
  await github.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [decision.label] });

  if (decision.action === 'close') {
    await github.rest.issues.createComment({
      owner, repo, issue_number: number,
      body: `${MARKER}\n**Closed automatically:** ${decision.reason}.\n\n`
        + 'Jules PRs on this repository follow the policy in `.github/scripts/jules-policy.mjs` and the '
        + '**Automated agents** section of `AGENTS.md`: one PR per routine target, a target is not re-proposed '
        + 'while it is open or for 60 days after it was declined, and at most five wait for review at once. '
        + 'A maintainer can reopen this if the policy got it wrong.',
    });
    await github.rest.pulls.update({ owner, repo, pull_number: number, state: 'closed' });
    return;
  }
  await github.rest.issues.createComment({
    owner, repo, issue_number: number,
    body: decision.label === LABELS.eligible
      ? `${MARKER}\n**Eligible to merge on green CI** — ${decision.reason}. The auto-merge workflow re-checks the exact head and the claims file before it merges.`
      : `${MARKER}\n**Needs a maintainer** — ${decision.reason}. CI still runs; nothing merges without a human.`,
  });
}
