---
name: openclaw-memory-ops
description: Deploy, bootstrap, and operate OpenClaw memory governance on a machine end-to-end, including capture, triage, status store, render, audit, prune, archive index, dashboard, and cron job registration.
---

# OpenClaw Memory Ops

Use this skill when the user asks to:
- set up the memory system on a new machine,
- make memory pipeline run consistently across machines,
- register or repair memory jobs,
- verify memory health and troubleshoot.

## Prerequisites
- OpenClaw repo is available locally.
- `node`, `pnpm`, and `openclaw` commands are installed.
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) is available for inbox triage.

## Default paths
- Memory root: `~/.openclaw-ytb/memory`
- Workspace root: `~/.openclaw-ytb/workspace`

## Scripts
Run scripts from this skill's `scripts/` folder.

1. Bootstrap once on a machine:
```bash
bash scripts/bootstrap_memory.sh --repo-root /path/to/openclaw --agent main
```

2. Register recurring jobs:
```bash
bash scripts/register_memory_jobs.sh --repo-root /path/to/openclaw --tz Asia/Ho_Chi_Minh
```

3. Check health:
```bash
bash scripts/memory_doctor.sh --repo-root /path/to/openclaw
```

4. Trigger one manual full cycle:
```bash
bash scripts/run_memory_cycle.sh --repo-root /path/to/openclaw --agent main
```

## Operational notes
- `bootstrap_memory.sh` initializes buckets and renders runtime files.
- `register_memory_jobs.sh` creates idempotent cron jobs by name.
- `memory_doctor.sh` validates files, counts bucket items, and runs audit.
- For dashboard service control, use repo script:
  - `./manage.sh memory start|stop|status|logs`
