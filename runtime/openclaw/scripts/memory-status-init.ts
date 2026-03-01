#!/usr/bin/env -S node --import tsx

import { asCliArgMap } from "./memory-governance-lib";
import { initializeStatusStore } from "./memory-status-lib";

function usageAndExit(code: number): never {
  console.error(
    [
      "memory-status-init.ts",
      "",
      "Usage:",
      "  node --import tsx scripts/memory-status-init.ts [--root /path/to/memory] [--workspace-root /path/to/workspace] [--status-dir /path/to/status]",
    ].join("\n"),
  );
  process.exit(code);
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  if (args.help === true) {
    usageAndExit(0);
  }

  const result = await initializeStatusStore(args);
  console.log("memory:status:init done");
  console.log(`- memory root: ${result.paths.memoryRoot}`);
  console.log(`- status dir: ${result.paths.statusDir}`);
  console.log(`- memory file: ${result.paths.memoryPath}`);
  console.log(`- runtime file: ${result.paths.workspaceMemoryPath}`);
  console.log(
    `- counts: active=${result.counts.active} pending=${result.counts.pending} deprecated=${result.counts.deprecated}`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory:status:init failed: ${message}`);
  process.exitCode = 2;
});
