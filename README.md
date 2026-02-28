# OpenClaw Memory System

Portable skill bundle for deploying and operating the OpenClaw memory pipeline.

## Quick install (one command)

Set key first (optional but recommended for auto-triage):
```bash
export GEMINI_API_KEY="<your_key>"
```

Run installer from GitHub:
```bash
curl -fsSL https://raw.githubusercontent.com/nghialbt/openclaw-memory-system/main/install.sh | \
  bash -s -- --openclaw-repo /path/to/openclaw --tz Asia/Ho_Chi_Minh
```

What this installer does:
- Installs skill into `~/.codex/skills/openclaw-memory-ops`.
- Bootstraps memory pipeline (`status:init`, capture, audit, render, archive index).
- Registers recurring jobs (capture, triage, audit, prune weekly).

## Skill path
- `openclaw-memory-ops/`

## Included scripts
- `openclaw-memory-ops/scripts/bootstrap_memory.sh`
- `openclaw-memory-ops/scripts/register_memory_jobs.sh`
- `openclaw-memory-ops/scripts/run_memory_cycle.sh`
- `openclaw-memory-ops/scripts/memory_doctor.sh`

## Manual install
```bash
git clone https://github.com/nghialbt/openclaw-memory-system.git
mkdir -p ~/.codex/skills
cp -R openclaw-memory-system/openclaw-memory-ops ~/.codex/skills/
```
