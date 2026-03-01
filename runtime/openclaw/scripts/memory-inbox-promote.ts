#!/usr/bin/env -S node --import tsx

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import {
  asCliArgMap,
  auditExitCode,
  auditMemory,
  formatDateNowUtc,
  MemoryItem,
  MemoryStatus,
  resolveMemoryLockPath,
  resolveMemoryRoot,
  withFileLock,
  writeTextFile,
} from "./memory-governance-lib";
import {
  ensureStatusBuckets,
  flattenBuckets,
  loadStatusBuckets,
  rebuildUnifiedMemory,
  renderRuntimeActiveMemory,
  resolveMemoryStatusPaths,
  saveStatusBuckets,
  StatusBuckets,
} from "./memory-status-lib";

type RawObject = Record<string, unknown>;

type CaptureCandidate = {
  id: string;
  status: string;
  topic: string;
  key: string;
  value: string;
  source: string;
  event_at?: string;
  confidence?: "low" | "medium" | "high";
};

type ProcessedArchiveRecord = {
  processed_at: string;
  inbox_file: string;
  candidate_id: string;
  result: "promoted" | "duplicate" | "ignored";
  reason?: string;
  mem_id?: string;
  topic?: string;
  key?: string;
  value?: string;
  source?: string;
};

function usageAndExit(code: number): never {
  console.error(
    [
      "memory-inbox-promote.ts",
      "",
      "Usage:",
      "  node --import tsx scripts/memory-inbox-promote.ts [--to pending] [--today YYYY-MM-DD] [--root /path/to/memory] [--workspace-root /path/to/workspace] [--all] [--file /path/to/inbox.yml]",
    ].join("\n"),
  );
  process.exit(code);
}

function asObject(value: unknown): RawObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as RawObject;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const out = value.trim();
  return out.length > 0 ? out : null;
}

function parseTargetStatus(value: unknown): MemoryStatus {
  if (value === undefined) {
    return "pending";
  }
  if (value === "active" || value === "pending" || value === "deprecated") {
    return value;
  }
  throw new Error("Invalid --to status. Use active|pending|deprecated");
}

function normalizeFingerprint(topic: string, key: string, value: string): string {
  return `${topic}|${key}|${value}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function cloneBuckets(input: StatusBuckets): StatusBuckets {
  return {
    active: input.active.map((item) => ({ ...item, scope: { ...item.scope } })),
    pending: input.pending.map((item) => ({ ...item, scope: { ...item.scope } })),
    deprecated: input.deprecated.map((item) => ({ ...item, scope: { ...item.scope } })),
  };
}

function parseIsoDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const ts = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ts) ? ts : null;
}

function addDaysIso(day: string, days: number): string {
  const ts = parseIsoDay(day);
  if (ts === null) {
    return day;
  }
  const date = new Date(ts + days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function toEventDay(candidate: CaptureCandidate, today: string): string {
  const eventAt = asString(candidate.event_at);
  if (!eventAt) {
    return today;
  }
  const parsed = Date.parse(eventAt);
  if (!Number.isFinite(parsed)) {
    return today;
  }
  const eventDay = new Date(parsed).toISOString().slice(0, 10);
  const eventTs = parseIsoDay(eventDay);
  const todayTs = parseIsoDay(today);
  if (eventTs === null || todayTs === null) {
    return today;
  }
  return eventTs > todayTs ? today : eventDay;
}

function normalizeConfidence(value: unknown): "high" | "medium" | "low" | undefined {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return undefined;
}

function normalizeCandidate(raw: unknown): CaptureCandidate | null {
  const obj = asObject(raw);
  if (!obj) {
    return null;
  }
  const id = asString(obj.id);
  const status = asString(obj.status);
  const topic = asString(obj.topic);
  const key = asString(obj.key);
  const value = asString(obj.value);
  const source = asString(obj.source);
  if (!id || !status || !topic || !key || !value || !source) {
    return null;
  }
  return {
    id,
    status,
    topic,
    key,
    value,
    source,
    event_at: asString(obj.event_at ?? undefined) ?? undefined,
    confidence: normalizeConfidence(obj.confidence),
  };
}

function nextMemId(today: string, existingIds: Set<string>): string {
  const month = today.slice(0, 7);
  const prefix = `MEM-${month}-`;
  let seq = 0;
  for (const id of existingIds) {
    if (!id.startsWith(prefix)) {
      continue;
    }
    const suffix = id.slice(prefix.length);
    const parsed = Number.parseInt(suffix, 10);
    if (Number.isFinite(parsed) && parsed > seq) {
      seq = parsed;
    }
  }
  const next = `${prefix}${String(seq + 1).padStart(3, "0")}`;
  existingIds.add(next);
  return next;
}

async function readYamlList<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = await readFile(filePath, "utf8");
  const parsed = YAML.parse(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed as T[];
}

async function listInboxFiles(inboxDir: string): Promise<string[]> {
  if (!existsSync(inboxDir)) {
    return [];
  }
  const entries = await readdir(inboxDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => resolve(inboxDir, entry.name))
    .toSorted((left, right) => left.localeCompare(right));
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  if (args.help === true) {
    usageAndExit(0);
  }

  const today = typeof args.today === "string" ? args.today : formatDateNowUtc();
  const nowIso = new Date().toISOString();
  const to = parseTargetStatus(args.to);
  const memoryRoot = resolve(resolveMemoryRoot(args));
  const inboxDir = resolve(memoryRoot, "inbox");
  const archiveDir = resolve(inboxDir, "archive");
  const archivePath = resolve(archiveDir, `${today}.yml`);
  const explicitFile =
    typeof args.file === "string" && args.file.trim().length > 0 ? resolve(args.file) : null;
  const processAll = args.all === true;
  const defaultTodayFile = resolve(inboxDir, `${today}.yml`);
  const inboxFiles = explicitFile
    ? [explicitFile]
    : processAll
      ? await listInboxFiles(inboxDir)
      : [defaultTodayFile];

  const paths = resolveMemoryStatusPaths(args);
  const result = await withFileLock(
    {
      lockPath: resolveMemoryLockPath(memoryRoot, "status-store"),
    },
    async () => {
      await ensureStatusBuckets(paths);
      const buckets = await loadStatusBuckets(paths);
      const previous = cloneBuckets(buckets);
      const existing = flattenBuckets(buckets);
      const existingIds = new Set(existing.map((item) => item.id));
      const existingFingerprints = new Set(
        existing.map((item) => normalizeFingerprint(item.topic, item.key, String(item.value))),
      );

      const archiveRows: ProcessedArchiveRecord[] = [];
      const remainingByFile = new Map<string, unknown[]>();
      const promotedItems: MemoryItem[] = [];
      let duplicateCount = 0;
      let ignoredCount = 0;

      for (const inboxPath of inboxFiles) {
        const rows = await readYamlList<unknown>(inboxPath);
        const remaining: unknown[] = [];
        for (const row of rows) {
          const candidate = normalizeCandidate(row);
          if (!candidate || candidate.status !== "proposed" || !candidate.id.startsWith("CAND-")) {
            remaining.push(row);
            if (candidate?.id?.startsWith("CAND-")) {
              ignoredCount++;
            }
            continue;
          }

          const fingerprint = normalizeFingerprint(candidate.topic, candidate.key, candidate.value);
          if (existingFingerprints.has(fingerprint)) {
            duplicateCount++;
            archiveRows.push({
              processed_at: nowIso,
              inbox_file: inboxPath,
              candidate_id: candidate.id,
              result: "duplicate",
              reason: "same topic/key/value already exists in memory status buckets",
              topic: candidate.topic,
              key: candidate.key,
              value: candidate.value,
              source: candidate.source,
            });
            continue;
          }

          const eventDay = toEventDay(candidate, today);
          const memId = nextMemId(today, existingIds);
          const item: MemoryItem = {
            id: memId,
            topic: candidate.topic,
            key: candidate.key,
            value: candidate.value,
            status: to,
            source: candidate.source,
            effective_from: eventDay,
            expires: addDaysIso(eventDay, 180),
            scope: { env: "all" },
            updated: today,
            confidence: candidate.confidence ?? "medium",
            next: "Review candidate and promote to active if durable.",
          };
          const normalizedConfidence = normalizeConfidence(item.confidence);
          if (!normalizedConfidence) {
            item.confidence = "medium";
          }
          promotedItems.push(item);
          existingFingerprints.add(fingerprint);
          archiveRows.push({
            processed_at: nowIso,
            inbox_file: inboxPath,
            candidate_id: candidate.id,
            result: "promoted",
            mem_id: memId,
            topic: candidate.topic,
            key: candidate.key,
            value: candidate.value,
            source: candidate.source,
          });
        }
        remainingByFile.set(inboxPath, remaining);
      }

      if (promotedItems.length > 0) {
        buckets[to].push(...promotedItems);
        try {
          await saveStatusBuckets(paths, buckets);
          await rebuildUnifiedMemory(paths, buckets);
          const audit = await auditMemory(paths.memoryPath, today);
          const exit = auditExitCode(audit.issues);
          if (exit === 2) {
            throw new Error(
              `Audit failed after inbox promote: ${audit.issues.map((issue) => issue.message).join("; ")}`,
            );
          }
          await renderRuntimeActiveMemory(paths, buckets);
        } catch (error) {
          await saveStatusBuckets(paths, previous);
          await rebuildUnifiedMemory(paths, previous);
          await renderRuntimeActiveMemory(paths, previous);
          throw error;
        }
      }

      for (const [inboxPath, remaining] of remainingByFile.entries()) {
        await writeTextFile(
          inboxPath,
          YAML.stringify(remaining, {
            lineWidth: 0,
          }),
        );
      }

      if (archiveRows.length > 0) {
        const existingArchive = await readYamlList<ProcessedArchiveRecord>(archivePath);
        await writeTextFile(
          archivePath,
          YAML.stringify([...existingArchive, ...archiveRows], {
            lineWidth: 0,
          }),
        );
      }

      return {
        promoted: promotedItems.length,
        duplicates: duplicateCount,
        ignored: ignoredCount,
        archiveWritten: archiveRows.length > 0,
      };
    },
  );

  console.log("memory:inbox:promote done");
  console.log(`- memory root: ${memoryRoot}`);
  console.log(`- inbox files: ${inboxFiles.length}`);
  console.log(`- promoted: ${result.promoted}`);
  console.log(`- duplicates: ${result.duplicates}`);
  console.log(`- ignored: ${result.ignored}`);
  console.log(`- target status: ${to}`);
  if (result.archiveWritten) {
    console.log(`- archive: ${archivePath}`);
  }
  console.log(`- memory file: ${paths.memoryPath}`);
  console.log(`- runtime file: ${paths.workspaceMemoryPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory:inbox:promote failed: ${message}`);
  process.exitCode = 2;
});
