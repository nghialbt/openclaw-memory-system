---
name: openclaw-memory-ops
description: Deploy and operate OpenClaw memory pipeline. Supports cross-platform setup (macOS/Linux/Windows), auto-repairing missing runtime scripts, and automated job registration.
---

# OpenClaw Memory Ops

Use this skill when the user asks to **set up/fix the memory system** or **operate the memory pipeline**.

## 🚀 Quick Start (Automated Setup)

If you just arrived on this machine, run the one-liner installer:

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/nghialbt/openclaw-memory-system/main/install.sh | bash -s -- --openclaw-repo /path/to/openclaw
```

**Windows:**
```powershell
$worker = "https://raw.githubusercontent.com/nghialbt/openclaw-memory-system/main/install.ps1"; iwr $worker | iex; # Use --openclaw-repo thereafter
```

## 🏥 Troubleshooting & Health Check

If the memory system isn't working, run the **Doctor** from the installed skill folder:

```bash
# 1. Diagnose issues
node scripts/memory_ops.mjs doctor --repo-root /path/to/openclaw

# 2. Auto-repair (injects missing scripts to package.json)
node scripts/memory_ops.mjs doctor --repo-root /path/to/openclaw --fix
```

## 🛠️ Prerequisites

1. **Target Repo**: You must have an OpenClaw repo locally.
2. **Node & pnpm**: Required for running scripts.
3. **OpenClaw CLI** (Optional): Required for `register-jobs`. If missing, you must run cycles manually.
4. **AI Triage Auth** (Optional): AI-powered triage works automatically if the **OpenClaw Gateway** is running (uses internal auth), OR if you manually set `GEMINI_API_KEY`.

## 🔄 The Memory Pipeline

You can run these commands manually via the skill wrappers:

### 1) Initialize/Reset (`bootstrap`)
Checks for missing scripts and runs the first full cycle.
```bash
bash scripts/bootstrap_memory.sh --repo-root /path/to/openclaw
```

### 2) Run One Cycle (`run-cycle`)
Executes: Capture → Triage (AI) → Audit → Render → Archive Index.
```bash
bash scripts/run_memory_cycle.sh --repo-root /path/to/openclaw
```

### 3) Register Cron Jobs (`register-jobs`)
Registers recurring jobs in `openclaw cron`.
```bash
bash scripts/register_memory_jobs.sh --repo-root /path/to/openclaw
```

## 📊 Dashboard

The Memory Dashboard provides a web UI for viewing your memory state.

**To start:**
- macOS/Linux: `./manage.sh memory start` (or `pnpm memory:dashboard:start`)
- Windows: `pnpm memory:dashboard:start` (Run in the OpenClaw repo)

Default URL: [http://127.0.0.1:3903/](http://127.0.0.1:3903/)

## ⚠️ Notes
- If `memory:*` scripts are missing in `package.json`, always run `doctor --fix` first.
- **AI Triage** requires OpenClaw Gateway or an API Key. It will fail fast (exit 2) if no auth is found to ensure memory integrity.
- Cron jobs will be skipped if `openclaw` CLI is not in PATH.
