# typed: false
# frozen_string_literal: true

# TestGuard Homebrew formula (Node CLI, installed from the npm registry tarball).
# Cookbook: https://docs.brew.sh/Node-for-Formula-Authors
#
# Publishing (this file stages the formula; taps live in their own repo):
#   1. Tap repo: github.com/raccioly/homebrew-tap — copy to Formula/testguard.rb
#   2. Users:  brew tap raccioly/tap && brew install raccioly/tap/testguard
#   3. Each release, `url` is synced by .github/scripts/sync-release-version.mjs
#      (in the release PR) and `sha256` is set by release.yml AFTER `npm publish`,
#      from the registry tarball (`sync-release-version.mjs --sha256`), landing
#      as an auto-merged bot PR. `--check` refuses the placeholder this file
#      carried unchanged from v0.6.0 to v0.8.0. Nothing here is set by hand.
class Testguard < Formula
  desc "Proves a test suite defends the claims a project makes"
  homepage "https://github.com/raccioly/testguard"
  url "https://registry.npmjs.org/testguard-cli/-/testguard-cli-0.14.0.tgz"
  sha256 "7931292332345eee9a6f5deb118e3931f06396b06e98c41c227b0de99c78df1d"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/testguard --version")
  end
end
