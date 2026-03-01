#!/usr/bin/env -S node --import tsx

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import {
  asCliArgMap,
  auditExitCode,
  auditMemory,
  formatDateNowUtc,
  isExpired,
  MemoryItem,
  monthBucket,
  resolveMemoryRoot,
  writeMemoryItems,
} from "./memory-governance-lib";

function usageAndExit(code: number): never {
  console.error(
    [
      "memory-prune.ts",
      "",
      "Usage:",
      "  node --import tsx scripts/memory-prune.ts [--apply] [--root /path/to/memory] [--file MEMORY.yml] [--archive-dir /path/to/archive] [--today YYYY-MM-DD]",
    ].join("\n"),
  );
  process.exit(code);
}

async function readArchiveItems(archivePath: string): Promise<MemoryItem[]> {
  if (!existsSync(archivePath)) {
    return [];
  }
  const raw = await readFile(archivePath, "utf8");
  const parsed = YAML.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Archive file must be a YAML list: ${archivePath}`);
  }
  const items: MemoryItem[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    items.push(entry as MemoryItem);
  }
  return items;
}

function dedupeById(items: MemoryItem[]): MemoryItem[] {
  const map = new Map<string, MemoryItem>();
  for (const item of items) {
    if (!map.has(item.id)) {
      map.set(item.id, item);
    }
  }
  return [...map.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  if (args.help === true) {
    usageAndExit(0);
  }

  const apply = args.apply === true;
  const today = typeof args.today === "string" ? args.today : formatDateNowUtc();
  const root = resolve(resolveMemoryRoot(args));
  const memoryPath =
    typeof args.file === "string" ? resolve(args.file) : resolve(root, "MEMORY.yml");
  const archiveDir =
    typeof args["archive-dir"] === "string"
      ? resolve(args["archive-dir"])
      : resolve(root, "archive");

  const summary = await auditMemory(memoryPath, today);
  const exitCode = auditExitCode(summary.issues);
  if (exitCode === 2) {
    console.error("memory:prune aborted due to severe audit issues. Run memory:audit first.");
    process.exitCode = 2;
    return;
  }

  const toArchive = summary.items.filter(
    (item) => item.status === "deprecated" || isExpired(item, today),
  );
  const archiveIds = new Set(toArchive.map((item) => item.id));
  const keep = summary.items.filter((item) => !archiveIds.has(item.id));

  console.log(`memory:prune ${apply ? "apply" : "dry-run"}`);
  console.log(`- memory file: ${memoryPath}`);
  console.log(`- keep: ${keep.length}`);
  console.log(`- archive: ${toArchive.length}`);

  if (toArchive.length > 0) {
    console.log(`- archive ids: ${toArchive.map((item) => item.id).join(", ")}`);
  }

  if (!apply) {
    process.exitCode = exitCode === 1 ? 1 : 0;
    return;
  }

  const archivePath = resolve(archiveDir, `${monthBucket(today)}.yml`);
  const existingArchive = await readArchiveItems(archivePath);
  const mergedArchive = dedupeById([...existingArchive, ...toArchive]);

  await writeMemoryItems(memoryPath, keep);
  await writeMemoryItems(archivePath, mergedArchive);

  console.log(`- wrote memory: ${memoryPath}`);
  console.log(`- wrote archive: ${archivePath}`);
  process.exitCode = exitCode === 1 ? 1 : 0;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory:prune failed: ${message}`);
  process.exitCode = 2;
});
