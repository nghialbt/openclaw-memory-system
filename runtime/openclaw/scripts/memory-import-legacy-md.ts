#!/usr/bin/env -S node --import tsx

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  asCliArgMap,
  formatDateNowUtc,
  MemoryItem,
  readMemoryItems,
  resolveMemoryRoot,
  serializeItems,
  writeMemoryItems,
  writeTextFile,
} from "./memory-governance-lib";

const GENERATED_BLOCK_START = "<!-- OPENCLAW_MEMORY_GOVERNANCE:START -->";
const GENERATED_BLOCK_END = "<!-- OPENCLAW_MEMORY_GOVERNANCE:END -->";
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

type LegacyBullet = {
  lineNumber: number;
  text: string;
};

function addDays(isoDate: string, days: number): string {
  const base = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(base)) {
    return isoDate;
  }
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function cleanText(text: string): string {
  return text.replace(/`/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

function stripGeneratedBlock(content: string): string {
  const start = content.indexOf(GENERATED_BLOCK_START);
  const end = content.indexOf(GENERATED_BLOCK_END);
  if (start === -1 || end === -1 || end < start) {
    return content;
  }
  const before = content.slice(0, start).trimEnd();
  return before;
}

function parseTopLevelBullets(content: string): LegacyBullet[] {
  const lines = content.split("\n");
  const bullets: LegacyBullet[] = [];
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    if (!raw.startsWith("- ")) {
      continue;
    }
    const cleaned = cleanText(raw.slice(2));
    if (cleaned.length < 10) {
      continue;
    }
    bullets.push({
      lineNumber: index + 1,
      text: cleaned,
    });
  }
  return bullets;
}

function classifyTopicAndKey(
  text: string,
  ordinal: number,
): { topic: string; key: string; confidence: string } {
  const lower = text.toLowerCase();
  if (lower.startsWith("user preference:")) {
    return { topic: "user-profile", key: "display_name_preference", confidence: "high" };
  }
  if (lower.startsWith("persona note:")) {
    return { topic: "persona", key: "persona_mode", confidence: "high" };
  }
  if (lower.startsWith("core protocol")) {
    return { topic: "workflow", key: "core_protocol", confidence: "high" };
  }
  if (lower.startsWith("workflow rule")) {
    return { topic: "workflow", key: "workflow_rule", confidence: "high" };
  }
  if (lower.startsWith("approval rule")) {
    return { topic: "workflow", key: "approval_rule", confidence: "high" };
  }
  if (lower.startsWith("learning rule")) {
    return { topic: "workflow", key: "learning_rule", confidence: "high" };
  }
  if (lower.startsWith("youtube compliance")) {
    return { topic: "youtube-policy", key: "compliance_rules", confidence: "high" };
  }
  if (lower.startsWith("project progress")) {
    const date = DATE_RE.exec(lower)?.[1];
    return {
      topic: "project-progress",
      key: date
        ? `progress_${date.replaceAll("-", "_")}`
        : `progress_${String(ordinal).padStart(3, "0")}`,
      confidence: "medium",
    };
  }
  if (lower.startsWith("project status update")) {
    return { topic: "project-progress", key: "status_update", confidence: "medium" };
  }
  if (lower.startsWith('project "') && lower.includes("completed")) {
    return {
      topic: "project-progress",
      key: `completed_${slug(text.slice(0, 40))}`,
      confidence: "high",
    };
  }
  if (lower.startsWith("vidiq integration")) {
    return { topic: "youtube-intel", key: "vidiq_realtime_policy", confidence: "high" };
  }
  if (lower.startsWith("market update")) {
    return { topic: "youtube-intel", key: "market_update", confidence: "medium" };
  }
  if (lower.startsWith("workflow routing")) {
    return { topic: "workflow", key: "routing_policy", confidence: "high" };
  }
  if (lower.startsWith("workflow & tooling")) {
    return { topic: "workflow", key: "tooling_policy", confidence: "medium" };
  }
  if (lower.startsWith("workflow fix")) {
    return { topic: "workflow", key: "verification_protocol", confidence: "high" };
  }
  if (lower.startsWith("daily distillation")) {
    return { topic: "memory-governance", key: "daily_distillation_status", confidence: "medium" };
  }
  return {
    topic: "legacy-memory-md",
    key: `note_${String(ordinal).padStart(3, "0")}`,
    confidence: "low",
  };
}

function resolveWorkspaceRoot(args: Record<string, string | boolean>): string {
  const fromArg = typeof args["workspace-root"] === "string" ? args["workspace-root"].trim() : "";
  if (fromArg.length > 0) {
    return resolve(fromArg);
  }
  const fromEnv = process.env.OPENCLAW_WORKSPACE_ROOT?.trim() ?? "";
  if (fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  return resolve(homedir(), ".openclaw-ytb", "workspace");
}

function nextIds(today: string, existingIds: string[], count: number): string[] {
  const month = today.slice(0, 7);
  const regex = new RegExp(`^MEM-${month}-(\\d{3})$`);
  let max = 0;
  for (const id of existingIds) {
    const match = regex.exec(id);
    if (!match) {
      continue;
    }
    const value = Number.parseInt(match[1] ?? "0", 10);
    if (Number.isFinite(value) && value > max) {
      max = value;
    }
  }
  const ids: string[] = [];
  for (let index = 1; index <= count; index++) {
    ids.push(`MEM-${month}-${String(max + index).padStart(3, "0")}`);
  }
  return ids;
}

function dedupeCandidates(items: MemoryItem[]): MemoryItem[] {
  const seen = new Set<string>();
  const deduped: MemoryItem[] = [];
  for (const item of items) {
    const fingerprint = `${item.topic}|${item.key}|${String(item.value).toLowerCase()}`;
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    deduped.push(item);
  }
  return deduped;
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  const today = typeof args.today === "string" ? args.today : formatDateNowUtc();
  const apply = args.apply === true;
  const status =
    typeof args.status === "string" && (args.status === "active" || args.status === "pending")
      ? args.status
      : "pending";
  const expiresDaysRaw = typeof args["expires-days"] === "string" ? args["expires-days"] : "365";
  const expiresDays = Math.max(30, Number.parseInt(expiresDaysRaw, 10) || 365);

  const memoryRoot = resolve(resolveMemoryRoot(args));
  const workspaceRoot = resolveWorkspaceRoot(args);
  const inputPath =
    typeof args.input === "string" ? resolve(args.input) : resolve(workspaceRoot, "MEMORY.md");
  const memoryPath =
    typeof args.file === "string" ? resolve(args.file) : resolve(memoryRoot, "MEMORY.yml");
  const outputPath =
    typeof args.output === "string"
      ? resolve(args.output)
      : resolve(memoryRoot, "imports", `legacy-memory-${today}.yml`);

  if (!existsSync(inputPath)) {
    throw new Error(`Input file does not exist: ${inputPath}`);
  }

  const inputRaw = await readFile(inputPath, "utf8");
  const stripped = stripGeneratedBlock(inputRaw);
  const bullets = parseTopLevelBullets(stripped);

  const { items: existing } = await readMemoryItems(memoryPath);
  const ids = nextIds(
    today,
    existing.map((item) => item.id),
    bullets.length,
  );

  const sourceBase = "memory/workspace/MEMORY.md";
  const candidates: MemoryItem[] = [];
  for (let index = 0; index < bullets.length; index++) {
    const bullet = bullets[index];
    const classified = classifyTopicAndKey(bullet.text, index + 1);
    const effectiveFrom = DATE_RE.exec(bullet.text)?.[1] ?? today;
    const item: MemoryItem = {
      id: ids[index] ?? `MEM-${today.slice(0, 7)}-${String(index + 1).padStart(3, "0")}`,
      topic: classified.topic,
      key: classified.key,
      value: bullet.text,
      status,
      source: `${sourceBase}#L${bullet.lineNumber}`,
      effective_from: effectiveFrom,
      expires: addDays(effectiveFrom, expiresDays),
      scope: { env: "all" },
      updated: today,
      confidence: classified.confidence as "high" | "medium" | "low",
      next: "Review and promote to active if still valid",
    };
    candidates.push(item);
  }

  const deduped = dedupeCandidates(candidates);
  const existingFingerprints = new Set(
    existing.map((item) => `${item.topic}|${item.key}|${String(item.value).toLowerCase()}`),
  );
  const fresh = deduped.filter(
    (item) =>
      !existingFingerprints.has(`${item.topic}|${item.key}|${String(item.value).toLowerCase()}`),
  );

  if (apply) {
    const merged = [...existing, ...fresh];
    await writeMemoryItems(memoryPath, merged);
  }
  await writeTextFile(outputPath, serializeItems(fresh));

  console.log("memory:import-legacy-md done");
  console.log(`- input: ${inputPath}`);
  console.log(`- memory file: ${memoryPath}`);
  console.log(`- mode: ${apply ? "apply" : "dry-run"}`);
  console.log(`- extracted bullets: ${bullets.length}`);
  console.log(`- new items: ${fresh.length}`);
  console.log(`- output: ${outputPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory:import-legacy-md failed: ${message}`);
  process.exitCode = 2;
});
