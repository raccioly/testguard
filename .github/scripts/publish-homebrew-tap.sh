#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "usage: publish-homebrew-tap.sh <stable-semver>"

SOURCE_FORMULA="${HOMEBREW_TAP_SOURCE:-packaging/homebrew/testguard.rb}"
TAP_REMOTE="${HOMEBREW_TAP_REMOTE:-git@github.com:raccioly/homebrew-tap.git}"
[[ -f "$SOURCE_FORMULA" ]] || fail "source formula not found: $SOURCE_FORMULA"

FORMULA_VERSION=$(sed -nE 's#^[[:space:]]*url ".*testguard-cli-([0-9]+\.[0-9]+\.[0-9]+)\.tgz"#\1#p' "$SOURCE_FORMULA")
FORMULA_SHA=$(sed -nE 's/^[[:space:]]*sha256 "([0-9a-f]+)"/\1/p' "$SOURCE_FORMULA")
[[ "$FORMULA_VERSION" = "$VERSION" ]] || fail "formula version $FORMULA_VERSION does not match release $VERSION"
[[ "$FORMULA_SHA" =~ ^[0-9a-f]{64}$ ]] || fail "formula sha256 is not 64 lowercase hex characters"

TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
[[ -d "$TEMP_ROOT" ]] || fail "temporary root does not exist: $TEMP_ROOT"
WORK_DIR=$(mktemp -d "$TEMP_ROOT/testguard-homebrew-tap.XXXXXX")

cleanup() {
  case "$WORK_DIR" in
    "$TEMP_ROOT"/testguard-homebrew-tap.*) rm -rf -- "$WORK_DIR" ;;
    *) echo "::warning::refusing to remove unexpected temporary path: $WORK_DIR" >&2 ;;
  esac
}
trap cleanup EXIT

if [[ "$TAP_REMOTE" = git@github.com:* ]]; then
  [[ -n "${HOMEBREW_TAP_DEPLOY_KEY:-}" ]] || fail "HOMEBREW_TAP_DEPLOY_KEY is required for the GitHub tap"
  command -v gh >/dev/null || fail "gh is required to verify GitHub's SSH host keys"
  KEY_FILE="$WORK_DIR/deploy_key"
  KNOWN_HOSTS="$WORK_DIR/known_hosts"
  umask 077
  printf '%s\n' "$HOMEBREW_TAP_DEPLOY_KEY" > "$KEY_FILE"
  gh api meta --jq '.ssh_keys[] | "github.com " + .' > "$KNOWN_HOSTS"
  [[ -s "$KNOWN_HOSTS" ]] || fail "GitHub API returned no SSH host keys"
  export GIT_SSH_COMMAND="ssh -i \"$KEY_FILE\" -o IdentitiesOnly=yes -o UserKnownHostsFile=\"$KNOWN_HOSTS\" -o StrictHostKeyChecking=yes"
fi

TAP_DIR="$WORK_DIR/tap"
git clone --quiet --depth 1 "$TAP_REMOTE" "$TAP_DIR"
TAP_FORMULA="$TAP_DIR/Formula/testguard.rb"
[[ -f "$TAP_FORMULA" ]] || fail "tap is missing Formula/testguard.rb"

if cmp -s "$SOURCE_FORMULA" "$TAP_FORMULA"; then
  echo "✅ raccioly/tap already carries TestGuard v$VERSION ($FORMULA_SHA)"
  exit 0
fi

install -m 0644 "$SOURCE_FORMULA" "$TAP_FORMULA"
ruby -c "$TAP_FORMULA" >/dev/null
git -C "$TAP_DIR" diff --check
git -C "$TAP_DIR" config user.name "github-actions[bot]"
git -C "$TAP_DIR" config user.email "github-actions[bot]@users.noreply.github.com"
git -C "$TAP_DIR" add Formula/testguard.rb
git -C "$TAP_DIR" commit --quiet -m "testguard $VERSION" -m "Published from raccioly/testguard's release workflow."
git -C "$TAP_DIR" push --quiet origin HEAD:main
git -C "$TAP_DIR" fetch --quiet origin main
cmp "$SOURCE_FORMULA" <(git -C "$TAP_DIR" show origin/main:Formula/testguard.rb) \
  || fail "live tap does not match the validated source formula after push"

echo "✅ published TestGuard v$VERSION to raccioly/tap ($FORMULA_SHA)"
