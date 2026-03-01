#!/usr/bin/env -S node --import tsx

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import YAML from "yaml";
import {
  asCliArgMap,
  formatDateNowUtc,
  resolveMemoryRoot,
  writeTextFile,
} from "./memory-governance-lib";

type CandidateCategory = "decision" | "constraint" | "preference" | "state";
type CandidateConfidence = "low" | "medium" | "high";

type CaptureCandidate = {
  id: string;
  status: "proposed";
  category: CandidateCategory;
  topic: string;
  key: string;
  value: string;
  source: string;
  session_id: string;
  message_id: string;
  event_at: string;
  captured_at: string;
  confidence: CandidateConfidence;
};

type CaptureState = {
  agent: string;
  lastEventMs: number;
  updatedAt: string;
  inboxPath: string;
};

type RawRecord = Record<string, unknown>;

const HARD_MEMORY_KEYWORDS = [
  "memory",
  "audit",
  "prune",
  "cron",
  "conflict",
  "stale",
  "no-source",
  "render",
  "openclaw_memory_root",
  ".openclaw-ytb",
];

const ACTION_HINTS = [
  "must",
  "always",
  "never",
  "need",
  "should",
  "run",
  "schedule",
  "register",
  "disable",
  "enable",
  "remove",
  "implement",
  "cần",
  "phải",
  "nên",
  "hãy",
  "chạy",
  "đăng kí",
  "triển khai",
  "chuyển",
  "lưu",
  "dọn",
  "kiểm tra",
];

function asObject(value: unknown): RawRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as RawRecord;
}

function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function scalarToString(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return "";
}

function defaultSessionsRoot(agent: string): string {
  return resolve(homedir(), ".openclaw-ytb", "agents", agent, "sessions");
}

function normalizeLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\s+/g, " ");
}

function hasAnyToken(text: string, tokens: string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

function shouldCaptureLine(raw: string): boolean {
  const line = normalizeLine(raw);
  if (line.length < 20 || line.length > 320) {
    return false;
  }
  const lower = line.toLowerCase();
  if (lower.includes("[cron:") || lower.includes("run this exactly")) {
    return false;
  }
  if (lower.includes("?")) {
    return false;
  }
  if (/^(bước|step)\s*\d+\b/i.test(lower)) {
    return false;
  }
  if (line.length <= 140 && line === line.toUpperCase()) {
    return false;
  }
  const hasHardSignal =
    hasAnyToken(lower, HARD_MEMORY_KEYWORDS) ||
    (lower.includes("session") && lower.includes("memory"));
  return hasHardSignal && hasAnyToken(lower, ACTION_HINTS);
}

function classifyCategory(line: string): CandidateCategory {
  const lower = line.toLowerCase();
  if (lower.includes("prefer") || lower.includes("ưu tiên")) {
    return "preference";
  }
  if (
    lower.includes("must") ||
    lower.includes("always") ||
    lower.includes("never") ||
    lower.includes("phải") ||
    lower.includes("không được")
  ) {
    return "constraint";
  }
  if (
    lower.includes("quyết định") ||
    lower.includes("decision") ||
    lower.includes("remove") ||
    lower.includes("disable")
  ) {
    return "decision";
  }
  return "state";
}

function classifyTopic(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes("memory")) {
    return "memory-governance";
  }
  if (lower.includes("cron")) {
    return "scheduler";
  }
  return "session-policy";
}

function classifyKey(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes("openclaw_memory_root") || lower.includes(".openclaw-ytb/memory")) {
    return "memory_root";
  }
  if (lower.includes("audit")) {
    return "audit_policy";
  }
  if (lower.includes("prune")) {
    return "prune_policy";
  }
  if (lower.includes("session")) {
    return "source_policy";
  }
  if (lower.includes("cron")) {
    return "scheduler_mode";
  }
  return "note";
}

function confidenceForCategory(category: CandidateCategory): CandidateConfidence {
  return category === "decision" || category === "constraint" ? "high" : "medium";
}

function normalizeFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseTextParts(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const entry of content) {
    const obj = asObject(entry);
    if (!obj) {
      continue;
    }
    if (obj.type !== "text" || typeof obj.text !== "string") {
      continue;
    }
    parts.push(obj.text);
  }
  return parts;
}

function resolveEventMs(record: RawRecord, message: RawRecord): number | null {
  const direct = toMs(message.timestamp);
  if (direct !== null) {
    return direct;
  }
  return toMs(record.timestamp);
}

async function readJsonArrayIfExists<T>(filePath: string): Promise<T[]> {
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

async function readState(statePath: string): Promise<CaptureState | null> {
  if (!existsSync(statePath)) {
    return null;
  }
  const raw = await readFile(statePath, "utf8");
  const parsed = JSON.parse(raw);
  const obj = asObject(parsed);
  if (!obj || typeof obj.lastEventMs !== "number" || !Number.isFinite(obj.lastEventMs)) {
    return null;
  }
  return {
    agent: typeof obj.agent === "string" ? obj.agent : "main",
    lastEventMs: obj.lastEventMs,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date(0).toISOString(),
    inboxPath: typeof obj.inboxPath === "string" ? obj.inboxPath : "",
  };
}

async function listSessionFiles(sessionsRoot: string): Promise<string[]> {
  const entries = await readdir(sessionsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => resolve(sessionsRoot, entry.name))
    .toSorted((left, right) => left.localeCompare(right));
}

function nextCandidateId(today: string, existing: CaptureCandidate[], sequence: number): string {
  const compact = today.replaceAll("-", "");
  const existingSeq = existing
    .map((item) => {
      const match = /^CAND-\d{8}-(\d{3})$/.exec(item.id);
      return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
    })
    .filter((value) => Number.isFinite(value));
  const maxExisting = existingSeq.length > 0 ? Math.max(...existingSeq) : 0;
  return `CAND-${compact}-${String(maxExisting + sequence).padStart(3, "0")}`;
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  const now = new Date();
  const nowIso = now.toISOString();
  const today = typeof args.today === "string" ? args.today : formatDateNowUtc();
  const agent = typeof args.agent === "string" ? args.agent.trim() || "main" : "main";

  const memoryRoot = resolve(resolveMemoryRoot(args));
  const sessionsRoot =
    typeof args["sessions-root"] === "string"
      ? resolve(args["sessions-root"])
      : defaultSessionsRoot(agent);
  const inboxPath =
    typeof args.inbox === "string"
      ? resolve(args.inbox)
      : resolve(memoryRoot, "inbox", `${today}.yml`);
  const statePath =
    typeof args.state === "string"
      ? resolve(args.state)
      : resolve(memoryRoot, "state", `capture-from-session.${agent}.json`);

  const lookbackHoursRaw = typeof args["lookback-hours"] === "string" ? args["lookback-hours"] : "";
  const lookbackHours = Number.parseInt(lookbackHoursRaw || "24", 10);
  const fallbackSinceMs = now.getTime() - Math.max(1, lookbackHours) * 60 * 60 * 1000;

  const state = await readState(statePath);
  const sinceMs = typeof args.since === "string" ? Date.parse(args.since) : state?.lastEventMs;
  const effectiveSinceMs = Number.isFinite(sinceMs ?? Number.NaN)
    ? (sinceMs as number)
    : fallbackSinceMs;

  if (!existsSync(sessionsRoot)) {
    throw new Error(`Session root does not exist: ${sessionsRoot}`);
  }

  const files = await listSessionFiles(sessionsRoot);
  const existingInbox = await readJsonArrayIfExists<CaptureCandidate>(inboxPath);
  const seen = new Set(
    existingInbox.map((item) => normalizeFingerprint(`${item.key}|${item.value}`)),
  );

  const pending: CaptureCandidate[] = [];
  let maxEventMs = effectiveSinceMs;
  let inspectedMessages = 0;
  let matchedLines = 0;

  for (const filePath of files) {
    const sessionId = basename(filePath, ".jsonl");
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const record = asObject(parsed);
      if (!record || record.type !== "message") {
        continue;
      }
      const message = asObject(record.message);
      if (!message || message.role !== "user") {
        continue;
      }
      const eventMs = resolveEventMs(record, message);
      if (eventMs === null || eventMs <= effectiveSinceMs) {
        continue;
      }
      if (eventMs > maxEventMs) {
        maxEventMs = eventMs;
      }
      inspectedMessages++;
      const textParts = parseTextParts(message.content);
      if (textParts.length === 0) {
        continue;
      }
      for (const part of textParts) {
        const rawLines = part.split("\n").map(normalizeLine).filter(Boolean);
        for (const rawLine of rawLines) {
          if (!shouldCaptureLine(rawLine)) {
            continue;
          }
          matchedLines++;
          const category = classifyCategory(rawLine);
          const key = classifyKey(rawLine);
          const fingerprint = normalizeFingerprint(`${key}|${rawLine}`);
          if (seen.has(fingerprint)) {
            continue;
          }
          seen.add(fingerprint);
          const messageId = scalarToString(record.id);
          pending.push({
            id: "",
            status: "proposed",
            category,
            topic: classifyTopic(rawLine),
            key,
            value: rawLine,
            source: `memory/session/${agent}/${sessionId}.jsonl#${messageId}`,
            session_id: sessionId,
            message_id: messageId,
            event_at: new Date(eventMs).toISOString(),
            captured_at: nowIso,
            confidence: confidenceForCategory(category),
          });
        }
      }
    }
  }

  for (let index = 0; index < pending.length; index++) {
    pending[index].id = nextCandidateId(today, [...existingInbox, ...pending.slice(0, index)], 1);
  }

  const merged = [...existingInbox, ...pending];
  await writeTextFile(
    inboxPath,
    YAML.stringify(merged, {
      lineWidth: 0,
    }),
  );

  const nextState: CaptureState = {
    agent,
    lastEventMs: maxEventMs,
    updatedAt: nowIso,
    inboxPath,
  };
  await writeTextFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`);

  console.log("memory:capture-from-session done");
  console.log(`- agent: ${agent}`);
  console.log(`- session root: ${sessionsRoot}`);
  console.log(`- memory root: ${memoryRoot}`);
  console.log(`- since: ${new Date(effectiveSinceMs).toISOString()}`);
  console.log(`- inspected messages: ${inspectedMessages}`);
  console.log(`- matched lines: ${matchedLines}`);
  console.log(`- new candidates: ${pending.length}`);
  console.log(`- inbox: ${inboxPath}`);
  console.log(`- state: ${statePath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory:capture-from-session failed: ${message}`);
  process.exitCode = 2;
});
