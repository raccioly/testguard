# typed: false
# frozen_string_literal: true

# TestGuard Homebrew formula (Node CLI, installed from the npm registry tarball).
# Cookbook: https://docs.brew.sh/Node-for-Formula-Authors
#
# Publishing (this file stages the formula; taps live in their own repo):
#   1. Tap repo: github.com/raccioly/homebrew-tap — copy to Formula/testguard.rb
#   2. Users:  brew tap raccioly/tap && brew install raccioly/tap/testguard
#   3. Each release, bump `url` (synced by .github/scripts/sync-release-version.mjs)
#      and set `sha256` from the published tarball:
#        curl -sL https://registry.npmjs.org/testguard-cli/-/testguard-cli-<VER>.tgz | shasum -a 256
class Testguard < Formula
  desc "Proves a test suite defends the claims a project makes"
  homepage "https://github.com/raccioly/testguard"
  url "https://registry.npmjs.org/testguard-cli/-/testguard-cli-0.6.0.tgz"
  sha256 "385d69f9d3c153b934d9c1cb6a2c754eb9b221b0a8c0ba8b805858384d2d4678"
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
