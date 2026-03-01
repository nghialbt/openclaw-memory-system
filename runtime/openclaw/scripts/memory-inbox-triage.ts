#!/usr/bin/env -S node --import tsx

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import { listActiveConflictPairs } from "./memory-conflicts";
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
  category?: string;
  topic: string;
  key: string;
  value: string;
  source: string;
  event_at?: string;
  confidence?: "low" | "medium" | "high";
};

type TriageArchiveRecord = {
  processed_at: string;
  inbox_file: string;
  candidate_id: string;
  result: "triaged" | "duplicate" | "ignored";
  reason?: string;
  score?: number;
  assigned_status?: MemoryStatus;
  mem_id?: string;
  topic?: string;
  key?: string;
  value?: string;
  source?: string;
};

type ModelDecision = {
  score: number;
  assigned_status: MemoryStatus;
  confidence?: "high" | "medium" | "low";
  reason?: string;
};

const DEFAULT_TRIAGE_MODEL = "google/gemini-3-flash-preview";
const DEFAULT_GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_OPENCLAW_CONFIG_PATH = resolve(homedir(), ".openclaw-ytb", "openclaw.json");

function usageAndExit(code: number): never {
  console.error(
    [
      "memory-inbox-triage.ts",
      "",
      "Usage:",
      "  node --import tsx scripts/memory-inbox-triage.ts [--today YYYY-MM-DD] [--root /path/to/memory] [--workspace-root /path/to/workspace] [--all] [--file /path/to/inbox.yml] [--high-threshold 80] [--pending-threshold 45] [--model google/gemini-3-flash-preview] [--openclaw-config /path/to/openclaw.json]",
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

function normalizeConfidence(value: unknown): "high" | "medium" | "low" | undefined {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return undefined;
}

function parseAssignedStatus(value: unknown): MemoryStatus | null {
  if (value === "active" || value === "pending" || value === "deprecated") {
    return value;
  }
  return null;
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
    category: asString(obj.category ?? undefined) ?? undefined,
    topic,
    key,
    value,
    source,
    event_at: asString(obj.event_at ?? undefined) ?? undefined,
    confidence: normalizeConfidence(obj.confidence),
  };
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

function findActiveConflictPeers(item: MemoryItem, activeItems: MemoryItem[]): string[] {
  if (item.status !== "active") {
    return [];
  }
  const peers = new Set<string>();
  for (const pair of listActiveConflictPairs([...activeItems, item])) {
    if (pair.left.id === item.id) {
      peers.add(pair.right.id);
    } else if (pair.right.id === item.id) {
      peers.add(pair.left.id);
    }
  }
  return [...peers].toSorted((left, right) => left.localeCompare(right));
}

function buildConflictPeerMap(items: MemoryItem[]): Map<string, Set<string>> {
  const peers = new Map<string, Set<string>>();
  for (const pair of listActiveConflictPairs(items)) {
    const leftPeers = peers.get(pair.left.id) ?? new Set<string>();
    leftPeers.add(pair.right.id);
    peers.set(pair.left.id, leftPeers);

    const rightPeers = peers.get(pair.right.id) ?? new Set<string>();
    rightPeers.add(pair.left.id);
    peers.set(pair.right.id, rightPeers);
  }
  return peers;
}

function moveActiveIdsToPending(params: {
  buckets: StatusBuckets;
  ids: Iterable<string>;
  today: string;
  reason: (id: string, item: MemoryItem) => string;
}): string[] {
  const targetIds = new Set(params.ids);
  if (targetIds.size === 0) {
    return [];
  }
  const keptActive: MemoryItem[] = [];
  const movedIds: string[] = [];
  for (const item of params.buckets.active) {
    if (!targetIds.has(item.id)) {
      keptActive.push(item);
      continue;
    }
    const note = params.reason(item.id, item);
    params.buckets.pending.push({
      ...item,
      status: "pending",
      updated: params.today,
      next: note,
    });
    movedIds.push(item.id);
  }
  params.buckets.active = keptActive;
  return movedIds;
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

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function deriveConfidence(score: number): "high" | "medium" | "low" {
  if (score >= 80) {
    return "high";
  }
  if (score >= 45) {
    return "medium";
  }
  return "low";
}

function statusFromScore(
  score: number,
  highThreshold: number,
  pendingThreshold: number,
): MemoryStatus {
  if (score >= highThreshold) {
    return "active";
  }
  if (score >= pendingThreshold) {
    return "pending";
  }
  return "deprecated";
}

function resolveOpenClawConfigPath(args: Record<string, string | boolean>): string {
  const fromArg = typeof args["openclaw-config"] === "string" ? args["openclaw-config"].trim() : "";
  if (fromArg.length > 0) {
    return resolve(fromArg);
  }
  const fromEnv = process.env.OPENCLAW_CONFIG?.trim() ?? "";
  if (fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  return DEFAULT_OPENCLAW_CONFIG_PATH;
}

async function readKeyFromOpenClawConfig(configPath: string): Promise<string> {
  if (!existsSync(configPath)) {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return "";
  }
  const root = asObject(parsed);
  const env = asObject(root?.env);
  return asString(env?.GEMINI_API_KEY) ?? asString(env?.GOOGLE_API_KEY) ?? "";
}

async function resolveGoogleApiKey(
  args: Record<string, string | boolean>,
): Promise<{ key: string; source: "env" | "openclaw-config" }> {
  const envKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";
  if (envKey.length > 0) {
    return { key: envKey, source: "env" };
  }

  const configPath = resolveOpenClawConfigPath(args);
  const configKey = await readKeyFromOpenClawConfig(configPath);
  if (configKey.length > 0) {
    return { key: configKey, source: "openclaw-config" };
  }

  throw new Error(
    `Missing GEMINI_API_KEY or GOOGLE_API_KEY for model triage (env + ${configPath}).`,
  );
}

function parseGeminiModelId(modelRef: string): string {
  const trimmed = modelRef.trim();
  if (!trimmed) {
    return "gemini-3-flash-preview";
  }
  if (trimmed.startsWith("google/")) {
    return trimmed.slice("google/".length);
  }
  return trimmed;
}

function extractGeminiText(response: unknown): string {
  const obj = asObject(response);
  if (!obj) {
    return "";
  }
  const candidates = Array.isArray(obj.candidates) ? obj.candidates : [];
  const first = asObject(candidates[0]);
  const content = asObject(first?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const texts: string[] = [];
  for (const part of parts) {
    const entry = asObject(part);
    if (entry && typeof entry.text === "string") {
      texts.push(entry.text);
    }
  }
  return texts.join("\n").trim();
}

function parseDecisionJson(text: string): RawObject | null {
  const direct = text.trim();
  if (!direct) {
    return null;
  }
  try {
    const parsed = JSON.parse(direct);
    return asObject(parsed);
  } catch {}

  const match = /{[\s\S]*}/.exec(direct);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]);
    return asObject(parsed);
  } catch {
    return null;
  }
}

async function decideWithGemini(params: {
  candidate: CaptureCandidate;
  modelRef: string;
  googleBaseUrl: string;
  googleApiKey: string;
  highThreshold: number;
  pendingThreshold: number;
}): Promise<ModelDecision> {
  const modelId = parseGeminiModelId(params.modelRef);
  const endpoint = `${params.googleBaseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(params.googleApiKey)}`;

  const prompt = [
    "You are a strict memory triage classifier.",
    "Classify this candidate memory into one status: active | pending | deprecated.",
    "Return JSON only with keys: score (0-100 int), assigned_status, confidence (high|medium|low), reason.",
    "Rules:",
    "- active = durable policy/decision/preference with high operational value.",
    "- pending = plausible but needs human review.",
    "- deprecated = weak/obsolete/noisy/not durable.",
    `Threshold guidance: active>=${params.highThreshold}, pending>=${params.pendingThreshold}, else deprecated.`,
    "",
    `Candidate JSON: ${JSON.stringify(params.candidate)}`,
  ].join("\n");

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Gemini triage request failed (${response.status}): ${text || response.statusText}`,
    );
  }
  const data = (await response.json()) as unknown;
  const text = extractGeminiText(data);
  const parsed = parseDecisionJson(text);
  if (!parsed) {
    throw new Error(`Gemini triage returned non-JSON output: ${text.slice(0, 300)}`);
  }

  const rawScore = Number(parsed.score);
  const score = Number.isFinite(rawScore) ? clampScore(rawScore) : NaN;
  const assignedFromModel = parseAssignedStatus(parsed.assigned_status);
  const confidence = normalizeConfidence(parsed.confidence);
  const reason = asString(parsed.reason ?? undefined) ?? undefined;

  if (!Number.isFinite(score) && !assignedFromModel) {
    throw new Error(`Gemini triage JSON missing score/status: ${JSON.stringify(parsed)}`);
  }

  const effectiveScore = Number.isFinite(score)
    ? score
    : assignedFromModel === "active"
      ? Math.max(80, params.highThreshold)
      : assignedFromModel === "pending"
        ? Math.max(45, params.pendingThreshold)
        : 25;
  const assigned_status =
    assignedFromModel ??
    statusFromScore(effectiveScore, params.highThreshold, params.pendingThreshold);

  return {
    score: effectiveScore,
    assigned_status,
    confidence,
    reason,
  };
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

function parseThreshold(value: unknown, fallback: number): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return clampScore(parsed);
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  if (args.help === true) {
    usageAndExit(0);
  }

  const today = typeof args.today === "string" ? args.today : formatDateNowUtc();
  const nowIso = new Date().toISOString();
  const highThreshold = parseThreshold(args["high-threshold"], 80);
  const pendingThreshold = Math.min(highThreshold, parseThreshold(args["pending-threshold"], 45));
  const modelRef =
    typeof args.model === "string"
      ? args.model.trim() || DEFAULT_TRIAGE_MODEL
      : DEFAULT_TRIAGE_MODEL;
  const googleBaseUrl =
    typeof args["google-base-url"] === "string"
      ? args["google-base-url"].trim() || DEFAULT_GOOGLE_BASE_URL
      : DEFAULT_GOOGLE_BASE_URL;
  const keyResolution = await resolveGoogleApiKey(args);
  const googleApiKey = keyResolution.key;
  const memoryRoot = resolve(resolveMemoryRoot(args));
  const inboxDir = resolve(memoryRoot, "inbox");
  const archiveDir = resolve(inboxDir, "archive");
  const archivePath = resolve(archiveDir, `triage-${today}.yml`);
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

      const archiveRows: TriageArchiveRecord[] = [];
      const remainingByFile = new Map<string, unknown[]>();
      const triaged: MemoryItem[] = [];
      const triagedCounts: Record<MemoryStatus, number> = {
        active: 0,
        pending: 0,
        deprecated: 0,
      };
      let quarantinedCount = 0;
      const preexistingConflictPeers = buildConflictPeerMap(buckets.active);
      if (preexistingConflictPeers.size > 0) {
        const moved = moveActiveIdsToPending({
          buckets,
          ids: preexistingConflictPeers.keys(),
          today,
          reason: (id, item) => {
            const peers = [...(preexistingConflictPeers.get(id) ?? [])].toSorted((a, b) =>
              a.localeCompare(b),
            );
            const note = `Auto-moved to pending during triage due to conflict with ${peers.join(", ")}.`;
            return item.next ? `${item.next} ${note}` : note;
          },
        });
        quarantinedCount += moved.length;
      }
      let prospectiveActive: MemoryItem[] = [...buckets.active];
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
              archiveRows.push({
                processed_at: nowIso,
                inbox_file: inboxPath,
                candidate_id: candidate.id,
                result: "ignored",
                reason: "candidate is not in proposed state",
                source: candidate.source,
              });
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

          const decision = await decideWithGemini({
            candidate,
            modelRef,
            googleBaseUrl,
            googleApiKey,
            highThreshold,
            pendingThreshold,
          });
          const score = decision.score;
          let assignedStatus = decision.assigned_status;
          const eventDay = toEventDay(candidate, today);
          const memId = nextMemId(today, existingIds);
          const item: MemoryItem = {
            id: memId,
            topic: candidate.topic,
            key: candidate.key,
            value: candidate.value,
            status: assignedStatus,
            source: candidate.source,
            effective_from: eventDay,
            expires: addDaysIso(eventDay, 180),
            scope: { env: "all" },
            updated: today,
            confidence: decision.confidence ?? deriveConfidence(score),
            next: decision.reason ?? "Auto-triaged by Gemini model.",
          };
          if (assignedStatus === "active") {
            const conflictIds = findActiveConflictPeers(item, prospectiveActive);
            if (conflictIds.length > 0) {
              assignedStatus = "pending";
              item.status = "pending";
              const conflictReason = `Downgraded to pending due to active conflict with ${conflictIds.join(", ")}.`;
              item.next = decision.reason ? `${decision.reason} ${conflictReason}` : conflictReason;
              const moved = moveActiveIdsToPending({
                buckets,
                ids: conflictIds,
                today,
                reason: (id, existingItem) => {
                  const note = `Auto-moved to pending during triage due to incoming conflict with ${item.id}.`;
                  return existingItem.next ? `${existingItem.next} ${note}` : note;
                },
              });
              quarantinedCount += moved.length;
              prospectiveActive = [...buckets.active];
            } else {
              prospectiveActive.push(item);
            }
          }

          triaged.push(item);
          triagedCounts[assignedStatus] += 1;
          existingFingerprints.add(fingerprint);
          archiveRows.push({
            processed_at: nowIso,
            inbox_file: inboxPath,
            candidate_id: candidate.id,
            result: "triaged",
            score,
            assigned_status: assignedStatus,
            mem_id: memId,
            topic: candidate.topic,
            key: candidate.key,
            value: candidate.value,
            source: candidate.source,
          });
        }
        remainingByFile.set(inboxPath, remaining);
      }

      if (triaged.length > 0 || quarantinedCount > 0) {
        for (const item of triaged) {
          buckets[item.status].push(item);
        }
        try {
          await saveStatusBuckets(paths, buckets);
          await rebuildUnifiedMemory(paths, buckets);
          const audit = await auditMemory(paths.memoryPath, today);
          const exit = auditExitCode(audit.issues);
          if (exit === 2) {
            throw new Error(
              `Audit failed after inbox triage: ${audit.issues.map((issue) => issue.message).join("; ")}`,
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
        const existingArchive = await readYamlList<TriageArchiveRecord>(archivePath);
        await writeTextFile(
          archivePath,
          YAML.stringify([...existingArchive, ...archiveRows], {
            lineWidth: 0,
          }),
        );
      }

      return {
        triaged: triaged.length,
        triagedCounts,
        duplicates: duplicateCount,
        ignored: ignoredCount,
        quarantined: quarantinedCount,
      };
    },
  );

  console.log("memory:inbox:triage done");
  console.log(`- memory root: ${memoryRoot}`);
  console.log(`- inbox files: ${inboxFiles.length}`);
  console.log(`- triaged total: ${result.triaged}`);
  console.log(
    `- triaged by status: active=${result.triagedCounts.active} pending=${result.triagedCounts.pending} deprecated=${result.triagedCounts.deprecated}`,
  );
  console.log(`- quarantined conflicts: ${result.quarantined}`);
  console.log(`- duplicates: ${result.duplicates}`);
  console.log(`- ignored: ${result.ignored}`);
  console.log(`- thresholds: high>=${highThreshold}, pending>=${pendingThreshold}`);
  console.log(`- model: ${modelRef}`);
  console.log(`- auth source: ${keyResolution.source}`);
  console.log(`- archive: ${archivePath}`);
  console.log(`- memory file: ${paths.memoryPath}`);
  console.log(`- runtime file: ${paths.workspaceMemoryPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory:inbox:triage failed: ${message}`);
  process.exitCode = 2;
});
