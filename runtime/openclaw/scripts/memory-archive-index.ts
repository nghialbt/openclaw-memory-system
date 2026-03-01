#!/usr/bin/env -S node --import tsx

import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import {
  asCliArgMap,
  readMemoryItems,
  resolveMemoryRoot,
  sortItems,
  writeTextFileAtomic,
} from "./memory-governance-lib";

type ArchiveRenderSummary = {
  month: string;
  sourcePath: string;
  outputPath: string;
  itemCount: number;
  changed: boolean;
  issues: number;
};

function usageAndExit(code: number): never {
  const lines = [
    "memory-archive-index.ts",
    "",
    "Usage:",
    "  node --import tsx scripts/memory-archive-index.ts [--root /path/to/memory] [--workspace-root /path/to/workspace] [--archive-dir /path/to/archive] [--output-dir /path/to/archive-index]",
  ];
  const output = lines.join("\n");
  if (code === 0) {
    console.log(output);
  } else {
    console.error(output);
  }
  process.exit(code);
}

function resolveWorkspaceRoot(args: Record<string, string | boolean>): string {
  const argValue = typeof args["workspace-root"] === "string" ? args["workspace-root"].trim() : "";
  if (argValue.length > 0) {
    return resolve(argValue);
  }
  const envValue = process.env.OPENCLAW_WORKSPACE_ROOT?.trim() ?? "";
  if (envValue.length > 0) {
    return resolve(envValue);
  }
  return resolve(homedir(), ".openclaw-ytb", "workspace");
}

function monthFromArchiveFile(filePath: string): string {
  const name = basename(filePath);
  return name.endsWith(".yml") ? name.slice(0, -4) : name;
}

function formatValue(value: string | number | boolean): string {
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function renderArchiveMonthMarkdown(params: {
  month: string;
  sourcePath: string;
  itemCount: number;
  rows: string[];
}): string {
  const lines = [
    "# Archived Memory " + params.month,
    "",
    "- Source YAML: " + params.sourcePath,
    "- Records: " + String(params.itemCount),
    "- Purpose: Cold memory index used only as fallback retrieval.",
    "",
    "## Entries",
    "",
  ];

  if (params.rows.length === 0) {
    lines.push("No archived memory items.", "");
    return lines.join("\n");
  }

  lines.push(...params.rows, "");
  return lines.join("\n");
}

function renderEntryRows(params: { month: string; items: ReturnType<typeof sortItems> }): string[] {
  const rows: string[] = [];
  for (const item of params.items) {
    rows.push("### " + item.id + " - " + item.topic + "." + item.key);
    rows.push("");
    rows.push("- value: " + formatValue(item.value));
    rows.push("- status: " + item.status);
    rows.push("- effective_from: " + item.effective_from);
    rows.push("- expires: " + item.expires);
    rows.push("- source: " + item.source);
    rows.push("- confidence: " + (item.confidence ?? "n/a"));
    rows.push(
      "- searchable: " +
        item.topic +
        " " +
        item.key +
        " " +
        formatValue(item.value) +
        " " +
        item.source +
        " " +
        params.month,
    );
    if (item.next) {
      rows.push("- next: " + item.next);
    }
    rows.push("");
  }
  return rows;
}

function renderArchiveIndexReadme(rows: ArchiveRenderSummary[]): string {
  const lines = [
    "# Archive Index",
    "",
    "Fallback-searchable mirror of `memory/archive/*.yml`.",
    "",
    "| Month | Records | File |",
    "| --- | ---: | --- |",
  ];
  for (const row of rows) {
    const rel = basename(row.outputPath);
    lines.push("| " + row.month + " | " + row.itemCount + " | " + rel + " |");
  }
  lines.push("");
  return lines.join("\n");
}

async function readArchiveFiles(archiveDir: string): Promise<string[]> {
  if (!existsSync(archiveDir)) {
    return [];
  }
  const entries = await readdir(archiveDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => resolve(archiveDir, entry.name))
    .toSorted((left, right) => left.localeCompare(right));
}

async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
  if (existsSync(filePath)) {
    const current = await readFile(filePath, "utf8").catch(() => "");
    if (current === content) {
      return false;
    }
  }
  await writeTextFileAtomic(filePath, content);
  return true;
}

async function removeStaleMarkdown(outputDir: string, keep: Set<string>): Promise<number> {
  if (!existsSync(outputDir)) {
    return 0;
  }
  const entries = await readdir(outputDir, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const filePath = resolve(outputDir, entry.name);
    if (keep.has(filePath)) {
      continue;
    }
    await unlink(filePath).catch(() => {});
    removed += 1;
  }
  return removed;
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  if (args.help === true) {
    usageAndExit(0);
  }

  const memoryRoot = resolve(resolveMemoryRoot(args));
  const workspaceRoot = resolveWorkspaceRoot(args);
  const archiveDir =
    typeof args["archive-dir"] === "string"
      ? resolve(args["archive-dir"])
      : resolve(memoryRoot, "archive");
  const outputDir =
    typeof args["output-dir"] === "string"
      ? resolve(args["output-dir"])
      : resolve(workspaceRoot, "memory", "archive-index");

  const archiveFiles = await readArchiveFiles(archiveDir);
  const results: ArchiveRenderSummary[] = [];
  const keepPaths = new Set<string>();

  for (const sourcePath of archiveFiles) {
    const month = monthFromArchiveFile(sourcePath);
    const outputPath = resolve(outputDir, month + ".md");
    keepPaths.add(outputPath);

    const parsed = await readMemoryItems(sourcePath);
    const items = sortItems(parsed.items);
    const rows = renderEntryRows({ month, items });
    const content = renderArchiveMonthMarkdown({
      month,
      sourcePath,
      itemCount: items.length,
      rows,
    });
    const changed = await writeIfChanged(outputPath, content);

    results.push({
      month,
      sourcePath,
      outputPath,
      itemCount: items.length,
      changed,
      issues: parsed.issues.length,
    });
  }

  const readmePath = resolve(outputDir, "README.md");
  keepPaths.add(readmePath);
  const readmeContent = renderArchiveIndexReadme(results);
  const readmeChanged = await writeIfChanged(readmePath, readmeContent);

  const removed = await removeStaleMarkdown(outputDir, keepPaths);
  const changedCount = results.filter((row) => row.changed).length;
  const totalIssues = results.reduce((sum, row) => sum + row.issues, 0);

  console.log("memory:archive:index done");
  console.log("- memory root: " + memoryRoot);
  console.log("- archive dir: " + archiveDir);
  console.log("- output dir: " + outputDir);
  console.log("- month files: " + results.length);
  console.log("- changed month files: " + changedCount);
  console.log("- readme changed: " + (readmeChanged ? "yes" : "no"));
  console.log("- removed stale markdown: " + removed);
  console.log("- parse issues: " + totalIssues);

  if (results.length > 0) {
    for (const row of results) {
      const shortPath = basename(row.outputPath);
      console.log(
        "  - " +
          row.month +
          ": records=" +
          row.itemCount +
          ", changed=" +
          (row.changed ? "yes" : "no") +
          ", issues=" +
          row.issues +
          ", file=" +
          shortPath,
      );
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("memory:archive:index failed: " + message);
  process.exitCode = 2;
});
