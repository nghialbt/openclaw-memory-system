#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${PWD}"
AGENT="main"
MEMORY_ROOT="${OPENCLAW_MEMORY_ROOT:-$HOME/.openclaw-ytb/memory}"
WORKSPACE_ROOT="${OPENCLAW_WORKSPACE_ROOT:-$HOME/.openclaw-ytb/workspace}"

usage() {
  cat <<USAGE
Usage:
  bash scripts/run_memory_cycle.sh [options]

Options:
  --repo-root <path>         OpenClaw repository root (default: current dir)
  --agent <name>             Agent id for capture (default: main)
  --memory-root <path>       Memory root (default: ~/.openclaw-ytb/memory)
  --workspace-root <path>    Workspace root (default: ~/.openclaw-ytb/workspace)
  -h, --help                 Show help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --memory-root) MEMORY_ROOT="$2"; shift 2 ;;
    --workspace-root) WORKSPACE_ROOT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

export OPENCLAW_MEMORY_ROOT="$MEMORY_ROOT"
export OPENCLAW_WORKSPACE_ROOT="$WORKSPACE_ROOT"

cd "$REPO_ROOT"

pnpm memory:capture --agent "$AGENT"
pnpm memory:inbox:triage
set +e
pnpm memory:audit
AUDIT_RC=$?
set -e
pnpm memory:render
pnpm memory:archive:index

echo "cycle done (audit rc=$AUDIT_RC)"
exit "$AUDIT_RC"
