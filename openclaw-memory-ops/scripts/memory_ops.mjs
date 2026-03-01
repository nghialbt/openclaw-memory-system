#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function usage() {
  console.log([
    "Usage:",
    "  node scripts/memory_ops.mjs <command> [options]",
    "",
    "Commands:",
    "  bootstrap       Initialize and run first memory cycle",
    "  register-jobs   Register cron jobs (idempotent by name)",
    "  run-cycle       Run one manual memory cycle",
    "  doctor          Show health/capability report",
    "",
    "Common options:",
    "  --repo-root <path>",
    "  --memory-root <path>",
    "  --workspace-root <path>",
    "",
    "Bootstrap options:",
    "  --agent <name>",
    "  --skip-capture",
    "  --skip-triage",
    "",
    "Register-jobs options:",
    "  --tz <timezone>",
  ].join("\n"));
}

function defaultPaths() {
  return {
    memoryRoot: process.env.OPENCLAW_MEMORY_ROOT || path.join(os.homedir(), ".openclaw-ytb", "memory"),
    workspaceRoot:
      process.env.OPENCLAW_WORKSPACE_ROOT || path.join(os.homedir(), ".openclaw-ytb", "workspace"),
  };
}

function isTruthyFlag(v) {
  return v === true || v === "true" || v === "1";
}

async function readPackageScripts(repoRoot) {
  const pkgPath = path.join(repoRoot, "package.json");
  const raw = await fs.readFile(pkgPath, "utf8");
  const parsed = JSON.parse(raw);
  return parsed?.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
}

function runCommand(command, args, options = {}) {
  const { cwd = process.cwd(), env = process.env, capture = false } = options;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
    }

    child.on("error", (err) => {
      resolve({ code: 127, stdout, stderr: `${stderr}\n${String(err)}`.trim(), error: err });
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function hasFile(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function hasScript(scripts, name) {
  return typeof scripts[name] === "string" && scripts[name].trim().length > 0;
}

function missingScripts(scripts, required) {
  return required.filter((name) => !hasScript(scripts, name));
}

function envForMemory(memoryRoot, workspaceRoot) {
  return {
    ...process.env,
    OPENCLAW_MEMORY_ROOT: memoryRoot,
    OPENCLAW_WORKSPACE_ROOT: workspaceRoot,
  };
}

async function runPnpmScript(repoRoot, scriptName, extraArgs, env) {
  const args = [scriptName, ...extraArgs];
  const res = await runCommand("pnpm", args, { cwd: repoRoot, env });
  return res;
}

async function bootstrap(repoRoot, args, scripts) {
  const defaults = defaultPaths();
  const memoryRoot = args["memory-root"] || defaults.memoryRoot;
  const workspaceRoot = args["workspace-root"] || defaults.workspaceRoot;
  const agent = args.agent || "main";
  const skipCapture = isTruthyFlag(args["skip-capture"]);
  const skipTriage = isTruthyFlag(args["skip-triage"]);

  const requiredBase = ["memory:status:init", "memory:audit", "memory:render"];
  const baseMissing = missingScripts(scripts, requiredBase);
  if (baseMissing.length > 0) {
    console.log("[warn] Runtime repo does not provide required memory scripts for bootstrap:");
    for (const name of baseMissing) console.log(`- missing: ${name}`);
    console.log("[hint] This is a branch/runtime mismatch. Skill installed, bootstrap skipped.");
    return 3;
  }

  const env = envForMemory(memoryRoot, workspaceRoot);
  let rc = 0;

  console.log("==> pnpm memory:status:init");
  rc = (await runPnpmScript(repoRoot, "memory:status:init", [], env)).code;
  if (rc !== 0) return rc;

  if (!skipCapture && hasScript(scripts, "memory:capture")) {
    console.log(`==> pnpm memory:capture --agent ${agent}`);
    rc = (await runPnpmScript(repoRoot, "memory:capture", ["--agent", agent], env)).code;
    if (rc !== 0) return rc;
  } else if (!hasScript(scripts, "memory:capture")) {
    console.log("[skip] memory:capture not available in this repo");
  }

  const hasKey = Boolean((process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim());
  if (!skipTriage && hasScript(scripts, "memory:inbox:triage")) {
    if (!hasKey) {
      console.log("[skip] memory:inbox:triage skipped (no GEMINI_API_KEY/GOOGLE_API_KEY)");
    } else {
      console.log("==> pnpm memory:inbox:triage");
      rc = (await runPnpmScript(repoRoot, "memory:inbox:triage", [], env)).code;
      if (rc !== 0) return rc;
    }
  } else if (!hasScript(scripts, "memory:inbox:triage")) {
    console.log("[skip] memory:inbox:triage not available in this repo");
  }

  console.log("==> pnpm memory:audit");
  const audit = await runPnpmScript(repoRoot, "memory:audit", [], env);
  if (audit.code === 2) return 2;

  console.log("==> pnpm memory:render --replace");
  rc = (await runPnpmScript(repoRoot, "memory:render", ["--replace"], env)).code;
  if (rc !== 0) return rc;

  if (hasScript(scripts, "memory:archive:index")) {
    console.log("==> pnpm memory:archive:index");
    rc = (await runPnpmScript(repoRoot, "memory:archive:index", [], env)).code;
    if (rc !== 0) return rc;
  } else {
    console.log("[skip] memory:archive:index not available in this repo");
  }

  console.log("Bootstrap completed");
  console.log(`- memory root: ${memoryRoot}`);
  console.log(`- workspace root: ${workspaceRoot}`);
  return 0;
}

async function registerJobs(repoRoot, args, scripts) {
  const defaults = defaultPaths();
  const memoryRoot = args["memory-root"] || defaults.memoryRoot;
  const workspaceRoot = args["workspace-root"] || defaults.workspaceRoot;
  const tz = args.tz || "Asia/Ho_Chi_Minh";

  const listRes = await runCommand("openclaw", ["cron", "list"], { capture: true });
  if (listRes.code !== 0) {
    console.log("[warn] openclaw cron is unavailable; skip register-jobs");
    return 3;
  }

  const existing = listRes.stdout;
  const jobs = [
    {
      name: "Memory capture from session",
      cron: "30 1 * * *",
      required: ["memory:capture"],
      message: `export OPENCLAW_MEMORY_ROOT=${memoryRoot} && cd ${repoRoot} && pnpm memory:capture --agent main`,
    },
    {
      name: "Memory inbox triage",
      cron: "32 1 * * *",
      required: ["memory:inbox:triage"],
      message:
        `export OPENCLAW_MEMORY_ROOT=${memoryRoot} && export OPENCLAW_WORKSPACE_ROOT=${workspaceRoot} && cd ${repoRoot} && pnpm memory:inbox:triage`,
    },
    {
      name: "Memory audit",
      cron: "0 2 * * *",
      required: ["memory:audit"],
      message: `export OPENCLAW_MEMORY_ROOT=${memoryRoot} && cd ${repoRoot} && pnpm memory:audit`,
    },
    {
      name: "Memory prune weekly",
      cron: "0 3 * * 1",
      required: ["memory:prune:apply", "memory:archive:index", "memory:render"],
      message:
        `export OPENCLAW_MEMORY_ROOT=${memoryRoot} && export OPENCLAW_WORKSPACE_ROOT=${workspaceRoot} && cd ${repoRoot} && pnpm memory:prune:apply && pnpm memory:archive:index && pnpm memory:render --output ${path.join(workspaceRoot, "MEMORY.md")}`,
    },
  ];

  let created = 0;
  let skipped = 0;

  for (const job of jobs) {
    const miss = missingScripts(scripts, job.required);
    if (miss.length > 0) {
      console.log(`[skip] ${job.name} (missing scripts: ${miss.join(", ")})`);
      skipped += 1;
      continue;
    }
    if (existing.includes(job.name)) {
      console.log(`[skip] ${job.name} (already exists)`);
      skipped += 1;
      continue;
    }

    const add = await runCommand("openclaw", [
      "cron",
      "add",
      "--name",
      job.name,
      "--cron",
      job.cron,
      "--tz",
      tz,
      "--session",
      "isolated",
      "--message",
      job.message,
    ]);

    if (add.code === 0) {
      console.log(`[ok] ${job.name}`);
      created += 1;
    } else {
      console.log(`[warn] failed to create job: ${job.name}`);
    }
  }

  console.log(`Jobs register done: created=${created}, skipped=${skipped}`);
  return 0;
}

async function runCycle(repoRoot, args, scripts) {
  const defaults = defaultPaths();
  const memoryRoot = args["memory-root"] || defaults.memoryRoot;
  const workspaceRoot = args["workspace-root"] || defaults.workspaceRoot;
  const agent = args.agent || "main";
  const env = envForMemory(memoryRoot, workspaceRoot);

  const sequence = [
    ["memory:capture", ["--agent", agent]],
    ["memory:inbox:triage", []],
    ["memory:audit", []],
    ["memory:render", []],
    ["memory:archive:index", []],
  ];

  for (const [scriptName, extra] of sequence) {
    if (!hasScript(scripts, scriptName)) {
      console.log(`[skip] ${scriptName} not available`);
      continue;
    }
    console.log(`==> pnpm ${scriptName} ${extra.join(" ")}`.trim());
    const res = await runPnpmScript(repoRoot, scriptName, extra, env);
    if (res.code !== 0) {
      if (scriptName === "memory:audit" && res.code === 1) continue;
      return res.code;
    }
  }

  console.log("run-cycle done");
  return 0;
}

async function doctor(repoRoot, args, scripts) {
  const defaults = defaultPaths();
  const memoryRoot = args["memory-root"] || defaults.memoryRoot;
  const workspaceRoot = args["workspace-root"] || defaults.workspaceRoot;

  const required = [
    "memory:status:init",
    "memory:capture",
    "memory:inbox:triage",
    "memory:audit",
    "memory:render",
    "memory:archive:index",
  ];

  console.log("Memory doctor");
  console.log(`- repo root: ${repoRoot}`);
  console.log(`- memory root: ${memoryRoot}`);
  console.log(`- workspace root: ${workspaceRoot}`);

  console.log("\nScript capabilities:");
  for (const name of required) {
    console.log(`- ${name}: ${hasScript(scripts, name) ? "yes" : "no"}`);
  }

  const manageSh = await hasFile(path.join(repoRoot, "manage.sh"));
  const managePs1 = await hasFile(path.join(repoRoot, "manage.ps1"));
  console.log("\nDashboard capability:");
  console.log(`- memory:dashboard:web script: ${hasScript(scripts, "memory:dashboard:web") ? "yes" : "no"}`);
  console.log(`- manage.sh: ${manageSh ? "yes" : "no"}`);
  console.log(`- manage.ps1: ${managePs1 ? "yes" : "no"}`);

  const env = envForMemory(memoryRoot, workspaceRoot);
  if (hasScript(scripts, "memory:audit")) {
    console.log("\nAudit:");
    const res = await runPnpmScript(repoRoot, "memory:audit", [], env);
    console.log(`- audit exit code: ${res.code} (0 clean, 1 stale-only, 2 severe)`);
    return res.code === 2 ? 2 : 0;
  }

  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    usage();
    process.exit(0);
  }

  const args = parseArgs(rest);
  const repoRoot = path.resolve(args["repo-root"] || process.cwd());
  const pkgPath = path.join(repoRoot, "package.json");

  if (!(await hasFile(pkgPath))) {
    console.error(`Invalid repo root (missing package.json): ${repoRoot}`);
    process.exit(1);
  }

  const scripts = await readPackageScripts(repoRoot);

  let rc = 0;
  if (command === "bootstrap") rc = await bootstrap(repoRoot, args, scripts);
  else if (command === "register-jobs") rc = await registerJobs(repoRoot, args, scripts);
  else if (command === "run-cycle") rc = await runCycle(repoRoot, args, scripts);
  else if (command === "doctor") rc = await doctor(repoRoot, args, scripts);
  else {
    usage();
    process.exit(1);
  }

  process.exit(rc);
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
