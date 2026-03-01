import { existsSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  conflictPairId,
  isUnresolvedConflictPair,
  listUnresolvedConflictPairs,
} from "./memory-conflicts";
import {
  auditExitCode,
  auditMemory,
  formatDateNowUtc,
  MemoryItem,
  MemoryStatus,
  readMemoryItems,
  resolveMemoryLockPath,
  resolveMemoryRoot,
  sortItems,
  withFileLock,
  writeMemoryItems,
  writeTextFile,
} from "./memory-governance-lib";
import {
  buildActiveTopicShards,
  buildMemoryMarkdown,
  buildTopicShardIndexMarkdown,
  buildTopicShardMarkdown,
} from "./memory-render-format";

export type StatusBuckets = Record<MemoryStatus, MemoryItem[]>;
export type MemoryValue = string | number | boolean;
export type MemoryConflictPair = {
  pair_id: string;
  topic: string;
  key: string;
  left: MemoryItem;
  right: MemoryItem;
};

export type MemoryStatusPaths = {
  memoryRoot: string;
  workspaceRoot: string;
  memoryPath: string;
  workspaceMemoryPath: string;
  workspaceTopicDir: string;
  workspaceTopicIndexPath: string;
  statusDir: string;
  activePath: string;
  pendingPath: string;
  deprecatedPath: string;
};

const STATUS_ORDER: MemoryStatus[] = ["active", "pending", "deprecated"];

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

export function resolveMemoryStatusPaths(
  args: Record<string, string | boolean>,
): MemoryStatusPaths {
  const memoryRoot = resolve(resolveMemoryRoot(args));
  const workspaceRoot = resolveWorkspaceRoot(args);
  const statusDir =
    typeof args["status-dir"] === "string"
      ? resolve(args["status-dir"])
      : resolve(memoryRoot, "status");
  const memoryPath =
    typeof args.file === "string" ? resolve(args.file) : resolve(memoryRoot, "MEMORY.yml");
  const workspaceMemoryPath =
    typeof args.output === "string" ? resolve(args.output) : resolve(workspaceRoot, "MEMORY.md");
  const workspaceTopicDir =
    typeof args["topic-dir"] === "string"
      ? resolve(args["topic-dir"])
      : resolve(workspaceRoot, "memory", "topics");

  return {
    memoryRoot,
    workspaceRoot,
    memoryPath,
    workspaceMemoryPath,
    workspaceTopicDir,
    workspaceTopicIndexPath: resolve(workspaceTopicDir, "README.md"),
    statusDir,
    activePath: resolve(statusDir, "active.yml"),
    pendingPath: resolve(statusDir, "pending.yml"),
    deprecatedPath: resolve(statusDir, "deprecated.yml"),
  };
}

function statusLockPath(paths: MemoryStatusPaths): string {
  return resolveMemoryLockPath(paths.memoryRoot, "status-store");
}

function bucketPath(paths: MemoryStatusPaths, status: MemoryStatus): string {
  if (status === "active") {
    return paths.activePath;
  }
  if (status === "pending") {
    return paths.pendingPath;
  }
  return paths.deprecatedPath;
}

function emptyBuckets(): StatusBuckets {
  return {
    active: [],
    pending: [],
    deprecated: [],
  };
}

function cloneBuckets(input: StatusBuckets): StatusBuckets {
  return {
    active: input.active.map((item) => ({ ...item, scope: { ...item.scope } })),
    pending: input.pending.map((item) => ({ ...item, scope: { ...item.scope } })),
    deprecated: input.deprecated.map((item) => ({ ...item, scope: { ...item.scope } })),
  };
}

export async function ensureStatusBuckets(paths: MemoryStatusPaths): Promise<void> {
  const hasAnyBucket =
    existsSync(paths.activePath) ||
    existsSync(paths.pendingPath) ||
    existsSync(paths.deprecatedPath);
  if (hasAnyBucket) {
    const existing = await loadStatusBuckets(paths);
    await saveStatusBuckets(paths, existing);
    return;
  }

  const buckets = emptyBuckets();
  const seed = await readMemoryItems(paths.memoryPath);
  for (const item of seed.items) {
    buckets[item.status].push(item);
  }
  await saveStatusBuckets(paths, buckets);
}

export async function loadStatusBuckets(paths: MemoryStatusPaths): Promise<StatusBuckets> {
  const buckets = emptyBuckets();
  for (const status of STATUS_ORDER) {
    const path = bucketPath(paths, status);
    if (!existsSync(path)) {
      continue;
    }
    const { items } = await readMemoryItems(path);
    for (const item of items) {
      item.status = status;
      buckets[status].push(item);
    }
  }
  return buckets;
}

export async function saveStatusBuckets(
  paths: MemoryStatusPaths,
  buckets: StatusBuckets,
): Promise<void> {
  await writeMemoryItems(bucketPath(paths, "active"), sortItems(buckets.active));
  await writeMemoryItems(bucketPath(paths, "pending"), sortItems(buckets.pending));
  await writeMemoryItems(bucketPath(paths, "deprecated"), sortItems(buckets.deprecated));
}

export function flattenBuckets(buckets: StatusBuckets): MemoryItem[] {
  const all = [...buckets.active, ...buckets.pending, ...buckets.deprecated];
  return sortItems(all);
}

export function listConflicts(items: MemoryItem[]): MemoryConflictPair[] {
  return listUnresolvedConflictPairs(items)
    .map((pair) => ({
      pair_id: conflictPairId(pair.left.id, pair.right.id),
      topic: pair.left.topic,
      key: pair.left.key,
      left: { ...pair.left, scope: { ...pair.left.scope } },
      right: { ...pair.right, scope: { ...pair.right.scope } },
    }))
    .toSorted((a, b) => a.pair_id.localeCompare(b.pair_id));
}

export const listActiveConflicts = listConflicts;

export async function rebuildUnifiedMemory(
  paths: MemoryStatusPaths,
  buckets: StatusBuckets,
): Promise<void> {
  await writeMemoryItems(paths.memoryPath, flattenBuckets(buckets));
}

export async function renderRuntimeActiveMemory(
  paths: MemoryStatusPaths,
  buckets: StatusBuckets,
): Promise<void> {
  const all = flattenBuckets(buckets);
  const body = buildMemoryMarkdown({
    sourcePath: paths.memoryPath,
    items: all,
    statuses: ["active"],
    runtimeNote: "Runtime file optimized for retrieval precision (active memory only).",
  });
  await writeTextFile(paths.workspaceMemoryPath, body);
  await renderRuntimeTopicShards(paths, all);
}

export async function renderRuntimeTopicShards(
  paths: MemoryStatusPaths,
  items: MemoryItem[],
): Promise<void> {
  const shards = buildActiveTopicShards(items);
  const targetFiles = new Set<string>();

  for (const shard of shards) {
    const filePath = resolve(paths.workspaceTopicDir, `topic-${shard.slug}.md`);
    targetFiles.add(filePath);
    const body = buildTopicShardMarkdown({
      sourcePath: paths.memoryPath,
      topic: shard.topic,
      items: shard.items,
    });
    await writeTextFile(filePath, body);
  }

  const indexBody = buildTopicShardIndexMarkdown({
    sourcePath: paths.memoryPath,
    shards,
  });
  await writeTextFile(paths.workspaceTopicIndexPath, indexBody);

  if (!existsSync(paths.workspaceTopicDir)) {
    return;
  }
  const entries = await readdir(paths.workspaceTopicDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.startsWith("topic-") || !entry.name.endsWith(".md")) {
      continue;
    }
    const filePath = resolve(paths.workspaceTopicDir, entry.name);
    if (targetFiles.has(filePath)) {
      continue;
    }
    await unlink(filePath).catch(() => {});
  }
}

export function countsByStatus(buckets: StatusBuckets): Record<MemoryStatus, number> {
  return {
    active: buckets.active.length,
    pending: buckets.pending.length,
    deprecated: buckets.deprecated.length,
  };
}

export function findItemStatus(
  buckets: StatusBuckets,
  id: string,
): { status: MemoryStatus; index: number; item: MemoryItem } | null {
  for (const status of STATUS_ORDER) {
    const index = buckets[status].findIndex((item) => item.id === id);
    if (index === -1) {
      continue;
    }
    const item = buckets[status][index];
    if (!item) {
      continue;
    }
    return { status, index, item };
  }
  return null;
}

export async function applyStatusChange(params: {
  paths: MemoryStatusPaths;
  id: string;
  to: MemoryStatus;
  today?: string;
}): Promise<{
  from: MemoryStatus;
  to: MemoryStatus;
  item: MemoryItem;
  counts: Record<MemoryStatus, number>;
}> {
  return withFileLock(
    {
      lockPath: statusLockPath(params.paths),
    },
    async () => {
      const today = params.today ?? formatDateNowUtc();
      await ensureStatusBuckets(params.paths);
      const current = await loadStatusBuckets(params.paths);
      const previous = cloneBuckets(current);
      const located = findItemStatus(current, params.id);
      if (!located) {
        throw new Error(`Item not found: ${params.id}`);
      }

      if (located.status !== params.to) {
        current[located.status].splice(located.index, 1);
        const moved: MemoryItem = {
          ...located.item,
          status: params.to,
          updated: today,
        };
        current[params.to].push(moved);
      }

      try {
        await saveStatusBuckets(params.paths, current);
        await rebuildUnifiedMemory(params.paths, current);
        const audit = await auditMemory(params.paths.memoryPath, today);
        const exit = auditExitCode(audit.issues);
        if (exit === 2) {
          throw new Error(
            `Audit failed after status change: ${audit.issues.map((i) => i.message).join("; ")}`,
          );
        }
        await renderRuntimeActiveMemory(params.paths, current);
      } catch (error) {
        await saveStatusBuckets(params.paths, previous);
        await rebuildUnifiedMemory(params.paths, previous);
        await renderRuntimeActiveMemory(params.paths, previous);
        throw error;
      }

      const updated = findItemStatus(current, params.id);
      if (!updated) {
        throw new Error(`Item missing after update: ${params.id}`);
      }

      return {
        from: located.status,
        to: params.to,
        item: updated.item,
        counts: countsByStatus(current),
      };
    },
  );
}

export async function applyConflictMerge(params: {
  paths: MemoryStatusPaths;
  leftId: string;
  rightId: string;
  mergedValue: MemoryValue;
  keepId?: string;
  today?: string;
}): Promise<{
  mergedId: string;
  deprecatedId: string;
  counts: Record<MemoryStatus, number>;
  pairId: string;
}> {
  return withFileLock(
    {
      lockPath: statusLockPath(params.paths),
    },
    async () => {
      const today = params.today ?? formatDateNowUtc();
      await ensureStatusBuckets(params.paths);
      const current = await loadStatusBuckets(params.paths);
      const previous = cloneBuckets(current);
      const leftLocated = findItemStatus(current, params.leftId);
      const rightLocated = findItemStatus(current, params.rightId);
      if (!leftLocated || !rightLocated) {
        throw new Error(`Conflict items not found: ${params.leftId}, ${params.rightId}`);
      }
      if (params.leftId === params.rightId) {
        throw new Error("Conflict merge requires two distinct item IDs");
      }
      if (!isUnresolvedConflictPair(leftLocated.item, rightLocated.item)) {
        throw new Error(
          `Items ${params.leftId} and ${params.rightId} are not an unresolved conflict pair`,
        );
      }
      const keepId = params.keepId ?? params.leftId;
      if (keepId !== params.leftId && keepId !== params.rightId) {
        throw new Error(`Invalid keepId '${keepId}', must match one of the conflict IDs`);
      }
      const keep = keepId === params.leftId ? leftLocated : rightLocated;
      const other = keepId === params.leftId ? rightLocated : leftLocated;
      const pairId = conflictPairId(params.leftId, params.rightId);

      const removeItemById = (id: string): MemoryItem => {
        const located = findItemStatus(current, id);
        if (!located) {
          throw new Error(`Item not found during merge: ${id}`);
        }
        const [removed] = current[located.status].splice(located.index, 1);
        if (!removed) {
          throw new Error(`Unable to remove item during merge: ${id}`);
        }
        return removed;
      };

      const keepOriginal = removeItemById(keep.item.id);
      const otherOriginal = removeItemById(other.item.id);
      const merged: MemoryItem = {
        ...keepOriginal,
        status: "active",
        value: params.mergedValue,
        updated: today,
        next: `Merged conflict ${pairId}; resolved by keeping ${keep.item.id}.`,
      };
      const deprecatedOther: MemoryItem = {
        ...otherOriginal,
        status: "deprecated",
        updated: today,
        next: `Deprecated after conflict merge ${pairId} into ${merged.id}.`,
      };
      current.active.push(merged);
      current.deprecated.push(deprecatedOther);

      try {
        await saveStatusBuckets(params.paths, current);
        await rebuildUnifiedMemory(params.paths, current);
        const audit = await auditMemory(params.paths.memoryPath, today);
        const exit = auditExitCode(audit.issues);
        if (exit === 2) {
          throw new Error(
            `Audit failed after conflict merge: ${audit.issues.map((i) => i.message).join("; ")}`,
          );
        }
        await renderRuntimeActiveMemory(params.paths, current);
      } catch (error) {
        await saveStatusBuckets(params.paths, previous);
        await rebuildUnifiedMemory(params.paths, previous);
        await renderRuntimeActiveMemory(params.paths, previous);
        throw error;
      }

      return {
        mergedId: merged.id,
        deprecatedId: deprecatedOther.id,
        counts: countsByStatus(current),
        pairId,
      };
    },
  );
}

export async function initializeStatusStore(args: Record<string, string | boolean>): Promise<{
  paths: MemoryStatusPaths;
  counts: Record<MemoryStatus, number>;
}> {
  const paths = resolveMemoryStatusPaths(args);
  await withFileLock(
    {
      lockPath: statusLockPath(paths),
    },
    async () => {
      await ensureStatusBuckets(paths);
      const buckets = await loadStatusBuckets(paths);
      await saveStatusBuckets(paths, buckets);
      await rebuildUnifiedMemory(paths, buckets);
      await renderRuntimeActiveMemory(paths, buckets);
    },
  );
  const buckets = await loadStatusBuckets(paths);
  return {
    paths,
    counts: countsByStatus(buckets),
  };
}
