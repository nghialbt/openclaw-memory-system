#!/usr/bin/env -S node --import tsx

import { resolve } from "node:path";
import {
  asCliArgMap,
  auditExitCode,
  auditMemory,
  formatDateNowUtc,
  resolveMemoryRoot,
  reportBody,
  reportHeader,
  writeTextFile,
} from "./memory-governance-lib";

function defaultReportPath(root: string, today: string): string {
  return resolve(root, "reports", `${today}.md`);
}

function printSummary(filePath: string, reportPath: string, exitCode: number): void {
  const label = exitCode === 0 ? "clean" : exitCode === 1 ? "stale" : "error";
  console.log(`memory:audit ${label}`);
  console.log(`- file: ${filePath}`);
  console.log(`- report: ${reportPath}`);
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  const today = typeof args.today === "string" ? args.today : formatDateNowUtc();
  const root = resolve(resolveMemoryRoot(args));
  const filePath = typeof args.file === "string" ? resolve(args.file) : resolve(root, "MEMORY.yml");
  const reportPath =
    typeof args.report === "string" ? resolve(args.report) : defaultReportPath(root, today);

  const summary = await auditMemory(filePath, today);
  const content = `${reportHeader(summary)}${reportBody(summary.issues)}`;
  await writeTextFile(reportPath, content);

  const exitCode = auditExitCode(summary.issues);
  printSummary(filePath, reportPath, exitCode);

  if (exitCode !== 0) {
    const lines = content
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .slice(0, 20);
    if (lines.length > 0) {
      console.log(lines.join("\n"));
    }
  }

  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory:audit failed: ${message}`);
  process.exitCode = 2;
});
