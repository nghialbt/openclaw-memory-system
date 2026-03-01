#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd 2>/dev/null || pwd)"
LOCAL_INSTALLER="$SCRIPT_DIR/install.mjs"

if [[ -f "$LOCAL_INSTALLER" ]]; then
  node "$LOCAL_INSTALLER" "$@"
  exit $?
fi

# Support piped execution (curl ... | bash)
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL "https://codeload.github.com/nghialbt/openclaw-memory-system/tar.gz/refs/heads/main" \
  | tar -xzf - -C "$TMP_DIR"

node "$TMP_DIR/openclaw-memory-system-main/install.mjs" "$@"
