import type { MemoryItem, MemoryScope, MemoryStatus } from "./memory-governance-lib";

export type ActiveConflictPair = {
  left: MemoryItem;
  right: MemoryItem;
};

type ConflictPairOptions = {
  allowedStatuses?: MemoryStatus[];
};

function parseIsoDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const ts = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ts) ? ts : null;
}

export function datesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const aStartTs = parseIsoDay(aStart);
  const aEndTs = parseIsoDay(aEnd);
  const bStartTs = parseIsoDay(bStart);
  const bEndTs = parseIsoDay(bEnd);
  if (aStartTs === null || aEndTs === null || bStartTs === null || bEndTs === null) {
    return false;
  }
  return aStartTs <= bEndTs && bStartTs <= aEndTs;
}

export function scopesIntersect(a: MemoryScope, b: MemoryScope): boolean {
  const envIntersects = a.env === "all" || b.env === "all" || a.env === b.env;
  if (!envIntersects) {
    return false;
  }
  const serviceIntersects = !a.service || !b.service || a.service === b.service;
  if (!serviceIntersects) {
    return false;
  }
  const regionIntersects = !a.region || !b.region || a.region === b.region;
  return regionIntersects;
}

export function isActiveConflictPair(left: MemoryItem, right: MemoryItem): boolean {
  return isConflictPair(left, right, { allowedStatuses: ["active"] });
}

export function isUnresolvedConflictPair(left: MemoryItem, right: MemoryItem): boolean {
  return isConflictPair(left, right, { allowedStatuses: ["active", "pending"] });
}

export function isConflictPair(
  left: MemoryItem,
  right: MemoryItem,
  options: ConflictPairOptions = {},
): boolean {
  const allowedStatuses = options.allowedStatuses ?? ["active"];
  if (!allowedStatuses.includes(left.status) || !allowedStatuses.includes(right.status)) {
    return false;
  }
  if (left.topic !== right.topic || left.key !== right.key) {
    return false;
  }
  if (left.value === right.value) {
    return false;
  }
  if (!scopesIntersect(left.scope, right.scope)) {
    return false;
  }
  return datesOverlap(left.effective_from, left.expires, right.effective_from, right.expires);
}

export function conflictPairId(aId: string, bId: string): string {
  const [leftId, rightId] = [aId, bId].toSorted((x, y) => x.localeCompare(y));
  return `${leftId}__${rightId}`;
}

export function listActiveConflictPairs(items: MemoryItem[]): ActiveConflictPair[] {
  return listConflictPairs(items, { allowedStatuses: ["active"] });
}

export function listUnresolvedConflictPairs(items: MemoryItem[]): ActiveConflictPair[] {
  return listConflictPairs(items, { allowedStatuses: ["active", "pending"] });
}

export function listConflictPairs(
  items: MemoryItem[],
  options: ConflictPairOptions = {},
): ActiveConflictPair[] {
  const allowedStatuses = options.allowedStatuses ?? ["active"];
  const scoped = items.filter((item) => allowedStatuses.includes(item.status));
  const conflicts: ActiveConflictPair[] = [];
  for (let i = 0; i < scoped.length; i++) {
    for (let j = i + 1; j < scoped.length; j++) {
      const left = scoped[i];
      const right = scoped[j];
      if (!left || !right || !isConflictPair(left, right, { allowedStatuses })) {
        continue;
      }
      conflicts.push({ left, right });
    }
  }
  return conflicts;
}
