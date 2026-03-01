import { MemoryItem, MemoryStatus } from "./memory-governance-lib";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeScalar(value: string | number | boolean): string {
  return normalizeWhitespace(String(value));
}

function scopeLabel(item: MemoryItem): string {
  const parts = [`env=${item.scope.env}`];
  if (item.scope.service) {
    parts.push(`service=${item.scope.service}`);
  }
  if (item.scope.region) {
    parts.push(`region=${item.scope.region}`);
  }
  return parts.join(", ");
}

function tokenize(value: string): string[] {
  return (
    value
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.map((token) => token.trim())
      .filter((token) => token.length >= 2) ?? []
  );
}

function keywordsFor(item: MemoryItem): string {
  const pool = [
    ...tokenize(item.topic),
    ...tokenize(item.key.replaceAll("_", " ")),
    ...tokenize(normalizeScalar(item.value)),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of pool) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
    if (out.length >= 10) {
      break;
    }
  }
  return out.join(", ");
}

function canonicalLine(item: MemoryItem): string {
  return normalizeScalar(item.value);
}

function statusTitle(status: MemoryStatus): string {
  if (status === "active") {
    return "Active";
  }
  if (status === "pending") {
    return "Pending";
  }
  return "Deprecated";
}

function blockFor(item: MemoryItem): string[] {
  const topicKey = `${item.topic}.${item.key}`;
  const lines: string[] = [
    `### ${item.id} | ${item.status} | ${topicKey}`,
    "",
    `- Canonical: ${canonicalLine(item)}`,
    `- Scope: ${scopeLabel(item)}`,
    `- Source: ${item.source}`,
    `- Valid: ${item.effective_from} -> ${item.expires}`,
    `- Keywords: ${keywordsFor(item)}`,
  ];
  if (item.confidence) {
    lines.push(`- Confidence: ${item.confidence}`);
  }
  if (item.next) {
    lines.push(`- Next: ${normalizeWhitespace(item.next)}`);
  }
  lines.push("");
  return lines;
}

function normalizeTopicSlug(topic: string): string {
  const normalized = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || "misc";
}

function quickIndex(items: MemoryItem[]): string[] {
  const lines: string[] = ["## Quick Index", ""];
  if (items.length === 0) {
    lines.push("_None_", "");
    return lines;
  }
  const byTopicKey = new Map<string, string[]>();
  for (const item of items) {
    const topicKey = `${item.topic}.${item.key}`;
    const ids = byTopicKey.get(topicKey) ?? [];
    ids.push(item.id);
    byTopicKey.set(topicKey, ids);
  }
  for (const [topicKey, ids] of [...byTopicKey.entries()].toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push(`- ${topicKey}: ${ids.join(", ")}`);
  }
  lines.push("");
  return lines;
}

function statusSection(status: MemoryStatus, items: MemoryItem[]): string[] {
  const scoped = items
    .filter((item) => item.status === status)
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const lines: string[] = [`## ${statusTitle(status)} (${scoped.length})`, ""];
  if (scoped.length === 0) {
    lines.push("_None_", "");
    return lines;
  }
  for (const item of scoped) {
    lines.push(...blockFor(item));
  }
  return lines;
}

export function buildMemoryMarkdown(params: {
  sourcePath: string;
  items: MemoryItem[];
  statuses: MemoryStatus[];
  runtimeNote: string;
}): string {
  const filtered = params.items.filter((item) => params.statuses.includes(item.status));
  const lines: string[] = [
    "# MEMORY (Generated)",
    "",
    `- Source: ${params.sourcePath}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Render mode: ${params.statuses.join(", ")}`,
    `- ${params.runtimeNote}`,
    "- Search tip: match by topic.key, keywords, and canonical line.",
    "",
  ];
  lines.push(...quickIndex(filtered));
  for (const status of params.statuses) {
    lines.push(...statusSection(status, filtered));
  }
  return `${lines.join("\n")}\n`;
}

export type MemoryTopicShard = {
  topic: string;
  slug: string;
  items: MemoryItem[];
};

export function buildActiveTopicShards(items: MemoryItem[]): MemoryTopicShard[] {
  const active = items.filter((item) => item.status === "active");
  const byTopic = new Map<string, MemoryItem[]>();
  for (const item of active) {
    const current = byTopic.get(item.topic) ?? [];
    current.push(item);
    byTopic.set(item.topic, current);
  }

  const usedSlugs = new Set<string>();
  const shards: MemoryTopicShard[] = [];
  for (const [topic, topicItems] of [...byTopic.entries()].toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const base = normalizeTopicSlug(topic);
    let slug = base;
    let sequence = 2;
    while (usedSlugs.has(slug)) {
      slug = `${base}-${sequence}`;
      sequence += 1;
    }
    usedSlugs.add(slug);
    shards.push({
      topic,
      slug,
      items: topicItems.toSorted((a, b) => a.id.localeCompare(b.id)),
    });
  }
  return shards;
}

export function buildTopicShardMarkdown(params: {
  sourcePath: string;
  topic: string;
  items: MemoryItem[];
}): string {
  const lines: string[] = [
    `# MEMORY Topic: ${params.topic}`,
    "",
    `- Source: ${params.sourcePath}`,
    `- Generated: ${new Date().toISOString()}`,
    "- Status: active",
    "- Scope: topic shard for retrieval precision.",
    "",
    "## Quick Index",
    "",
  ];

  if (params.items.length === 0) {
    lines.push("_None_", "");
    return `${lines.join("\n")}\n`;
  }

  for (const item of params.items) {
    lines.push(`- ${item.key}: ${item.id}`);
  }
  lines.push("", "## Active", "");

  for (const item of params.items) {
    lines.push(...blockFor(item));
  }

  return `${lines.join("\n")}\n`;
}

export function buildTopicShardIndexMarkdown(params: {
  sourcePath: string;
  shards: MemoryTopicShard[];
}): string {
  const lines: string[] = [
    "# Memory Topic Shards (Generated)",
    "",
    `- Source: ${params.sourcePath}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Topics: ${params.shards.length}`,
    "",
  ];
  if (params.shards.length === 0) {
    lines.push("_None_", "");
    return `${lines.join("\n")}\n`;
  }
  for (const shard of params.shards) {
    lines.push(`- ${shard.topic}: topic-${shard.slug}.md (${shard.items.length})`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
