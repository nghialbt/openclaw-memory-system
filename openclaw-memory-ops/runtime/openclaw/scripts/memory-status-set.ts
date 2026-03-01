#!/usr/bin/env -S node --import tsx

import { asCliArgMap, formatDateNowUtc, MemoryStatus } from "./memory-governance-lib";
import { applyStatusChange, resolveMemoryStatusPaths } from "./memory-status-lib";

function usageAndExit(code: number): never {
  console.error(
    [
      "memory-status-set.ts",
      "",
      "Usage:",
      "  node --import tsx scripts/memory-status-set.ts --id MEM-YYYY-MM-NNN --to <active|pending|deprecated> [--today YYYY-MM-DD] [--root /path/to/memory] [--workspace-root /path/to/workspace] [--status-dir /path/to/status]",
    ].join("\n"),
  );
  process.exit(code);
}

function parseTargetStatus(value: unknown): MemoryStatus {
  if (value === "active" || value === "pending" || value === "deprecated") {
    return value;
  }
  throw new Error("Invalid --to status. Use active|pending|deprecated");
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  if (args.help === true) {
    usageAndExit(0);
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    throw new Error("Missing required --id");
  }

  const to = parseTargetStatus(args.to);
  const today = typeof args.today === "string" ? args.today : formatDateNowUtc();
  const paths = resolveMemoryStatusPaths(args);
  const changed = await applyStatusChange({
    paths,
    id,
    to,
    today,
  });

  console.log("memory:status:set done");
  console.log(`- id: ${id}`);
  console.log(`- from: ${changed.from}`);
  console.log(`- to: ${changed.to}`);
  console.log(`- status dir: ${paths.statusDir}`);
  console.log(`- memory file: ${paths.memoryPath}`);
  console.log(`- runtime file: ${paths.workspaceMemoryPath}`);
  console.log(
    `- counts: active=${changed.counts.active} pending=${changed.counts.pending} deprecated=${changed.counts.deprecated}`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory:status:set failed: ${message}`);
  process.exitCode = 2;
});
