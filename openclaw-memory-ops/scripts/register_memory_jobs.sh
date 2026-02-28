#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${PWD}"
TZ_NAME="Asia/Ho_Chi_Minh"
MEMORY_ROOT="${OPENCLAW_MEMORY_ROOT:-$HOME/.openclaw-ytb/memory}"
WORKSPACE_ROOT="${OPENCLAW_WORKSPACE_ROOT:-$HOME/.openclaw-ytb/workspace}"

usage() {
  cat <<USAGE
Usage:
  bash scripts/register_memory_jobs.sh [options]

Options:
  --repo-root <path>         OpenClaw repository root (default: current dir)
  --tz <timezone>            Cron timezone (default: Asia/Ho_Chi_Minh)
  --memory-root <path>       Memory root (default: ~/.openclaw-ytb/memory)
  --workspace-root <path>    Workspace root (default: ~/.openclaw-ytb/workspace)
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
    --tz) TZ_NAME="$2"; shift 2 ;;
    --memory-root) MEMORY_ROOT="$2"; shift 2 ;;
    --workspace-root) WORKSPACE_ROOT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

need_cmd openclaw
need_cmd rg

if [[ ! -f "$REPO_ROOT/package.json" ]]; then
  echo "Invalid repo root: $REPO_ROOT (missing package.json)" >&2
  exit 1
fi

job_exists() {
  local name="$1"
  openclaw cron list 2>/dev/null | rg -F -- "$name" >/dev/null 2>&1
}

add_job_if_missing() {
  local name="$1"
  local cron_expr="$2"
  local message="$3"

  if job_exists "$name"; then
    echo "- skip existing job: $name"
    return 0
  fi

  echo "- add job: $name"
  openclaw cron add \
    --name "$name" \
    --cron "$cron_expr" \
    --tz "$TZ_NAME" \
    --session isolated \
    --message "$message"
}

CAPTURE_MSG="export OPENCLAW_MEMORY_ROOT=$MEMORY_ROOT && cd $REPO_ROOT && pnpm memory:capture --agent main"
TRIAGE_MSG="export OPENCLAW_MEMORY_ROOT=$MEMORY_ROOT && export OPENCLAW_WORKSPACE_ROOT=$WORKSPACE_ROOT && cd $REPO_ROOT && pnpm memory:inbox:triage"
AUDIT_MSG="export OPENCLAW_MEMORY_ROOT=$MEMORY_ROOT && cd $REPO_ROOT && pnpm memory:audit"
PRUNE_MSG="export OPENCLAW_MEMORY_ROOT=$MEMORY_ROOT && export OPENCLAW_WORKSPACE_ROOT=$WORKSPACE_ROOT && cd $REPO_ROOT && pnpm memory:prune:apply && pnpm memory:archive:index && pnpm memory:render --output $WORKSPACE_ROOT/MEMORY.md"

echo "Registering memory jobs (idempotent by name)"
add_job_if_missing "Memory capture from session" "30 1 * * *" "$CAPTURE_MSG"
add_job_if_missing "Memory inbox triage" "32 1 * * *" "$TRIAGE_MSG"
add_job_if_missing "Memory audit" "0 2 * * *" "$AUDIT_MSG"
add_job_if_missing "Memory prune weekly" "0 3 * * 1" "$PRUNE_MSG"

echo ""
echo "Done. Current jobs:"
openclaw cron list
