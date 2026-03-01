#!/usr/bin/env -S node --import tsx

import { resolve } from "node:path";
import {
  asCliArgMap,
  auditMemory,
  formatDateNowUtc,
  MemoryItem,
  resolveMemoryRoot,
  writeTextFile,
} from "./memory-governance-lib";

type DecisionAction = "activate" | "keep-pending" | "deprecate" | "keep-active" | "keep-deprecated";

type Decision = {
  action: DecisionAction;
  reason: string;
  priority: number;
};

const MUST_ACTIVATE_KEYS = new Set([
  "display_name_preference",
  "persona_mode",
  "core_protocol",
  "workflow_rule",
  "approval_rule",
  "learning_rule",
  "routing_policy",
  "verification_protocol",
  "scheduler_mode",
  "vidiq_realtime_policy",
  "compliance_rules",
]);

function usageAndExit(code: number): never {
  console.error(
    [
      "memory-dashboard.ts",
      "",
      "Usage:",
      "  node --import tsx scripts/memory-dashboard.ts [--root /path/to/memory] [--file MEMORY.yml] [--output /path/to/report.md] [--today YYYY-MM-DD] [--max-pending 50]",
    ].join("\n"),
  );
  process.exit(code);
}

function truncateValue(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 3)}...`;
}

function escapeMdCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function daysUntil(today: string, date: string): number | null {
  const todayTs = Date.parse(`${today}T00:00:00Z`);
  const dateTs = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(todayTs) || !Number.isFinite(dateTs)) {
    return null;
  }
  return Math.floor((dateTs - todayTs) / (24 * 60 * 60 * 1000));
}

function decide(item: MemoryItem, today: string): Decision {
  const expiresIn = daysUntil(today, item.expires);

  if (item.status === "active") {
    if (expiresIn !== null && expiresIn < 0) {
      return {
        action: "deprecate",
        reason: "Active item already expired",
        priority: 100,
      };
    }
    return {
      action: "keep-active",
      reason: "Already active and currently valid",
      priority: 0,
    };
  }

  if (item.status === "deprecated") {
    return {
      action: "keep-deprecated",
      reason: "Already deprecated",
      priority: 0,
    };
  }

  if (item.topic === "project-progress" || item.topic === "legacy-memory-md") {
    return {
      action: "deprecate",
      reason: "Historical/contextual note, not a durable rule",
      priority: 95,
    };
  }

  if (MUST_ACTIVATE_KEYS.has(item.key)) {
    return {
      action: "activate",
      reason: "Core policy/preference for runtime decisions",
      priority: 90,
    };
  }

  if (item.topic === "youtube-intel") {
    return {
      action: "keep-pending",
      reason: "Market intel is time-sensitive; keep pending and review regularly",
      priority: 60,
    };
  }

  if (expiresIn !== null && expiresIn <= 7) {
    return {
      action: "deprecate",
      reason: "Near expiry without strong policy signal",
      priority: 70,
    };
  }

  if (item.confidence === "high") {
    return {
      action: "activate",
      reason: "High confidence pending item",
      priority: 75,
    };
  }

  return {
    action: "keep-pending",
    reason: "Needs manual review",
    priority: 50,
  };
}

function statusCounts(items: MemoryItem[]): Record<MemoryItem["status"], number> {
  const counts: Record<MemoryItem["status"], number> = {
    active: 0,
    pending: 0,
    deprecated: 0,
  };
  for (const item of items) {
    counts[item.status]++;
  }
  return counts;
}

function recommendationSummary(
  pending: MemoryItem[],
  today: string,
): Record<DecisionAction, number> {
  const summary: Record<DecisionAction, number> = {
    activate: 0,
    "keep-pending": 0,
    deprecate: 0,
    "keep-active": 0,
    "keep-deprecated": 0,
  };
  for (const item of pending) {
    const decision = decide(item, today);
    summary[decision.action]++;
  }
  return summary;
}

function renderPendingTable(items: MemoryItem[], today: string, maxRows: number): string[] {
  const lines: string[] = [
    "| ID | Topic.Key | Confidence | Expires in (days) | Recommendation | Reason | Value |",
    "|---|---|---|---:|---|---|---|",
  ];

  const sorted = [...items].toSorted((left, right) => {
    const lDecision = decide(left, today);
    const rDecision = decide(right, today);
    if (lDecision.priority !== rDecision.priority) {
      return rDecision.priority - lDecision.priority;
    }
    return left.id.localeCompare(right.id);
  });

  for (const item of sorted.slice(0, maxRows)) {
    const decision = decide(item, today);
    const expiresIn = daysUntil(today, item.expires);
    lines.push(
      `| ${escapeMdCell(item.id)} | ${escapeMdCell(`${item.topic}.${item.key}`)} | ${escapeMdCell(item.confidence ?? "n/a")} | ${expiresIn === null ? "n/a" : String(expiresIn)} | ${escapeMdCell(decision.action)} | ${escapeMdCell(decision.reason)} | ${escapeMdCell(truncateValue(String(item.value)))} |`,
    );
  }

  if (sorted.length === 0) {
    lines.push("| _none_ | - | - | - | - | - | - |");
  }

  if (sorted.length > maxRows) {
    lines.push(
      "",
      `_Showing ${maxRows}/${sorted.length} pending items. Increase with --max-pending._`,
    );
  }

  lines.push("");
  return lines;
}

function renderUpcomingExpiry(items: MemoryItem[], today: string): string[] {
  const rows = items
    .map((item) => ({
      item,
      expiresIn: daysUntil(today, item.expires),
    }))
    .filter((entry) => entry.expiresIn !== null && entry.expiresIn <= 30)
    .toSorted((left, right) => (left.expiresIn as number) - (right.expiresIn as number));

  const lines: string[] = ["## Upcoming Expiry (<= 30 days)", ""];
  if (rows.length === 0) {
    lines.push("_None_", "");
    return lines;
  }

  lines.push("| ID | Status | Topic.Key | Expires in (days) | Expires |");
  lines.push("|---|---|---|---:|---|");
  for (const row of rows) {
    lines.push(
      `| ${escapeMdCell(row.item.id)} | ${escapeMdCell(row.item.status)} | ${escapeMdCell(`${row.item.topic}.${row.item.key}`)} | ${row.expiresIn} | ${escapeMdCell(row.item.expires)} |`,
    );
  }
  lines.push("");
  return lines;
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  if (args.help === true) {
    usageAndExit(0);
  }

  const today = typeof args.today === "string" ? args.today : formatDateNowUtc();
  const maxPendingRaw = typeof args["max-pending"] === "string" ? args["max-pending"] : "50";
  const maxPending = Math.max(1, Number.parseInt(maxPendingRaw, 10) || 50);

  const root = resolve(resolveMemoryRoot(args));
  const filePath = typeof args.file === "string" ? resolve(args.file) : resolve(root, "MEMORY.yml");
  const outputPath =
    typeof args.output === "string"
      ? resolve(args.output)
      : resolve(root, "reports", `dashboard-${today}.md`);

  const summary = await auditMemory(filePath, today);
  const counts = statusCounts(summary.items);
  const pendingItems = summary.items.filter((item) => item.status === "pending");
  const recommendation = recommendationSummary(pendingItems, today);

  const lines: string[] = [
    "# Memory Decision Dashboard",
    "",
    `- Date: ${today}`,
    `- Source: ${filePath}`,
    `- Generated: ${new Date().toISOString()}`,
    "",
    "## Status Snapshot",
    "",
    "| Status | Count |",
    "|---|---:|",
    `| active | ${counts.active} |`,
    `| pending | ${counts.pending} |`,
    `| deprecated | ${counts.deprecated} |`,
    "",
    "## Pending Recommendations",
    "",
    "| Action | Count |",
    "|---|---:|",
    `| activate | ${recommendation.activate} |`,
    `| keep-pending | ${recommendation["keep-pending"]} |`,
    `| deprecate | ${recommendation.deprecate} |`,
    "",
    "## Decision Queue (Pending)",
    "",
    ...renderPendingTable(pendingItems, today, maxPending),
    ...renderUpcomingExpiry(summary.items, today),
    "## Audit",
    "",
    `- Issues: ${summary.issues.length}`,
    "",
    "## Apply Decisions",
    "",
    "1. Update statuses in MEMORY.yml (active/pending/deprecated).",
    "2. Re-run: `pnpm memory:audit`.",
    "3. Publish runtime memory: `pnpm memory:render --replace`.",
    "",
  ];

  await writeTextFile(outputPath, `${lines.join("\n")}\n`);

  console.log("memory:dashboard done");
  console.log(`- source: ${filePath}`);
  console.log(`- output: ${outputPath}`);
  console.log(
    `- counts: active=${counts.active} pending=${counts.pending} deprecated=${counts.deprecated}`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory:dashboard failed: ${message}`);
  process.exitCode = 2;
});
