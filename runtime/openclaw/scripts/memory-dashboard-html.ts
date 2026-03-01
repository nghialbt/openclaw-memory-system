#!/usr/bin/env -S node --import tsx

import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import MarkdownIt from "markdown-it";
import {
  asCliArgMap,
  formatDateNowUtc,
  resolveMemoryRoot,
  writeTextFile,
} from "./memory-governance-lib";

function usageAndExit(code: number): never {
  console.error(
    [
      "memory-dashboard-html.ts",
      "",
      "Usage:",
      "  node --import tsx scripts/memory-dashboard-html.ts [--root /path/to/memory] [--input /path/to/dashboard.md] [--output /path/to/dashboard.html]",
    ].join("\n"),
  );
  process.exit(code);
}

async function resolveInputPath(
  args: Record<string, string | boolean>,
  reportsDir: string,
): Promise<string> {
  if (typeof args.input === "string") {
    return resolve(args.input);
  }

  const entries = await readdir(reportsDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^dashboard-\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
    .map((entry) => resolve(reportsDir, entry.name))
    .toSorted((left, right) => left.localeCompare(right));

  if (candidates.length === 0) {
    const todayPath = resolve(reportsDir, `dashboard-${formatDateNowUtc()}.md`);
    return todayPath;
  }

  return candidates[candidates.length - 1] as string;
}

function numberFromMarkdown(md: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\|\\s*${escaped}\\s*\\|\\s*(\\d+)\\s*\\|`).exec(md);
  return match?.[1] ?? "0";
}

function buildHtml(title: string, markdownBody: string): string {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  const rendered = md.render(markdownBody);
  const active = numberFromMarkdown(markdownBody, "active");
  const pending = numberFromMarkdown(markdownBody, "pending");
  const deprecated = numberFromMarkdown(markdownBody, "deprecated");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f1115;
      --panel: #161a22;
      --text: #e6e8ee;
      --muted: #9aa3b2;
      --line: #2b3140;
      --ok: #26a269;
      --warn: #f5c451;
      --off: #e85d75;
      --link: #7cb8ff;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f8fb;
        --panel: #ffffff;
        --text: #1d2433;
        --muted: #5d6a80;
        --line: #d6deea;
        --link: #0f62fe;
      }
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }
    .wrap {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin: 0 0 20px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px 14px;
    }
    .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .value {
      margin-top: 4px;
      font-size: 24px;
      font-weight: 700;
    }
    .active .value { color: var(--ok); }
    .pending .value { color: var(--warn); }
    .deprecated .value { color: var(--off); }
    .content {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 18px;
      overflow: auto;
    }
    a { color: var(--link); }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 14px 0;
      font-size: 13px;
    }
    th, td {
      border: 1px solid var(--line);
      padding: 8px;
      vertical-align: top;
      text-align: left;
    }
    th { background: rgba(127,127,127,.08); }
    code {
      background: rgba(127,127,127,.12);
      border-radius: 4px;
      padding: 0 4px;
    }
    @media (max-width: 900px) {
      .cards { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="cards">
      <div class="card active"><div class="label">Active</div><div class="value">${active}</div></div>
      <div class="card pending"><div class="label">Pending</div><div class="value">${pending}</div></div>
      <div class="card deprecated"><div class="label">Deprecated</div><div class="value">${deprecated}</div></div>
    </div>
    <div class="content">
      ${rendered}
    </div>
  </div>
</body>
</html>
`;
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  if (args.help === true) {
    usageAndExit(0);
  }

  const root = resolve(resolveMemoryRoot(args));
  const reportsDir = resolve(root, "reports");
  const inputPath = await resolveInputPath(args, reportsDir);
  const outputPath =
    typeof args.output === "string"
      ? resolve(args.output)
      : resolve(reportsDir, `${basename(inputPath, ".md")}.html`);

  const markdown = await readFile(inputPath, "utf8");
  const html = buildHtml("Memory Decision Dashboard", markdown);
  await writeTextFile(outputPath, html);

  console.log("memory:dashboard:html done");
  console.log(`- input: ${inputPath}`);
  console.log(`- output: ${outputPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory:dashboard:html failed: ${message}`);
  process.exitCode = 2;
});
