#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_REPO=""
AGENT="main"
TZ_NAME="Asia/Ho_Chi_Minh"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
SKILLS_DIR=""
RUN_BOOTSTRAP="1"
RUN_REGISTER_JOBS="1"
MEMORY_ROOT="${OPENCLAW_MEMORY_ROOT:-$HOME/.openclaw-ytb/memory}"
WORKSPACE_ROOT="${OPENCLAW_WORKSPACE_ROOT:-$HOME/.openclaw-ytb/workspace}"

usage() {
  cat <<USAGE
Usage:
  bash install.sh --openclaw-repo /path/to/openclaw [options]

Options:
  --openclaw-repo <path>     OpenClaw repo path (required)
  --agent <name>             Agent for capture bootstrap (default: main)
  --tz <timezone>            Cron timezone (default: Asia/Ho_Chi_Minh)
  --codex-home <path>        Codex home (default: \$CODEX_HOME or ~/.codex)
  --skills-dir <path>        Skill target dir (default: <codex-home>/skills)
  --memory-root <path>       OPENCLAW_MEMORY_ROOT target
  --workspace-root <path>    OPENCLAW_WORKSPACE_ROOT target
  --skip-bootstrap           Install skill only, do not run bootstrap
  --skip-jobs                Do not register cron jobs
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
    --openclaw-repo) OPENCLAW_REPO="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --tz) TZ_NAME="$2"; shift 2 ;;
    --codex-home) CODEX_HOME_DIR="$2"; shift 2 ;;
    --skills-dir) SKILLS_DIR="$2"; shift 2 ;;
    --memory-root) MEMORY_ROOT="$2"; shift 2 ;;
    --workspace-root) WORKSPACE_ROOT="$2"; shift 2 ;;
    --skip-bootstrap) RUN_BOOTSTRAP="0"; shift ;;
    --skip-jobs) RUN_REGISTER_JOBS="0"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$OPENCLAW_REPO" ]]; then
  echo "--openclaw-repo is required" >&2
  usage
  exit 1
fi

need_cmd bash
need_cmd rsync
need_cmd pnpm
need_cmd node

if [[ "$RUN_REGISTER_JOBS" == "1" ]]; then
  need_cmd openclaw
fi

if [[ ! -f "$OPENCLAW_REPO/package.json" ]]; then
  echo "Invalid OpenClaw repo: $OPENCLAW_REPO (missing package.json)" >&2
  exit 1
fi
if [[ ! -f "$OPENCLAW_REPO/manage.sh" ]]; then
  echo "Invalid OpenClaw repo: $OPENCLAW_REPO (missing manage.sh)" >&2
  exit 1
fi

if [[ -z "$SKILLS_DIR" ]]; then
  SKILLS_DIR="$CODEX_HOME_DIR/skills"
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/openclaw-memory-ops"
DST_DIR="$SKILLS_DIR/openclaw-memory-ops"

if [[ ! -f "$SRC_DIR/SKILL.md" ]]; then
  echo "Skill source missing: $SRC_DIR" >&2
  exit 1
fi

mkdir -p "$SKILLS_DIR"
rsync -a --delete "$SRC_DIR/" "$DST_DIR/"

echo "Installed skill to: $DST_DIR"

export OPENCLAW_MEMORY_ROOT="$MEMORY_ROOT"
export OPENCLAW_WORKSPACE_ROOT="$WORKSPACE_ROOT"

if [[ "$RUN_BOOTSTRAP" == "1" ]]; then
  BOOTSTRAP_SCRIPT="$DST_DIR/scripts/bootstrap_memory.sh"
  if [[ ! -x "$BOOTSTRAP_SCRIPT" ]]; then
    chmod +x "$BOOTSTRAP_SCRIPT"
  fi

  TRIAGE_SKIP=0
  if [[ -z "${GEMINI_API_KEY:-}" && -z "${GOOGLE_API_KEY:-}" ]]; then
    TRIAGE_SKIP=1
    echo "No GEMINI_API_KEY/GOOGLE_API_KEY detected; bootstrap will run with --skip-triage."
  fi

  if [[ "$TRIAGE_SKIP" == "1" ]]; then
    bash "$BOOTSTRAP_SCRIPT" \
      --repo-root "$OPENCLAW_REPO" \
      --agent "$AGENT" \
      --memory-root "$OPENCLAW_MEMORY_ROOT" \
      --workspace-root "$OPENCLAW_WORKSPACE_ROOT" \
      --skip-triage
  else
    bash "$BOOTSTRAP_SCRIPT" \
      --repo-root "$OPENCLAW_REPO" \
      --agent "$AGENT" \
      --memory-root "$OPENCLAW_MEMORY_ROOT" \
      --workspace-root "$OPENCLAW_WORKSPACE_ROOT"
  fi
fi

if [[ "$RUN_REGISTER_JOBS" == "1" ]]; then
  REGISTER_SCRIPT="$DST_DIR/scripts/register_memory_jobs.sh"
  if [[ ! -x "$REGISTER_SCRIPT" ]]; then
    chmod +x "$REGISTER_SCRIPT"
  fi
  bash "$REGISTER_SCRIPT" \
    --repo-root "$OPENCLAW_REPO" \
    --tz "$TZ_NAME" \
    --memory-root "$OPENCLAW_MEMORY_ROOT" \
    --workspace-root "$OPENCLAW_WORKSPACE_ROOT"
fi

echo ""
echo "Setup completed"
echo "- OpenClaw repo: $OPENCLAW_REPO"
echo "- Skill dir: $DST_DIR"
echo "- Memory root: $OPENCLAW_MEMORY_ROOT"
echo "- Workspace root: $OPENCLAW_WORKSPACE_ROOT"
echo ""
echo "Next:"
echo "1) Restart Codex/OpenClaw app to load new skill metadata."
echo "2) Start dashboard: cd $OPENCLAW_REPO && ./manage.sh memory start"
echo "3) Open: http://127.0.0.1:3903/"
