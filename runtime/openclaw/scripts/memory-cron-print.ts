#!/usr/bin/env -S node --import tsx

import { homedir } from "node:os";
import { resolve } from "node:path";
import { asCliArgMap, resolveMemoryRoot } from "./memory-governance-lib";

function main() {
  const args = asCliArgMap(process.argv.slice(2));
  const tz = typeof args.tz === "string" ? args.tz : "America/Los_Angeles";
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  const memoryRoot = resolveMemoryRoot(args);
  const workspaceRoot =
    typeof args["workspace-root"] === "string"
      ? resolve(args["workspace-root"])
      : resolve(homedir(), ".openclaw-ytb", "workspace");
  const memoryMdOutput = resolve(workspaceRoot, "MEMORY.md");

  const lines = [
    "# OpenClaw Cron setup (memory governance)",
    "",
    `# Memory root: ${memoryRoot}`,
    `export OPENCLAW_MEMORY_ROOT="${memoryRoot}"`,
    `# Workspace root: ${workspaceRoot}`,
    `export OPENCLAW_WORKSPACE_ROOT="${workspaceRoot}"`,
    "",
    `# 0) Session capture at 01:30 (${tz})`,
    "openclaw cron add \\",
    '  --name "Memory capture from session" \\',
    '  --cron "30 1 * * *" \\',
    `  --tz "${tz}" \\`,
    "  --session isolated \\",
    `  --message "export OPENCLAW_MEMORY_ROOT=${memoryRoot} && cd ${cwd} && pnpm memory:capture --agent main"`,
    "",
    `# 1) Auto-triage inbox candidates at 01:32 (${tz})`,
    "openclaw cron add \\",
    '  --name "Memory inbox triage" \\',
    '  --cron "32 1 * * *" \\',
    `  --tz "${tz}" \\`,
    "  --session isolated \\",
    `  --message "export OPENCLAW_MEMORY_ROOT=${memoryRoot} && export OPENCLAW_WORKSPACE_ROOT=${workspaceRoot} && cd ${cwd} && pnpm memory:inbox:triage"`,
    "",
    `# 2) Daily audit at 02:00 (${tz})`,
    "openclaw cron add \\",
    '  --name "Memory audit" \\',
    '  --cron "0 2 * * *" \\',
    `  --tz "${tz}" \\`,
    "  --session isolated \\",
    `  --message "cd ${cwd} && pnpm memory:audit"`,
    "",
    `# 3) Weekly prune at 03:00 every Monday (${tz})`,
    "openclaw cron add \\",
    '  --name "Memory prune" \\',
    '  --cron "0 3 * * 1" \\',
    `  --tz "${tz}" \\`,
    "  --session isolated \\",
    `  --message "cd ${cwd} && pnpm memory:prune:apply && pnpm memory:archive:index && pnpm memory:render --output ${memoryMdOutput}"`,
    "",
    "# Check jobs",
    "openclaw cron list",
    "",
    "# Inspect run history",
    "openclaw cron runs --id <jobId> --limit 50",
  ];

  console.log(lines.join("\n"));
}

main();
