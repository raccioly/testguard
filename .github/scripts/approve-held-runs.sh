#!/usr/bin/env bash

# Clear GitHub's first-time-contributor hold from workflow runs created for a
# GITHUB_TOKEN-authored pull request. The repository requires that approval,
# and github-actions[bot] can never graduate from it because it does not author
# the squash commit that lands on main.

set -euo pipefail

HEAD_SHA="${1:?usage: approve-held-runs.sh HEAD_SHA PR_URL}"
PR_URL="${2:?usage: approve-held-runs.sh HEAD_SHA PR_URL}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

POLL_SECONDS="${TESTGUARD_HELD_RUN_POLL_SECONDS:-10}"
approved=0

held_ids() {
  gh api "repos/${GITHUB_REPOSITORY}/actions/runs?head_sha=${HEAD_SHA}" \
    --jq '[.workflow_runs[] | select(.status == "action_required" or .conclusion == "action_required") | .id] | .[]'
}

held_urls() {
  gh api "repos/${GITHUB_REPOSITORY}/actions/runs?head_sha=${HEAD_SHA}" \
    --jq '[.workflow_runs[] | select(.status == "action_required" or .conclusion == "action_required") | .html_url] | .[]'
}

echo "Clearing held workflow runs on $HEAD_SHA"
for attempt in 1 2 3 4 5 6; do
  # Fail closed. Treating an API failure as "no held runs" would report that
  # auto-merge can proceed while leaving the PR queued forever.
  if ! HELD=$(held_ids); then
    echo "::error::Could not inspect workflow approval holds for $HEAD_SHA; auto-merge on $PR_URL may remain blocked."
    exit 1
  fi

  for id in $HELD; do
    if gh api -X POST "repos/${GITHUB_REPOSITORY}/actions/runs/${id}/approve" >/dev/null 2>&1; then
      echo "  approved run $id"
      approved=$((approved + 1))
    else
      # A run can leave action_required between the query and the POST. The
      # final query decides whether that race is harmless.
      echo "  run $id needed no approval"
    fi
  done

  # Runs appear asynchronously. Once one was approved, the first empty query
  # is terminal; when this repository gate does not apply, three empty polls
  # are enough to establish that without paying the full minute.
  if [ -z "$HELD" ] && { [ "$approved" -gt 0 ] || [ "$attempt" -ge 3 ]; }; then
    break
  fi
  if [ "$attempt" -lt 6 ]; then sleep "$POLL_SECONDS"; fi
done

if ! STILL=$(held_urls); then
  echo "::error::Could not verify workflow approval holds for $HEAD_SHA; auto-merge on $PR_URL may remain blocked."
  exit 1
fi
if [ -n "$STILL" ]; then
  echo "::error::Workflow runs are still held for approval, so auto-merge on $PR_URL will wait forever. Approve them, or re-run this workflow: $STILL"
  exit 1
fi
echo "✅ no run is held for approval; auto-merge can complete"
