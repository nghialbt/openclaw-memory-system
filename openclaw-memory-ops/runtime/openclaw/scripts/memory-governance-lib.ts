import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import YAML from "yaml";
import { listActiveConflictPairs } from "./memory-conflicts";

export type MemoryStatus = "active" | "pending" | "deprecated";
export type MemoryEnv = "all" | "prod" | "staging" | "dev";

type PrimitiveValue = string | number | boolean;

type RawObject = Record<string, unknown>;

export type MemoryScope = {
  env: MemoryEnv;
  service?: string;
  region?: string;
};

export type MemoryItem = {
  id: string;
  topic: string;
  key: string;
  value: PrimitiveValue;
  status: MemoryStatus;
  source: string;
  effective_from: string;
  expires: string;
  scope: MemoryScope;
  updated?: string;
  confidence?: "high" | "medium" | "low";
  next?: string;
};

export type AuditIssueCode = "schema" | "duplicate-id" | "no-source" | "stale" | "conflict";

export type AuditIssue = {
  code: AuditIssueCode;
  message: string;
  ids: string[];
};

export type AuditSummary = {
  filePath: string;
  today: string;
  items: MemoryItem[];
  issues: AuditIssue[];
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^MEM-\d{4}-\d{2}-\d{3}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 200;
const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;

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
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseIsoDay(value: string): number | null {
  if (!ISO_DAY.test(value)) {
    return null;
  }
  const ts = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ts) ? ts : null;
}

function isValidSource(source: string): boolean {
  return (
    source.startsWith("https://") ||
    source.startsWith("docs/") ||
    source.startsWith("memory/") ||
    source.startsWith("src/")
  );
}

function normalizeEnv(value: unknown): MemoryEnv | null {
  if (value === undefined) {
    return "all";
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "all" ||
    normalized === "prod" ||
    normalized === "staging" ||
    normalized === "dev"
  ) {
    return normalized;
  }
  return null;
}

function normalizeStatus(value: unknown): MemoryStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "active" || normalized === "pending" || normalized === "deprecated") {
    return normalized;
  }
  return null;
}

function normalizeConfidence(value: unknown): "high" | "medium" | "low" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") {
    return normalized;
  }
  return undefined;
}

function primitiveValue(value: unknown): PrimitiveValue | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
}

function makeIssue(code: AuditIssueCode, message: string, ids: string[]): AuditIssue {
  return { code, message, ids };
}

function buildItem(raw: unknown, index: number): { item?: MemoryItem; issues: AuditIssue[] } {
  const issues: AuditIssue[] = [];
  const obj = asObject(raw);
  if (!obj) {
    return {
      issues: [makeIssue("schema", `Item #${index + 1} is not a valid object`, [])],
    };
  }

  const id = asString(obj.id);
  if (!id) {
    issues.push(makeIssue("schema", `Item #${index + 1} is missing 'id'`, []));
  } else if (!ID_PATTERN.test(id)) {
    issues.push(makeIssue("schema", `Item ${id} has invalid id format`, [id]));
  }

  const topic = asString(obj.topic);
  if (!topic) {
    issues.push(
      makeIssue("schema", `Item ${id ?? `#${index + 1}`} is missing 'topic'`, id ? [id] : []),
    );
  }

  const key = asString(obj.key);
  if (!key) {
    issues.push(
      makeIssue("schema", `Item ${id ?? `#${index + 1}`} is missing 'key'`, id ? [id] : []),
    );
  }

  const value = primitiveValue(obj.value);
  if (value === null) {
    issues.push(
      makeIssue("schema", `Item ${id ?? `#${index + 1}`} has invalid 'value' type`, id ? [id] : []),
    );
  }

  const status = normalizeStatus(obj.status);
  if (!status) {
    issues.push(
      makeIssue("schema", `Item ${id ?? `#${index + 1}`} has invalid 'status'`, id ? [id] : []),
    );
  }

  const source = asString(obj.source);
  if (!source) {
    issues.push(
      makeIssue("no-source", `Item ${id ?? `#${index + 1}`} is missing 'source'`, id ? [id] : []),
    );
  } else if (!isValidSource(source)) {
    issues.push(
      makeIssue(
        "no-source",
        `Item ${id ?? `#${index + 1}`} has invalid source '${source}'`,
        id ? [id] : [],
      ),
    );
  }

  const effectiveFrom = asString(obj.effective_from);
  if (!effectiveFrom || parseIsoDay(effectiveFrom) === null) {
    issues.push(
      makeIssue(
        "schema",
        `Item ${id ?? `#${index + 1}`} has invalid 'effective_from' date`,
        id ? [id] : [],
      ),
    );
  }

  const expires = asString(obj.expires);
  if (!expires || parseIsoDay(expires) === null) {
    issues.push(
      makeIssue(
        "schema",
        `Item ${id ?? `#${index + 1}`} has invalid 'expires' date`,
        id ? [id] : [],
      ),
    );
  }

  if (effectiveFrom && expires) {
    const effectiveTs = parseIsoDay(effectiveFrom);
    const expiresTs = parseIsoDay(expires);
    if (effectiveTs !== null && expiresTs !== null && effectiveTs > expiresTs) {
      issues.push(
        makeIssue(
          "schema",
          `Item ${id ?? `#${index + 1}`} has effective_from after expires`,
          id ? [id] : [],
        ),
      );
    }
  }

  const scopeRaw = obj.scope === undefined ? {} : asObject(obj.scope);
  if (obj.scope !== undefined && !scopeRaw) {
    issues.push(
      makeIssue("schema", `Item ${id ?? `#${index + 1}`} has invalid 'scope'`, id ? [id] : []),
    );
  }

  const env = normalizeEnv(scopeRaw?.env);
  if (!env) {
    issues.push(
      makeIssue(
        "schema",
        `Item ${id ?? `#${index + 1}`} has invalid 'scope.env' (use all|prod|staging|dev)`,
        id ? [id] : [],
      ),
    );
  }

  const service = asString(scopeRaw?.service ?? undefined) ?? undefined;
  const region = asString(scopeRaw?.region ?? undefined) ?? undefined;

  const updated = asString(obj.updated ?? undefined) ?? undefined;
  if (updated && parseIsoDay(updated) === null) {
    issues.push(
      makeIssue(
        "schema",
        `Item ${id ?? `#${index + 1}`} has invalid 'updated' date`,
        id ? [id] : [],
      ),
    );
  }

  const next = asString(obj.next ?? undefined) ?? undefined;
  const confidence = normalizeConfidence(obj.confidence);

  if (
    issues.length > 0 ||
    !id ||
    !topic ||
    !key ||
    value === null ||
    !status ||
    !source ||
    !effectiveFrom ||
    !expires ||
    !env
  ) {
    return { issues };
  }

  const item: MemoryItem = {
    id,
    topic,
    key,
    value,
    status,
    source,
    effective_from: effectiveFrom,
    expires,
    scope: {
      env,
      service,
      region,
    },
  };

  if (updated) {
    item.updated = updated;
  }
  if (confidence) {
    item.confidence = confidence;
  }
  if (next) {
    item.next = next;
  }

  return { item, issues };
}

export function formatDateNowUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function monthBucket(date: string): string {
  return date.slice(0, 7);
}

export function isExpired(item: MemoryItem, today: string): boolean {
  const itemTs = parseIsoDay(item.expires);
  const todayTs = parseIsoDay(today);
  if (itemTs === null || todayTs === null) {
    return false;
  }
  return itemTs < todayTs;
}

export function sortItems(items: MemoryItem[]): MemoryItem[] {
  return [...items].toSorted((a, b) => {
    if (a.topic !== b.topic) {
      return a.topic.localeCompare(b.topic);
    }
    if (a.key !== b.key) {
      return a.key.localeCompare(b.key);
    }
    return a.id.localeCompare(b.id);
  });
}

export async function readMemoryItems(
  filePath: string,
): Promise<{ items: MemoryItem[]; issues: AuditIssue[] }> {
  if (!existsSync(filePath)) {
    return {
      items: [],
      issues: [makeIssue("schema", `Missing memory file: ${filePath}`, [])],
    };
  }

  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    return {
      items: [],
      issues: [
        makeIssue("schema", `Failed to parse YAML in ${filePath}: ${(error as Error).message}`, []),
      ],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      items: [],
      issues: [makeIssue("schema", `${filePath} must contain a top-level YAML list`, [])],
    };
  }

  const items: MemoryItem[] = [];
  const issues: AuditIssue[] = [];

  for (let index = 0; index < parsed.length; index++) {
    const { item, issues: entryIssues } = buildItem(parsed[index], index);
    issues.push(...entryIssues);
    if (item) {
      items.push(item);
    }
  }

  return { items, issues };
}

export function runAudit(
  items: MemoryItem[],
  initialIssues: AuditIssue[],
  today: string,
): AuditIssue[] {
  const issues = [...initialIssues];

  const seen = new Map<string, string[]>();
  for (const item of items) {
    const current = seen.get(item.id) ?? [];
    current.push(item.id);
    seen.set(item.id, current);
  }
  for (const [id, entries] of seen.entries()) {
    if (entries.length > 1) {
      issues.push(
        makeIssue("duplicate-id", `Duplicate id '${id}' appears ${entries.length} times`, [id]),
      );
    }
  }

  const active = items.filter((item) => item.status === "active");

  for (const item of active) {
    if (isExpired(item, today)) {
      issues.push(
        makeIssue("stale", `Item ${item.id} is active but expired on ${item.expires}`, [item.id]),
      );
    }
  }

  for (const pair of listActiveConflictPairs(items)) {
    issues.push(
      makeIssue(
        "conflict",
        `Conflict between ${pair.left.id} and ${pair.right.id} (same topic/key with overlapping scope+time but different value)`,
        [pair.left.id, pair.right.id],
      ),
    );
  }

  return issues;
}

export async function auditMemory(filePath: string, today: string): Promise<AuditSummary> {
  const { items, issues: parseIssues } = await readMemoryItems(filePath);
  const issues = runAudit(items, parseIssues, today);
  return {
    filePath,
    today,
    items: sortItems(items),
    issues,
  };
}

export function groupIssues(issues: AuditIssue[]): Record<AuditIssueCode, AuditIssue[]> {
  return {
    schema: issues.filter((issue) => issue.code === "schema"),
    "duplicate-id": issues.filter((issue) => issue.code === "duplicate-id"),
    "no-source": issues.filter((issue) => issue.code === "no-source"),
    stale: issues.filter((issue) => issue.code === "stale"),
    conflict: issues.filter((issue) => issue.code === "conflict"),
  };
}

export function auditExitCode(issues: AuditIssue[]): number {
  const hasSevere = issues.some(
    (issue) =>
      issue.code === "schema" ||
      issue.code === "duplicate-id" ||
      issue.code === "no-source" ||
      issue.code === "conflict",
  );
  if (hasSevere) {
    return 2;
  }
  if (issues.some((issue) => issue.code === "stale")) {
    return 1;
  }
  return 0;
}

export function serializeItems(items: MemoryItem[]): string {
  return YAML.stringify(sortItems(items), {
    lineWidth: 0,
  });
}

export function resolveMemoryLockPath(memoryRoot: string, lockName: string): string {
  const safeName = lockName.replace(/[^a-z0-9._-]+/gi, "-");
  return resolve(memoryRoot, "locks", `${safeName}.lock`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function readLockAgeMs(lockPath: string): Promise<number | null> {
  try {
    const lockStat = await stat(lockPath);
    if (!Number.isFinite(lockStat.mtimeMs)) {
      return null;
    }
    return Date.now() - lockStat.mtimeMs;
  } catch {
    return null;
  }
}

export async function withFileLock<T>(
  params: {
    lockPath: string;
    timeoutMs?: number;
    retryMs?: number;
    staleMs?: number;
  },
  task: () => Promise<T>,
): Promise<T> {
  const timeoutMs = Math.max(1_000, params.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const retryMs = Math.max(50, params.retryMs ?? DEFAULT_LOCK_RETRY_MS);
  const staleMs = Math.max(60_000, params.staleMs ?? DEFAULT_LOCK_STALE_MS);
  const startedAt = Date.now();

  while (true) {
    await mkdir(dirname(params.lockPath), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(params.lockPath, "wx");
      const payload = {
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      try {
        return await task();
      } finally {
        await handle.close().catch(() => {});
        await unlink(params.lockPath).catch(() => {});
      }
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
      }
      const errObj = error as NodeJS.ErrnoException;
      if (errObj?.code !== "EEXIST") {
        throw error;
      }

      const ageMs = await readLockAgeMs(params.lockPath);
      if (ageMs !== null && ageMs > staleMs) {
        await unlink(params.lockPath).catch(() => {});
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timeout acquiring lock: ${params.lockPath}`, { cause: error });
      }
      await sleep(retryMs);
    }
  }
}

export async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = resolve(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await writeTextFileAtomic(filePath, content);
}

export async function writeMemoryItems(filePath: string, items: MemoryItem[]): Promise<void> {
  await writeTextFile(filePath, serializeItems(items));
}

export function reportHeader(summary: AuditSummary): string {
  return [
    "# Memory Audit Report",
    "",
    `- Date: ${summary.today}`,
    `- File: ${summary.filePath}`,
    `- Items: ${summary.items.length}`,
    "",
  ].join("\n");
}

export function reportBody(issues: AuditIssue[]): string {
  if (issues.length === 0) {
    return "## Result\n\nNo issues found.\n";
  }

  const groups = groupIssues(issues);
  const sections: string[] = ["## Result", ""];
  const ordered: AuditIssueCode[] = ["schema", "duplicate-id", "no-source", "conflict", "stale"];

  for (const code of ordered) {
    const items = groups[code];
    if (items.length === 0) {
      continue;
    }
    sections.push(`### ${code} (${items.length})`);
    sections.push("");
    for (const issue of items) {
      const suffix = issue.ids.length > 0 ? ` [${issue.ids.join(", ")}]` : "";
      sections.push(`- ${issue.message}${suffix}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

export function asCliArgMap(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      args[key] = value;
      index++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function defaultMemoryRoot(): string {
  return resolve(homedir(), ".openclaw-ytb", "memory");
}

export function resolveMemoryRoot(args: Record<string, string | boolean>): string {
  const rootFromArg = typeof args.root === "string" ? args.root.trim() : "";
  if (rootFromArg) {
    return rootFromArg;
  }
  const rootFromEnv = process.env.OPENCLAW_MEMORY_ROOT?.trim() ?? "";
  if (rootFromEnv) {
    return rootFromEnv;
  }
  return defaultMemoryRoot();
}
