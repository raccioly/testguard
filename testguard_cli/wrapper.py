#!/usr/bin/env python3
"""
TestGuard CLI — Python wrapper.

Runs the Node.js TestGuard CLI so Python-centric teams can `pip install
testguard-cli` and use `testguard` without touching npm directly.
Node.js 20+ is required.

Resolution order:
  1. A locally installed `node_modules/testguard-cli/cli/testguard.mjs`,
     searched upward from the current directory — so a project that pins the
     package runs the PINNED version, offline and reproducibly.
  2. `npx -y testguard-cli@latest`.

Usage:
    pip install testguard-cli
    testguard claims
    testguard probe
"""

import os
import shutil
import subprocess
import sys

NODE_FLOOR = 20


def find_node():
    """Find a usable Node.js binary (>= NODE_FLOOR)."""
    for cmd in ("node", "node22", "node20"):
        path = shutil.which(cmd)
        if not path:
            continue
        try:
            version = subprocess.check_output(
                [path, "--version"], text=True, stderr=subprocess.DEVNULL
            ).strip()
            if int(version.lstrip("v").split(".")[0]) >= NODE_FLOOR:
                return path
        except (subprocess.CalledProcessError, ValueError):
            continue
    return None


def find_local_cli():
    """Resolve a locally installed CLI entry, walking up from cwd."""
    directory = os.getcwd()
    while True:
        entry = os.path.join(directory, "node_modules", "testguard-cli", "cli", "testguard.mjs")
        if os.path.isfile(entry):
            return entry
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def main():
    """Entry point for the `testguard` command."""
    args = sys.argv[1:]
    node = find_node()
    if not node:
        print(
            f"Error: Node.js {NODE_FLOOR}+ is required but not found.\n"
            "Install from https://nodejs.org/ or via nvm: nvm install 22",
            file=sys.stderr,
        )
        sys.exit(1)

    local_cli = find_local_cli()
    npx = shutil.which("npx")
    if local_cli:
        cmd = [node, local_cli] + args
    elif npx:
        cmd = [npx, "-y", "testguard-cli@latest"] + args
    else:
        print("Error: npx not found. Install Node.js 20+, which includes npm/npx.", file=sys.stderr)
        sys.exit(1)

    try:
        sys.exit(subprocess.run(cmd, check=False).returncode)
    except FileNotFoundError:
        print(f"Error: could not execute: {' '.join(cmd)}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
