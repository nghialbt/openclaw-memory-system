---
name: openclaw-memory-ops
description: Deploy and operate OpenClaw memory pipeline with cross-platform support (macOS/Linux/Windows), capability detection, and safe fallback when runtime branch is missing memory scripts.
---

# OpenClaw Memory Ops

Use this skill when the user asks to:
- set up memory system on a new machine,
- run memory pipeline consistently across machines,
- register/repair memory jobs,
- debug why memory jobs/dashboard do not run.

## Cross-platform support
- macOS/Linux: Bash wrappers + Node core.
- Windows: PowerShell wrappers + Node core.
- Core logic is in `scripts/memory_ops.mjs`.

## Important behavior
This skill now detects runtime capability before running automation:
- If target repo lacks required `memory:*` scripts, installer can auto-inject a compatible memory runtime pack into that repo.
- The pack adds missing `memory:*` scripts, required deps, and allows bootstrap/jobs/dashboard commands to run.
- You can disable injection with `--skip-runtime-inject`.

## Prerequisites
- OpenClaw repo is available locally.
- `node` and `pnpm` installed.
- For job registration: `openclaw` CLI available.
- For auto-triage: `GEMINI_API_KEY` or `GOOGLE_API_KEY`.

## Commands

### 1) Bootstrap (first run)
macOS/Linux:
```bash
bash scripts/bootstrap_memory.sh --repo-root /path/to/openclaw --agent main
```

Windows (PowerShell):
```powershell
.\scripts\bootstrap_memory.ps1 --repo-root C:\path\to\openclaw --agent main
```

### 2) Register jobs
macOS/Linux:
```bash
bash scripts/register_memory_jobs.sh --repo-root /path/to/openclaw --tz Asia/Ho_Chi_Minh
```

Windows:
```powershell
.\scripts\register_memory_jobs.ps1 --repo-root C:\path\to\openclaw --tz Asia/Ho_Chi_Minh
```

### 3) Run one cycle manually
macOS/Linux:
```bash
bash scripts/run_memory_cycle.sh --repo-root /path/to/openclaw --agent main
```

Windows:
```powershell
.\scripts\run_memory_cycle.ps1 --repo-root C:\path\to\openclaw --agent main
```

### 4) Doctor/health check
macOS/Linux:
```bash
bash scripts/memory_doctor.sh --repo-root /path/to/openclaw
```

Windows:
```powershell
.\scripts\memory_doctor.ps1 --repo-root C:\path\to\openclaw
```

## Notes
- Dashboard startup command depends on target repo runtime (`manage.sh` or `manage.ps1` and/or `memory:dashboard:web`).
- Use doctor output to see which scripts/features are available on that branch.
