#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${PWD}"
AGENT="main"
MEMORY_ROOT="${OPENCLAW_MEMORY_ROOT:-$HOME/.openclaw-ytb/memory}"
WORKSPACE_ROOT="${OPENCLAW_WORKSPACE_ROOT:-$HOME/.openclaw-ytb/workspace}"
LEGACY_MEMORY_MD=""
RUN_INSTALL="0"
SKIP_CAPTURE="0"
SKIP_TRIAGE="0"

usage() {
  cat <<USAGE
Usage:
  bash scripts/bootstrap_memory.sh [options]

Options:
  --repo-root <path>         OpenClaw repository root (default: current dir)
  --agent <name>             Agent id for capture (default: main)
  --memory-root <path>       Memory root (default: ~/.openclaw-ytb/memory)
  --workspace-root <path>    Workspace root (default: ~/.openclaw-ytb/workspace)
  --legacy-memory-md <path>  Optional legacy MEMORY.md to import first
  --install                  Run pnpm install before bootstrap
  --skip-capture             Skip memory:capture
  --skip-triage              Skip memory:inbox:triage
  -h, --help                 Show help
USAGE
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing command: $1" >&2
    exit 1
  }
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --memory-root) MEMORY_ROOT="$2"; shift 2 ;;
    --workspace-root) WORKSPACE_ROOT="$2"; shift 2 ;;
    --legacy-memory-md) LEGACY_MEMORY_MD="$2"; shift 2 ;;
    --install) RUN_INSTALL="1"; shift ;;
    --skip-capture) SKIP_CAPTURE="1"; shift ;;
    --skip-triage) SKIP_TRIAGE="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

need_cmd node
need_cmd pnpm

if [[ ! -f "$REPO_ROOT/package.json" ]]; then
  echo "Invalid repo root: $REPO_ROOT (missing package.json)" >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/scripts/memory-status-init.ts" ]]; then
  echo "Invalid repo root: $REPO_ROOT (missing memory scripts)" >&2
  exit 1
fi

export OPENCLAW_MEMORY_ROOT="$MEMORY_ROOT"
export OPENCLAW_WORKSPACE_ROOT="$WORKSPACE_ROOT"

mkdir -p "$OPENCLAW_MEMORY_ROOT" "$OPENCLAW_WORKSPACE_ROOT"

cd "$REPO_ROOT"

if [[ "$RUN_INSTALL" == "1" ]]; then
  echo "==> pnpm install"
  pnpm install
fi

echo "==> memory:status:init"
pnpm memory:status:init

if [[ -n "$LEGACY_MEMORY_MD" ]]; then
  if [[ -f "$LEGACY_MEMORY_MD" ]]; then
    echo "==> memory:import:legacy from $LEGACY_MEMORY_MD"
    pnpm memory:import:legacy --input "$LEGACY_MEMORY_MD"
    echo "==> memory:status:init (after legacy import)"
    pnpm memory:status:init
  else
    echo "Legacy file not found, skip: $LEGACY_MEMORY_MD"
  fi
fi

if [[ "$SKIP_CAPTURE" != "1" ]]; then
  echo "==> memory:capture --agent $AGENT"
  pnpm memory:capture --agent "$AGENT"
fi

if [[ "$SKIP_TRIAGE" != "1" ]]; then
  echo "==> memory:inbox:triage"
  set +e
  pnpm memory:inbox:triage
  TRIAGE_RC=$?
  set -e
  if [[ $TRIAGE_RC -ne 0 ]]; then
    echo "memory:inbox:triage failed (rc=$TRIAGE_RC)." >&2
    echo "Hint: set GEMINI_API_KEY (or GOOGLE_API_KEY), then rerun triage." >&2
    exit $TRIAGE_RC
  fi
fi

echo "==> memory:audit"
set +e
pnpm memory:audit
AUDIT_RC=$?
set -e
if [[ $AUDIT_RC -eq 2 ]]; then
  echo "Audit severe issues detected (rc=2). Fix issues before continuing." >&2
  exit 2
fi

echo "==> memory:render --replace"
pnpm memory:render --replace

echo "==> memory:archive:index"
pnpm memory:archive:index

echo ""
echo "Bootstrap completed"
echo "- repo root: $REPO_ROOT"
echo "- memory root: $OPENCLAW_MEMORY_ROOT"
echo "- workspace root: $OPENCLAW_WORKSPACE_ROOT"
echo "- audit rc: $AUDIT_RC"
