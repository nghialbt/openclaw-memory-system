#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    "  node install.mjs --openclaw-repo /path/to/openclaw [options]",
    "",
    "Options:",
    "  --openclaw-repo <path>       OpenClaw repo path (required)",
    "  --agent <name>               Agent for capture bootstrap (default: main)",
    "  --tz <timezone>              Cron timezone (default: Asia/Ho_Chi_Minh)",
    "  --codex-home <path>          Codex home (default: $CODEX_HOME or ~/.codex)",
    "  --skills-dir <path>          Skill dir (default: <codex-home>/skills)",
    "  --memory-root <path>         OPENCLAW_MEMORY_ROOT target",
    "  --workspace-root <path>      OPENCLAW_WORKSPACE_ROOT target",
    "  --skip-bootstrap             Install skill only",
    "  --skip-jobs                  Do not register jobs",
    "  --skip-runtime-inject        Do not inject memory runtime pack into target repo",
    "  --force-runtime-inject       Always overwrite runtime memory scripts from pack",
  ].join("\n"));
}

function runCommand(command, args, options = {}) {
  const { cwd = process.cwd(), env = process.env } = options;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function ensureFile(filePath, message) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(message || `Missing file: ${filePath}`);
  }
}

async function hasFile(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copySkill(srcDir, dstDir) {
  await fs.mkdir(path.dirname(dstDir), { recursive: true });
  await fs.rm(dstDir, { recursive: true, force: true });
  await fs.cp(srcDir, dstDir, { recursive: true, force: true });
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function resolvePaths(args) {
  const codexHome = args["codex-home"] ? path.resolve(args["codex-home"]) : defaultCodexHome();
  const skillsDir = args["skills-dir"]
    ? path.resolve(args["skills-dir"])
    : path.join(codexHome, "skills");
  const memoryRoot =
    args["memory-root"] ||
    process.env.OPENCLAW_MEMORY_ROOT ||
    path.join(os.homedir(), ".openclaw-ytb", "memory");
  const workspaceRoot =
    args["workspace-root"] ||
    process.env.OPENCLAW_WORKSPACE_ROOT ||
    path.join(os.homedir(), ".openclaw-ytb", "workspace");
  return { codexHome, skillsDir, memoryRoot, workspaceRoot };
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function missingScripts(currentScripts, requiredScripts) {
  return requiredScripts.filter((name) => {
    const value = currentScripts[name];
    return !(typeof value === "string" && value.trim().length > 0);
  });
}

async function copyRuntimeScripts(params) {
  const { runtimeScriptsDir, targetScriptsDir, force } = params;
  await fs.mkdir(targetScriptsDir, { recursive: true });
  const entries = await fs.readdir(runtimeScriptsDir, { withFileTypes: true });
  let copied = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("memory-") || !entry.name.endsWith(".ts")) continue;

    const src = path.join(runtimeScriptsDir, entry.name);
    const dst = path.join(targetScriptsDir, entry.name);
    const exists = await hasFile(dst);

    if (!exists || force) {
      await fs.copyFile(src, dst);
      copied += 1;
    }
  }

  return copied;
}

function mergeScriptEntries(pkg, manifest, force) {
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  let changed = false;

  for (const [name, cmd] of Object.entries(manifest.scripts || {})) {
    if (!(name in scripts) || force) {
      scripts[name] = cmd;
      changed = true;
    }
  }

  pkg.scripts = scripts;
  return changed;
}

function mergeDependencyEntries(pkg, manifest) {
  let changed = false;
  if (!pkg.dependencies || typeof pkg.dependencies !== "object") {
    pkg.dependencies = {};
  }
  if (!pkg.devDependencies || typeof pkg.devDependencies !== "object") {
    pkg.devDependencies = {};
  }

  for (const [name, version] of Object.entries(manifest.dependencies || {})) {
    if (!pkg.dependencies[name] && !pkg.devDependencies[name]) {
      pkg.dependencies[name] = version;
      changed = true;
    }
  }

  for (const [name, version] of Object.entries(manifest.devDependencies || {})) {
    if (!pkg.dependencies[name] && !pkg.devDependencies[name]) {
      pkg.devDependencies[name] = version;
      changed = true;
    }
  }

  return changed;
}

async function injectRuntimePack(params) {
  const { selfDir, openclawRepo, forceInject, skipInject } = params;
  if (skipInject) {
    return { injected: false, changedPackage: false, copiedScripts: 0, reason: "skip-requested" };
  }

  let manifestPath = path.join(
    selfDir,
    "openclaw-memory-ops",
    "runtime",
    "openclaw",
    "memory-runtime-manifest.json",
  );
  let runtimeScriptsDir = path.join(
    selfDir,
    "openclaw-memory-ops",
    "runtime",
    "openclaw",
    "scripts",
  );
  // Backward compatibility if runtime pack still exists at repo root.
  if (!(await hasFile(manifestPath)) || !(await hasFile(runtimeScriptsDir))) {
    manifestPath = path.join(selfDir, "runtime", "openclaw", "memory-runtime-manifest.json");
    runtimeScriptsDir = path.join(selfDir, "runtime", "openclaw", "scripts");
  }
  if (!(await hasFile(manifestPath)) || !(await hasFile(runtimeScriptsDir))) {
    return { injected: false, changedPackage: false, copiedScripts: 0, reason: "pack-missing" };
  }

  const pkgPath = path.join(openclawRepo, "package.json");
  const pkg = await readJson(pkgPath);
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const manifest = await readJson(manifestPath);
  const missingCore = missingScripts(scripts, manifest.requiredCoreScripts || []);

  if (missingCore.length === 0 && !forceInject) {
    return {
      injected: false,
      changedPackage: false,
      copiedScripts: 0,
      reason: "runtime-already-capable",
    };
  }

  const copiedScripts = await copyRuntimeScripts({
    runtimeScriptsDir,
    targetScriptsDir: path.join(openclawRepo, "scripts"),
    force: forceInject,
  });

  const scriptsChanged = mergeScriptEntries(pkg, manifest, forceInject);
  const depsChanged = mergeDependencyEntries(pkg, manifest);
  const changedPackage = scriptsChanged || depsChanged;

  if (changedPackage) {
    await writeJson(pkgPath, pkg);
  }

  const markerPath = path.join(openclawRepo, "scripts", ".openclaw-memory-runtime-injected.json");
  const marker = {
    source: "nghialbt/openclaw-memory-system",
    injectedAt: new Date().toISOString(),
    copiedScripts,
    changedPackage,
    forceInject,
    missingCore,
  };
  await writeJson(markerPath, marker);

  let installCode = 0;
  if (changedPackage) {
    installCode = await runCommand("pnpm", ["install"], { cwd: openclawRepo });
  }

  return {
    injected: true,
    changedPackage,
    copiedScripts,
    reason: "injected",
    installCode,
    missingCore,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }

  const openclawRepo = args["openclaw-repo"] ? path.resolve(args["openclaw-repo"]) : "";
  if (!openclawRepo) {
    usage();
    process.exit(1);
  }

  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const srcSkillDir = path.join(selfDir, "openclaw-memory-ops");

  await ensureFile(
    path.join(openclawRepo, "package.json"),
    "Invalid OpenClaw repo: missing package.json",
  );
  await ensureFile(path.join(srcSkillDir, "SKILL.md"), "Skill source missing: openclaw-memory-ops/SKILL.md");

  const skipInject = Boolean(args["skip-runtime-inject"]);
  const forceInject = Boolean(args["force-runtime-inject"]);

  const injectResult = await injectRuntimePack({
    selfDir,
    openclawRepo,
    forceInject,
    skipInject,
  });

  if (injectResult.injected) {
    console.log("Runtime memory pack injection: done");
    console.log(`- copied scripts: ${injectResult.copiedScripts}`);
    console.log(`- package.json changed: ${injectResult.changedPackage ? "yes" : "no"}`);
    if (injectResult.missingCore?.length) {
      console.log(`- missing core before inject: ${injectResult.missingCore.join(", ")}`);
    }
    if (injectResult.installCode && injectResult.installCode !== 0) {
      process.exit(injectResult.installCode);
    }
  } else {
    console.log(`Runtime memory pack injection: skipped (${injectResult.reason})`);
  }

  const { skillsDir, memoryRoot, workspaceRoot } = resolvePaths(args);
  const dstSkillDir = path.join(skillsDir, "openclaw-memory-ops");

  await copySkill(srcSkillDir, dstSkillDir);
  console.log(`Installed skill to: ${dstSkillDir}`);

  const env = {
    ...process.env,
    OPENCLAW_MEMORY_ROOT: memoryRoot,
    OPENCLAW_WORKSPACE_ROOT: workspaceRoot,
  };

  const memoryOps = path.join(dstSkillDir, "scripts", "memory_ops.mjs");
  const agent = args.agent || "main";
  const tz = args.tz || "Asia/Ho_Chi_Minh";
  const skipBootstrap = Boolean(args["skip-bootstrap"]);
  const skipJobs = Boolean(args["skip-jobs"]);

  if (!skipBootstrap) {
    const rc = await runCommand(
      "node",
      [
        memoryOps,
        "bootstrap",
        "--repo-root",
        openclawRepo,
        "--agent",
        agent,
        "--memory-root",
        memoryRoot,
        "--workspace-root",
        workspaceRoot,
      ],
      { env },
    );
    if (rc !== 0 && rc !== 3) {
      process.exit(rc);
    }
  }

  if (!skipJobs) {
    const rc = await runCommand(
      "node",
      [
        memoryOps,
        "register-jobs",
        "--repo-root",
        openclawRepo,
        "--tz",
        tz,
        "--memory-root",
        memoryRoot,
        "--workspace-root",
        workspaceRoot,
      ],
      { env },
    );
    if (rc !== 0 && rc !== 3) {
      process.exit(rc);
    }
  }

  console.log("\nSetup completed");
  console.log(`- OpenClaw repo: ${openclawRepo}`);
  console.log(`- Skill dir: ${dstSkillDir}`);
  console.log(`- Memory root: ${memoryRoot}`);
  console.log(`- Workspace root: ${workspaceRoot}`);
  console.log("\nNext:");
  console.log("1) Restart Codex/OpenClaw app to refresh Skills UI.");
  console.log("2) Run health check:");
  if (process.platform === "win32") {
    console.log(
      `   powershell -ExecutionPolicy Bypass -File \"${path.join(dstSkillDir, "scripts", "memory_doctor.ps1")}\" --repo-root \"${openclawRepo}\"`,
    );
  } else {
    console.log(
      `   bash \"${path.join(dstSkillDir, "scripts", "memory_doctor.sh")}\" --repo-root \"${openclawRepo}\"`,
    );
  }
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
