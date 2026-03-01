# OpenClaw Memory System

Portable skill bundle for deploying and operating the OpenClaw memory pipeline.

## What was fixed
This package now supports:
- macOS/Linux + Windows installation flow,
- runtime capability detection (no hard fail on branch mismatch),
- graceful skip for unsupported memory scripts/jobs/dashboard on custom branches.

## Quick install

### macOS / Linux
```bash
export GEMINI_API_KEY="<your_key>"   # optional but recommended
curl -fsSL https://raw.githubusercontent.com/nghialbt/openclaw-memory-system/main/install.sh | \
  bash -s -- --openclaw-repo /path/to/openclaw --tz Asia/Ho_Chi_Minh
```

### Windows (PowerShell)
```powershell
$env:GEMINI_API_KEY = "<your_key>"   # optional but recommended
git clone https://github.com/nghialbt/openclaw-memory-system.git
cd openclaw-memory-system
node install.mjs --openclaw-repo C:\path\to\openclaw --tz Asia/Ho_Chi_Minh
```

## Installer behavior
Installer performs:
- install skill into `~/.codex/skills/openclaw-memory-ops` (or `$CODEX_HOME/skills`),
- bootstrap memory pipeline,
- register recurring jobs.
- auto-inject memory runtime pack into target repo when core scripts are missing:
  - `memory:status:init`
  - `memory:audit`
  - `memory:render`
  - plus full `memory:*` script set and required dependencies.

If target runtime is missing required scripts (for example no `memory:status:init`):
- installer patches target repo with compatible memory scripts,
- updates `package.json` scripts/dependencies,
- runs `pnpm install`,
- then continues bootstrap/jobs.

To disable auto patching:
```bash
node install.mjs --openclaw-repo /path/to/openclaw --skip-runtime-inject
```

## Skill path
- `openclaw-memory-ops/`

## Included scripts
- Core: `openclaw-memory-ops/scripts/memory_ops.mjs`
- Bash wrappers:
  - `bootstrap_memory.sh`
  - `register_memory_jobs.sh`
  - `run_memory_cycle.sh`
  - `memory_doctor.sh`
- PowerShell wrappers:
  - `bootstrap_memory.ps1`
  - `register_memory_jobs.ps1`
  - `run_memory_cycle.ps1`
  - `memory_doctor.ps1`

## Health check after install
macOS/Linux:
```bash
bash ~/.codex/skills/openclaw-memory-ops/scripts/memory_doctor.sh --repo-root /path/to/openclaw
```

Windows:
```powershell
powershell -ExecutionPolicy Bypass -File "$HOME/.codex/skills/openclaw-memory-ops/scripts/memory_doctor.ps1" --repo-root C:\path\to\openclaw
```

## Architecture + Runbook Files
- [OpenClaw Memory Architecture Summary (PNG)](docs/assets/OpenClaw_Memory_Architecture_summary.png)
- [OpenClaw Memory Architecture (PDF)](docs/assets/OpenClaw_Memory_Architecture.pdf)
- [OpenClaw Memory Runbook (PDF)](docs/assets/OpenClaw_Memory_Runbook.pdf)

## Memory Status Dashboard
Dashboard URL (default): `http://127.0.0.1:3903/`

### What it shows
- Status counters: `Active`, `Pending`, `Deprecated`.
- Data source paths (status dir + runtime `MEMORY.md`) at the top.
- Filter tabs: `Active`, `Pending`, `Deprecated`, `All`, `Conflicts`.
- Main table columns: `ID`, `Topic.Key`, `Status`, `Confidence`, `Expires`, `Value`, `Action`.
- Detail panel (right): JSON view of selected memory/conflict item.

### What you can do
- Change memory status directly from table (`active/pending/deprecated`) and apply immediately.
- Review conflicts in `Conflicts` tab.
- Resolve conflicts with `Keep Left`, `Keep Right`, or `Manual` merge.
- Trigger full inbox re-scan via `Scan All`.
- Refresh live state via `Refresh`.

### Screenshot
![Memory Status Dashboard](docs/assets/Memory_Status_Dashboard.jpg)

## Skill not showing in UI?
1. Ensure `openclaw-memory-ops/agents/openai.yaml` exists in installed skill folder.
2. Re-run installer (install only):
```bash
node install.mjs --openclaw-repo /path/to/openclaw --skip-bootstrap --skip-jobs
```
3. Restart Codex/OpenClaw app.
