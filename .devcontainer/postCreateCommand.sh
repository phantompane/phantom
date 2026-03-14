#!/usr/bin/env bash
set -euo pipefail

sudo chown -R vscode:vscode ./.devenv

if ! command -v devenv >/dev/null 2>&1; then
  nix profile add nixpkgs#devenv
fi
