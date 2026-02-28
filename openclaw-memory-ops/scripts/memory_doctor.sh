#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${PWD}"
MEMORY_ROOT="${OPENCLAW_MEMORY_ROOT:-$HOME/.openclaw-ytb/memory}"
WORKSPACE_ROOT="${OPENCLAW_WORKSPACE_ROOT:-$HOME/.openclaw-ytb/workspace}"

usage() {
  cat <<USAGE
Usage:
  bash scripts/memory_doctor.sh [options]

Options:
  --repo-root <path>         OpenClaw repository root (default: current dir)
  --memory-root <path>       Memory root (default: ~/.openclaw-ytb/memory)
  --workspace-root <path>    Workspace root (default: ~/.openclaw-ytb/workspace)
  -h, --help                 Show help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --memory-root) MEMORY_ROOT="$2"; shift 2 ;;
    --workspace-root) WORKSPACE_ROOT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

need_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "[missing] $path"
    return 1
  fi
  echo "[ok]      $path"
  return 0
}

count_items() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo 0
    return
  fi
  rg -c "^- id:" "$file" 2>/dev/null || echo 0
}

export OPENCLAW_MEMORY_ROOT="$MEMORY_ROOT"
export OPENCLAW_WORKSPACE_ROOT="$WORKSPACE_ROOT"

echo "Memory doctor"
echo "- repo root: $REPO_ROOT"
echo "- memory root: $OPENCLAW_MEMORY_ROOT"
echo "- workspace root: $OPENCLAW_WORKSPACE_ROOT"

echo ""
echo "File checks:"
need_file "$OPENCLAW_MEMORY_ROOT/MEMORY.yml" || true
need_file "$OPENCLAW_MEMORY_ROOT/status/active.yml" || true
need_file "$OPENCLAW_MEMORY_ROOT/status/pending.yml" || true
need_file "$OPENCLAW_MEMORY_ROOT/status/deprecated.yml" || true
need_file "$OPENCLAW_WORKSPACE_ROOT/MEMORY.md" || true

echo ""
echo "Bucket counts:"
echo "- active:     $(count_items "$OPENCLAW_MEMORY_ROOT/status/active.yml")"
echo "- pending:    $(count_items "$OPENCLAW_MEMORY_ROOT/status/pending.yml")"
echo "- deprecated: $(count_items "$OPENCLAW_MEMORY_ROOT/status/deprecated.yml")"

echo ""
echo "Audit:"
cd "$REPO_ROOT"
set +e
pnpm memory:audit
AUDIT_RC=$?
set -e
echo "- audit exit code: $AUDIT_RC (0=clean, 1=stale-only, 2=severe)"

if command -v curl >/dev/null 2>&1; then
  echo ""
  echo "Dashboard health:"
  if curl -fsS "http://127.0.0.1:3903/api/summary" >/dev/null 2>&1; then
    echo "- dashboard: ready on http://127.0.0.1:3903"
  else
    echo "- dashboard: unreachable on http://127.0.0.1:3903"
  fi
fi

exit "$AUDIT_RC"
