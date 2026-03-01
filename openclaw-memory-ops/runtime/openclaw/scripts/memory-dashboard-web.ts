#!/usr/bin/env -S node --import tsx

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import express from "express";
import { asCliArgMap, formatDateNowUtc, MemoryStatus } from "./memory-governance-lib";
import {
  applyConflictMerge,
  applyStatusChange,
  countsByStatus,
  ensureStatusBuckets,
  flattenBuckets,
  listConflicts,
  loadStatusBuckets,
  resolveMemoryStatusPaths,
} from "./memory-status-lib";

type ApiItem = {
  id: string;
  topic: string;
  key: string;
  value: string | number | boolean;
  status: MemoryStatus;
  source: string;
  effective_from: string;
  expires: string;
  updated?: string;
  confidence?: "high" | "medium" | "low";
  next?: string;
};

type ApiConflict = {
  pair_id: string;
  topic: string;
  key: string;
  left: ApiItem;
  right: ApiItem;
};

const execFileAsync = promisify(execFile);

function usageAndExit(code: number): never {
  console.error(
    [
      "memory-dashboard-web.ts",
      "",
      "Usage:",
      "  node --import tsx scripts/memory-dashboard-web.ts [--root /path/to/memory] [--workspace-root /path/to/workspace] [--status-dir /path/to/status] [--port 3903] [--host 127.0.0.1]",
    ].join("\n"),
  );
  process.exit(code);
}

function parseStatus(value: unknown): MemoryStatus | null {
  if (value === "active" || value === "pending" || value === "deprecated") {
    return value;
  }
  return null;
}

function parseMergeValue(value: unknown): string | number | boolean | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
}

function toApiItem(item: ApiItem): ApiItem {
  return {
    ...item,
  };
}

function renderAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Memory Status Dashboard</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #09090b;
      --panel: #18181b;
      --text: #fafafa;
      --muted: #a1a1aa;
      --line: rgba(255, 255, 255, 0.15);
      --accent: #ff4d4d;
      --accent-hover: #ff3333;
      --ok: #26a269;
      --warn: #f5c451;
      --off: #e85d75;
      --shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
      --radius: 12px;
      --radius-sm: 8px;
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #ffffff;
      --panel: #f4f4f5;
      --text: #18181b;
      --muted: #71717a;
      --line: rgba(0, 0, 0, 0.1);
      --accent: #e63946;
      --accent-hover: #d62828;
      --shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #09090b;
      --panel: #18181b;
      --text: #fafafa;
      --muted: #a1a1aa;
      --line: rgba(255, 255, 255, 0.15);
      --accent: #ff4d4d;
      --accent-hover: #ff3333;
      --shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    @media (prefers-color-scheme: light) {
      :root:not([data-theme="dark"]):not([data-theme="light"]) {
        --bg: #ffffff;
        --panel: #f4f4f5;
        --text: #18181b;
        --muted: #71717a;
        --line: rgba(0, 0, 0, 0.1);
        --accent: #e63946;
        --accent-hover: #d62828;
        --shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; letter-spacing: -0.01em; }
    .wrap { width: 100%; margin: 0 auto; padding: 32px 24px; }
    .head { display: flex; gap: 16px; align-items: center; justify-content: space-between; margin-bottom: 24px; }
    .title { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
    .meta { color: var(--muted); font-size: 13px; margin-top: 4px; }
    .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 20px; box-shadow: var(--shadow); transition: transform 0.2s ease, box-shadow 0.2s ease; }
    .card:hover { transform: translateY(-2px); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5); }
    @media (prefers-color-scheme: light) {
      .card:hover { box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08); }
    }
    .card .k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 4px; }
    .card .v { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; }
    .active { color: var(--ok); } .pending { color: var(--warn); } .deprecated { color: var(--off); }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    
    /* Buttons */
    .btn { background: rgba(150, 150, 150, 0.1); border: 1px solid transparent; color: var(--text); border-radius: var(--radius-sm); padding: 8px 14px; cursor: pointer; font-weight: 500; font-size: 13px; transition: all 0.2s ease; }
    .btn:hover { background: rgba(150, 150, 150, 0.2); }
    .btn.on { background: var(--accent); color: white; box-shadow: 0 0 12px rgba(255, 77, 77, 0.3); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: white; font-weight: 600; }
    .btn.primary:hover { background: var(--accent-hover); box-shadow: 0 0 16px rgba(255, 77, 77, 0.4); }
    
    .panel { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
    .tableBox, .detailBox { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; overflow: auto; box-shadow: var(--shadow); }
    
    /* Table */
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px 8px; text-align: left; vertical-align: top; font-size: 13px; }
    tr:last-child td { border-bottom: none; }
    th { color: var(--muted); font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; padding-bottom: 12px; }
    th.sortable { cursor: pointer; user-select: none; transition: color 0.15s; }
    th.sortable:hover { color: var(--text); }
    tr { transition: background-color 0.15s; }
    tr:hover { background-color: rgba(150, 150, 150, 0.05); }
    tr.sel { background-color: rgba(255, 77, 77, 0.08); outline: 1px solid var(--accent); border-radius: 4px; }
    
    /* Forms */
    input, select { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; font-size: 13px; width: 100%; transition: border-color 0.2s; }
    input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(255, 77, 77, 0.2); }
    
    /* Theme Toggle */
    .themeToggle { display: flex; align-items: center; background: rgba(150, 150, 150, 0.08); border-radius: 24px; padding: 4px; gap: 4px; border: 1px solid var(--line); }
    .themeBtn { background: transparent; border: none; color: var(--muted); border-radius: 20px; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); padding: 0; }
    .themeBtn svg { width: 18px; height: 18px; stroke-width: 2; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); stroke: currentColor; fill: none; }
    .themeBtn:hover { color: var(--text); background: rgba(150, 150, 150, 0.1); }
    .themeBtn.active { background: var(--accent); color: white; box-shadow: 0 4px 12px rgba(255, 77, 77, 0.3); }
    .themeBtn.active svg { transform: scale(1.15); stroke-width: 2.5; }
    
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .detailContent { margin-top: 12px; }
    .diffMeta { color: var(--muted); font-size: 13px; margin-bottom: 12px; }
    .diffGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .diffPane { border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; background: var(--bg); }
    .diffHeader { background: color-mix(in oklab, var(--panel), var(--line) 20%); border-bottom: 1px solid var(--line); padding: 8px 12px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; }
    .diffHeader.left { color: var(--accent); }
    .diffHeader.right { color: var(--warn); }
    .diffBody { max-height: 62vh; overflow: auto; }
    .diffLine { display: grid; grid-template-columns: 46px 1fr; border-bottom: 1px solid color-mix(in oklab, var(--line), transparent 60%); }
    .diffLine:last-child { border-bottom: 0; }
    .lineNo { color: var(--muted); border-right: 1px solid color-mix(in oklab, var(--line), transparent 60%); padding: 6px 8px; text-align: right; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; user-select: none; }
    .lineText { padding: 6px 12px; white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .diffLine.changed { background: color-mix(in oklab, var(--off), transparent 94%); }
    .diffMarkL { background: color-mix(in oklab, var(--off), transparent 75%); border-radius: 3px; }
    .diffMarkR { background: color-mix(in oklab, var(--ok), transparent 75%); border-radius: 3px; }
    .diffEmpty { color: var(--muted); font-style: italic; }
    .rowActions { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; min-width: 170px; }
    .rowActions.merge { grid-template-columns: repeat(3, auto); min-width: 280px; }
    .muted { color: var(--muted); }
    .toast { margin-top: 12px; font-size: 13px; min-height: 20px; font-weight: 500; }
    
    /* Modal */
    .modalBack { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px); display: none; align-items: center; justify-content: center; z-index: 999; padding: 24px; opacity: 0; transition: opacity 0.2s ease; }
    .modalBack.open { display: flex; opacity: 1; }
    .modalCard { width: min(1000px, 96vw); max-height: 90vh; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 24px 80px rgba(0,0,0,0.5); padding: 24px; transform: translateY(10px) scale(0.98); transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
    .modalBack.open .modalCard { transform: translateY(0) scale(1); }
    .modalTitle { font-size: 18px; font-weight: 700; margin-bottom: 6px; letter-spacing: -0.01em; }
    .modalMeta { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
    .modalInput { width: 100%; min-height: 400px; resize: vertical; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 16px; transition: border-color 0.2s; }
    .modalInput:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(255, 77, 77, 0.15); }
    .modalActions { margin-top: 16px; display: flex; gap: 12px; justify-content: flex-end; }
    .btn.ghost { background: transparent; border: 1px solid var(--line); }
    .btn.ghost:hover { background: rgba(150, 150, 150, 0.1); color: var(--text); }
    @media (max-width: 1000px) { .panel { grid-template-columns: 1fr; } .cards { grid-template-columns: 1fr; } .diffGrid { grid-template-columns: 1fr; } .diffBody { max-height: 40vh; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <div>
        <div class="title">Memory Status Dashboard</div>
        <div class="meta" id="meta">Loading...</div>
      </div>
      <div style="display:flex;gap:12px;align-items:center;">
        <button class="btn" id="scanAllBtn">Scan All</button>
        <button class="btn primary" id="refreshBtn">Refresh</button>
        <div class="themeToggle" id="themeToggle" role="group" aria-label="Theme">
          <button class="themeBtn active" data-theme-val="system" title="System Theme">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
          </button>
          <button class="themeBtn" data-theme-val="light" title="Light Theme">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="5"></circle>
              <line x1="12" y1="1" x2="12" y2="3"></line>
              <line x1="12" y1="21" x2="12" y2="23"></line>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
              <line x1="1" y1="12" x2="3" y2="12"></line>
              <line x1="21" y1="12" x2="23" y2="12"></line>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
            </svg>
          </button>
          <button class="themeBtn" data-theme-val="dark" title="Dark Theme">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>
            </svg>
          </button>
        </div>
      </div>
    </div>
    <div class="cards">
      <div class="card"><div class="k">Active</div><div class="v active" id="countActive">0</div></div>
      <div class="card"><div class="k">Pending</div><div class="v pending" id="countPending">0</div></div>
      <div class="card"><div class="k">Deprecated</div><div class="v deprecated" id="countDeprecated">0</div></div>
    </div>
    <div class="toolbar" id="tabs">
      <button class="btn on" data-status="active">Active</button>
      <button class="btn" data-status="pending">Pending</button>
      <button class="btn" data-status="deprecated">Deprecated</button>
      <button class="btn" data-status="all">All</button>
      <button class="btn" id="conflictsBtn">Conflicts</button>
    </div>
    <div class="panel">
      <div class="tableBox">
        <table>
          <thead>
            <tr>
              <th class="sortable" data-sort="id">ID</th>
              <th class="sortable" data-sort="topic_key">Topic.Key</th>
              <th class="sortable" data-sort="status">Status</th>
              <th class="sortable" data-sort="confidence">Confidence</th>
              <th class="sortable" data-sort="expires">Expires</th>
              <th class="sortable" data-sort="value">Value</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
      <div class="detailBox">
        <div class="muted">Item/Conflict detail</div>
        <div id="detail" class="detailContent"><pre>Select a row to inspect.</pre></div>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  </div>
  <div class="modalBack" id="manualModal">
    <div class="modalCard" role="dialog" aria-modal="true" aria-labelledby="manualModalTitle">
      <div class="modalTitle" id="manualModalTitle">Manual merge editor</div>
      <div class="modalMeta" id="manualModalMeta"></div>
      <textarea id="manualModalInput" class="modalInput" spellcheck="false"></textarea>
      <div class="modalActions">
        <button class="btn ghost" id="manualModalCancel">Cancel</button>
        <button class="btn primary" id="manualModalSave">Save merge</button>
      </div>
    </div>
  </div>
  <script>
    const state = { status: "active", mode: "items", selectedId: null, conflictsByPair: {}, sortBy: "id", sortDesc: false };
    let currentItems = [];
    const rowsEl = document.getElementById("rows");
    const detailEl = document.getElementById("detail");
    const toastEl = document.getElementById("toast");
    const metaEl = document.getElementById("meta");
    const conflictsBtn = document.getElementById("conflictsBtn");
    const scanAllBtn = document.getElementById("scanAllBtn");
    const manualModalEl = document.getElementById("manualModal");
    const manualModalMetaEl = document.getElementById("manualModalMeta");
    const manualModalInputEl = document.getElementById("manualModalInput");
    const manualModalCancelEl = document.getElementById("manualModalCancel");
    const manualModalSaveEl = document.getElementById("manualModalSave");
    const themeToggleEl = document.getElementById("themeToggle");

    function applyTheme(theme) {
      if (theme === "system") {
        document.documentElement.removeAttribute("data-theme");
      } else {
        document.documentElement.setAttribute("data-theme", theme);
      }
      localStorage.setItem("oc-theme", theme);
      document.querySelectorAll(".themeBtn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.themeVal === theme);
      });
    }

    // Initialize Theme
    const savedTheme = localStorage.getItem("oc-theme") || "system";
    applyTheme(savedTheme);

    themeToggleEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".themeBtn");
      if (!btn) return;
      applyTheme(btn.dataset.themeVal);
    });

    function setToast(text, ok = true) {
      toastEl.textContent = text;
      toastEl.style.color = ok ? "var(--ok)" : "var(--off)";
    }

    function short(v, max = 100) {
      const s = String(v || "").replace(/\\s+/g, " ").trim();
      return s.length <= max ? s : s.slice(0, max - 3) + "...";
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function commonPrefixLen(left, right) {
      const max = Math.min(left.length, right.length);
      let i = 0;
      while (i < max && left[i] === right[i]) i += 1;
      return i;
    }

    function commonSuffixLen(left, right, prefixLen) {
      const max = Math.min(left.length, right.length) - prefixLen;
      let i = 0;
      while (i < max && left[left.length - 1 - i] === right[right.length - 1 - i]) i += 1;
      return i;
    }

    function highlightLineDiff(value, otherValue, cssClass) {
      const left = String(value ?? "");
      const right = String(otherValue ?? "");
      if (left === right) return escapeHtml(left);
      const prefixLen = commonPrefixLen(left, right);
      const suffixLen = commonSuffixLen(left, right, prefixLen);
      const end = left.length - suffixLen;
      const start = prefixLen;
      if (end <= start) {
        return '<span class="' + cssClass + '">' + escapeHtml(left) + "</span>";
      }
      const prefix = escapeHtml(left.slice(0, start));
      const middle = escapeHtml(left.slice(start, end));
      const suffix = escapeHtml(left.slice(end));
      return prefix + '<span class="' + cssClass + '">' + middle + "</span>" + suffix;
    }

    function renderItemDetail(item) {
      detailEl.innerHTML = "<pre>" + escapeHtml(JSON.stringify(item, null, 2)) + "</pre>";
    }

    function renderEmptyDetail(message) {
      detailEl.innerHTML = "<pre>" + escapeHtml(message) + "</pre>";
    }

    function renderConflictDetail(conflict) {
      const leftLines = String(conflict.left.value ?? "").split("\\n");
      const rightLines = String(conflict.right.value ?? "").split("\\n");
      const lineCount = Math.max(leftLines.length, rightLines.length, 1);

      const leftRows = [];
      const rightRows = [];
      for (let idx = 0; idx < lineCount; idx += 1) {
        const lineNo = idx + 1;
        const leftLine = leftLines[idx] ?? "";
        const rightLine = rightLines[idx] ?? "";
        const changed = leftLine !== rightLine;
        const leftText = leftLine.length > 0 ? highlightLineDiff(leftLine, rightLine, "diffMarkL") : '<span class="diffEmpty">∅</span>';
        const rightText = rightLine.length > 0 ? highlightLineDiff(rightLine, leftLine, "diffMarkR") : '<span class="diffEmpty">∅</span>';
        leftRows.push(
          '<div class="diffLine' +
            (changed ? " changed" : "") +
            '"><div class="lineNo">' +
            lineNo +
            '</div><div class="lineText">' +
            leftText +
            "</div></div>",
        );
        rightRows.push(
          '<div class="diffLine' +
            (changed ? " changed" : "") +
            '"><div class="lineNo">' +
            lineNo +
            '</div><div class="lineText">' +
            rightText +
            "</div></div>",
        );
      }

      detailEl.innerHTML =
        '<div class="diffMeta">pair=' +
        escapeHtml(conflict.pair_id) +
        " | topic.key=" +
        escapeHtml(conflict.topic + "." + conflict.key) +
        " | statuses=" +
        escapeHtml(conflict.left.status + "/" + conflict.right.status) +
        "</div>" +
        '<div class="diffGrid">' +
        '<section class="diffPane"><div class="diffHeader left">Left: ' +
        escapeHtml(conflict.left.id) +
        '</div><div class="diffBody">' +
        leftRows.join("") +
        "</div></section>" +
        '<section class="diffPane"><div class="diffHeader right">Right: ' +
        escapeHtml(conflict.right.id) +
        '</div><div class="diffBody">' +
        rightRows.join("") +
        "</div></section>" +
        "</div>";
    }

    function openManualMergeModal(conflict) {
      const initial = String(conflict.left.value) + "\\n\\n---\\n\\n" + String(conflict.right.value);
      manualModalMetaEl.textContent =
        "pair=" + conflict.pair_id + " | left=" + conflict.left.id + " | right=" + conflict.right.id + " | Ctrl+Enter để lưu";
      manualModalInputEl.value = initial;
      manualModalEl.classList.add("open");
      manualModalInputEl.focus();
      manualModalInputEl.setSelectionRange(0, 0);

      return new Promise((resolve) => {
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          manualModalEl.classList.remove("open");
          manualModalCancelEl.removeEventListener("click", onCancel);
          manualModalSaveEl.removeEventListener("click", onSave);
          manualModalEl.removeEventListener("click", onBackdropClick);
          document.removeEventListener("keydown", onKeyDown, true);
          resolve(value);
        };
        const onCancel = () => finish(null);
        const onSave = () => finish(manualModalInputEl.value);
        const onBackdropClick = (event) => {
          if (event.target === manualModalEl) finish(null);
        };
        const onKeyDown = (event) => {
          if (!manualModalEl.classList.contains("open")) return;
          if (event.key === "Escape") {
            event.preventDefault();
            finish(null);
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            finish(manualModalInputEl.value);
          }
        };
        manualModalCancelEl.addEventListener("click", onCancel);
        manualModalSaveEl.addEventListener("click", onSave);
        manualModalEl.addEventListener("click", onBackdropClick);
        document.addEventListener("keydown", onKeyDown, true);
      });
    }

    async function fetchJson(url, options) {
      const res = await fetch(url, options);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || ("HTTP " + res.status));
      }
      return await res.json();
    }

    async function loadSummary() {
      const summary = await fetchJson("/api/summary");
      document.getElementById("countActive").textContent = summary.counts.active;
      document.getElementById("countPending").textContent = summary.counts.pending;
      document.getElementById("countDeprecated").textContent = summary.counts.deprecated;
      metaEl.textContent = "Status dir: " + summary.paths.statusDir + " | Runtime: " + summary.paths.workspaceMemoryPath;
    }

    function setMode(mode) {
      state.mode = mode;
      if (mode === "conflicts") {
        conflictsBtn.classList.add("on");
      } else {
        conflictsBtn.classList.remove("on");
      }
    }

    function sortItems(items) {
      return items.slice().sort((a, b) => {
        let valA, valB;
        switch (state.sortBy) {
          case "topic_key":
            valA = a.topic + "." + a.key;
            valB = b.topic + "." + b.key;
            break;
          case "status":
            valA = a.status;
            valB = b.status;
            break;
          case "confidence":
            const cMap = { high: 3, medium: 2, low: 1, "n/a": 0 };
            valA = cMap[a.confidence || "n/a"] || 0;
            valB = cMap[b.confidence || "n/a"] || 0;
            break;
          case "expires":
            valA = a.expires || "9999-99-99";
            valB = b.expires || "9999-99-99";
            break;
          case "value":
            valA = String(a.value || "");
            valB = String(b.value || "");
            break;
          case "id":
          default:
            valA = String(a.id || "");
            valB = String(b.id || "");
            break;
        }
        if (valA < valB) return state.sortDesc ? 1 : -1;
        if (valA > valB) return state.sortDesc ? -1 : 1;
        return 0;
      });
    }

    function renderRows(items) {
      currentItems = items;
      const sorted = sortItems(items);
      
      document.querySelectorAll("th.sortable").forEach(th => {
        const text = th.textContent.replace(/[ ▲▼]/g, "");
        if (th.dataset.sort === state.sortBy) {
          th.textContent = text + (state.sortDesc ? " ▼" : " ▲");
        } else {
          th.textContent = text;
        }
      });

      rowsEl.innerHTML = "";
      let selectedStillExists = false;
      for (const item of sorted) {
        const tr = document.createElement("tr");
        if (state.selectedId === item.id) {
          selectedStillExists = true;
          tr.classList.add("sel");
        }
        tr.dataset.id = item.id;
        tr.innerHTML = \`
          <td>\${item.id}</td>
          <td>\${item.topic}.\${item.key}</td>
          <td>\${item.status}</td>
          <td>\${item.confidence || "n/a"}</td>
          <td>\${item.expires}</td>
          <td title="\${String(item.value).replaceAll('"', '&quot;')}">\${short(item.value)}</td>
          <td>
            <div class="rowActions">
              <select data-move-id="\${item.id}">
                <option value="active" \${item.status==="active"?"selected":""}>active</option>
                <option value="pending" \${item.status==="pending"?"selected":""}>pending</option>
                <option value="deprecated" \${item.status==="deprecated"?"selected":""}>deprecated</option>
              </select>
              <button class="btn" data-apply-id="\${item.id}">Apply</button>
            </div>
          </td>\`;
        tr.addEventListener("click", (event) => {
          if (event.target.closest("select") || event.target.closest("button")) return;
          state.selectedId = item.id;
          renderItemDetail(item);
          for (const row of rowsEl.querySelectorAll("tr")) row.classList.remove("sel");
          tr.classList.add("sel");
        });
        rowsEl.appendChild(tr);
      }
      if (items.length === 0) {
        rowsEl.innerHTML = '<tr><td colspan="7" class="muted">No items.</td></tr>';
        state.selectedId = null;
        renderEmptyDetail("No items.");
        return;
      }
      if (!selectedStillExists) {
        state.selectedId = null;
        renderEmptyDetail("Select a row to inspect.");
      }
    }

    function renderConflictRows(conflicts) {
      rowsEl.innerHTML = "";
      state.conflictsByPair = {};
      let selectedStillExists = false;
      for (const conflict of conflicts) {
        state.conflictsByPair[conflict.pair_id] = conflict;
        const tr = document.createElement("tr");
        if (state.selectedId === conflict.pair_id) {
          selectedStillExists = true;
          tr.classList.add("sel");
        }
        tr.dataset.id = conflict.pair_id;
        tr.innerHTML = \`
          <td>\${conflict.pair_id}</td>
          <td>\${conflict.topic}.\${conflict.key}</td>
          <td>\${conflict.left.id}</td>
          <td>\${conflict.right.id}</td>
          <td>\${conflict.left.status}/\${conflict.right.status} conflict</td>
          <td>
            <div title="\${String(conflict.left.value).replaceAll('"', '&quot;')}"><strong>L:</strong> \${short(conflict.left.value, 70)}</div>
            <div title="\${String(conflict.right.value).replaceAll('"', '&quot;')}"><strong>R:</strong> \${short(conflict.right.value, 70)}</div>
          </td>
          <td>
            <div class="rowActions merge">
              <button class="btn" data-merge-pair="\${conflict.pair_id}" data-merge-strategy="left">Keep Left</button>
              <button class="btn" data-merge-pair="\${conflict.pair_id}" data-merge-strategy="right">Keep Right</button>
              <button class="btn" data-merge-pair="\${conflict.pair_id}" data-merge-strategy="manual">Manual</button>
            </div>
          </td>\`;
        tr.addEventListener("click", (event) => {
          if (event.target.closest("button")) return;
          state.selectedId = conflict.pair_id;
          renderConflictDetail(conflict);
          for (const row of rowsEl.querySelectorAll("tr")) row.classList.remove("sel");
          tr.classList.add("sel");
        });
        rowsEl.appendChild(tr);
      }
      if (conflicts.length === 0) {
        rowsEl.innerHTML = '<tr><td colspan="7" class="muted">No active conflicts.</td></tr>';
        state.selectedId = null;
        renderEmptyDetail("No active conflicts.");
        return;
      }
      if (!selectedStillExists) {
        state.selectedId = null;
        renderEmptyDetail("Select a conflict to inspect.");
      }
    }

    async function loadItems() {
      const q = state.status === "all" ? "" : ("?status=" + state.status);
      const payload = await fetchJson("/api/items" + q);
      renderRows(payload.items);
    }

    async function loadConflicts() {
      const payload = await fetchJson("/api/conflicts");
      renderConflictRows(payload.conflicts || []);
    }

    async function refreshAll() {
      await loadSummary();
      if (state.mode === "conflicts") {
        await loadConflicts();
      } else {
        await loadItems();
      }
    }

    document.getElementById("tabs").addEventListener("click", async (event) => {
      const btn = event.target.closest("button[data-status]");
      if (!btn) return;
      setMode("items");
      state.status = btn.dataset.status;
      for (const b of document.querySelectorAll('#tabs button[data-status]')) b.classList.remove("on");
      btn.classList.add("on");
      await loadItems();
    });

    document.querySelector("thead").addEventListener("click", (e) => {
      const th = e.target.closest("th.sortable");
      if (!th) return;
      const sortBy = th.dataset.sort;
      if (state.sortBy === sortBy) {
        state.sortDesc = !state.sortDesc;
      } else {
        state.sortBy = sortBy;
        state.sortDesc = false;
      }
      if (state.mode === "items") {
        renderRows(currentItems);
      }
    });

    rowsEl.addEventListener("click", async (event) => {
      const mergeBtn = event.target.closest("button[data-merge-pair]");
      if (mergeBtn) {
        const pairId = mergeBtn.dataset.mergePair;
        const strategy = mergeBtn.dataset.mergeStrategy;
        const conflict = state.conflictsByPair[pairId];
        if (!conflict) return;
        let mergedValue;
        let keepId;
        if (strategy === "left") {
          keepId = conflict.left.id;
          mergedValue = conflict.left.value;
        } else if (strategy === "right") {
          keepId = conflict.right.id;
          mergedValue = conflict.right.value;
        } else {
          keepId = conflict.left.id;
          const input = await openManualMergeModal(conflict);
          if (input === null) return;
          mergedValue = input;
        }
        try {
          const res = await fetchJson("/api/conflicts/merge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              leftId: conflict.left.id,
              rightId: conflict.right.id,
              keepId,
              mergedValue,
            }),
          });
          setToast("Merged conflict " + res.pairId + " -> kept " + res.mergedId + ", deprecated " + res.deprecatedId + ".");
          await refreshAll();
        } catch (error) {
          setToast("Merge failed: " + (error?.message || String(error)), false);
        }
        return;
      }

      const btn = event.target.closest("button[data-apply-id]");
      if (!btn) return;
      const id = btn.dataset.applyId;
      const select = rowsEl.querySelector('select[data-move-id="' + id + '"]');
      if (!select) return;
      const to = select.value;
      try {
        const res = await fetchJson("/api/items/" + encodeURIComponent(id) + "/status", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to }),
        });
        setToast("Moved " + id + " from " + res.from + " to " + res.to + ". Files synced.");
        await refreshAll();
      } catch (error) {
        setToast("Update failed: " + (error?.message || String(error)), false);
      }
    });

    conflictsBtn.addEventListener("click", async () => {
      try {
        setMode("conflicts");
        await loadConflicts();
      } catch (error) {
        setToast("Conflict load failed: " + (error?.message || String(error)), false);
      }
    });

    document.getElementById("refreshBtn").addEventListener("click", async () => {
      try {
        await refreshAll();
        setToast("Refreshed.");
      } catch (error) {
        setToast("Refresh failed: " + (error?.message || String(error)), false);
      }
    });

    scanAllBtn.addEventListener("click", async () => {
      scanAllBtn.disabled = true;
      setToast("Running triage --all...");
      try {
        const res = await fetchJson("/api/scan-all", { method: "POST" });
        await refreshAll();
        const stats = "triaged=" + (res.triaged ?? 0) + " quarantined=" + (res.quarantined ?? 0) + " duplicates=" + (res.duplicates ?? 0) + " ignored=" + (res.ignored ?? 0);
        setToast("Scan all done (" + stats + ").");
      } catch (error) {
        setToast("Scan all failed: " + (error?.message || String(error)), false);
      } finally {
        scanAllBtn.disabled = false;
      }
    });

    refreshAll().catch((error) => setToast("Init failed: " + (error?.message || String(error)), false));
  </script>
</body>
</html>`;
}

async function main() {
  const args = asCliArgMap(process.argv.slice(2));
  if (args.help === true) {
    usageAndExit(0);
  }

  const host = typeof args.host === "string" ? args.host : "127.0.0.1";
  const portRaw = typeof args.port === "string" ? args.port : "3903";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid --port");
  }

  const paths = resolveMemoryStatusPaths(args);
  await ensureStatusBuckets(paths);

  const app = express();
  app.use(express.json());
  let scanAllInFlight = false;

  const runInboxTriageAll = async (): Promise<{
    triaged: number;
    quarantined: number;
    duplicates: number;
    ignored: number;
    stdout: string;
  }> => {
    const scriptPath = resolve(process.cwd(), "scripts", "memory-inbox-triage.ts");
    const { stdout, stderr } = await execFileAsync(
      "node",
      [
        "--import",
        "tsx",
        scriptPath,
        "--all",
        "--root",
        paths.memoryRoot,
        "--workspace-root",
        paths.workspaceRoot,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const output = `${stdout}\n${stderr}`.trim();
    const parseCount = (label: string): number => {
      const match = new RegExp(`- ${label}:\\s*(\\d+)`, "i").exec(output);
      if (!match) {
        return 0;
      }
      return Number.parseInt(match[1], 10) || 0;
    };
    return {
      triaged: parseCount("triaged total"),
      quarantined: parseCount("quarantined conflicts"),
      duplicates: parseCount("duplicates"),
      ignored: parseCount("ignored"),
      stdout: output,
    };
  };

  app.get("/", (_req, res) => {
    res.type("html").send(renderAppHtml());
  });

  app.get("/api/summary", async (_req, res) => {
    const buckets = await loadStatusBuckets(paths);
    res.json({
      date: formatDateNowUtc(),
      counts: countsByStatus(buckets),
      paths: {
        statusDir: paths.statusDir,
        memoryPath: paths.memoryPath,
        workspaceMemoryPath: paths.workspaceMemoryPath,
        workspaceTopicDir: paths.workspaceTopicDir,
      },
    });
  });

  app.get("/api/items", async (req, res) => {
    const buckets = await loadStatusBuckets(paths);
    const status = parseStatus(req.query.status);
    let items = flattenBuckets(buckets);
    if (status) {
      items = buckets[status];
    }
    const rows = items
      .map((item) => toApiItem(item))
      .toSorted((left, right) => left.id.localeCompare(right.id));
    res.json({ items: rows });
  });

  app.get("/api/conflicts", async (_req, res) => {
    const buckets = await loadStatusBuckets(paths);
    const conflicts = listConflicts(flattenBuckets(buckets));
    const rows: ApiConflict[] = conflicts.map((conflict) => ({
      pair_id: conflict.pair_id,
      topic: conflict.topic,
      key: conflict.key,
      left: toApiItem(conflict.left),
      right: toApiItem(conflict.right),
    }));
    res.json({ conflicts: rows });
  });

  app.get("/api/items/:id", async (req, res) => {
    const id = req.params.id;
    const buckets = await loadStatusBuckets(paths);
    const item = flattenBuckets(buckets).find((entry) => entry.id === id);
    if (!item) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    res.json({ item: toApiItem(item) });
  });

  app.patch("/api/items/:id/status", async (req, res) => {
    const id = req.params.id;
    const to = parseStatus(req.body?.to);
    if (!to) {
      res.status(400).json({ error: "Invalid target status" });
      return;
    }
    try {
      const changed = await applyStatusChange({
        paths,
        id,
        to,
      });
      res.json({
        ok: true,
        from: changed.from,
        to: changed.to,
        item: toApiItem(changed.item),
        counts: changed.counts,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/conflicts/merge", async (req, res) => {
    const leftId = typeof req.body?.leftId === "string" ? req.body.leftId.trim() : "";
    const rightId = typeof req.body?.rightId === "string" ? req.body.rightId.trim() : "";
    const keepIdRaw = typeof req.body?.keepId === "string" ? req.body.keepId.trim() : "";
    const mergedValue = parseMergeValue(req.body?.mergedValue);
    if (!leftId || !rightId) {
      res.status(400).json({ error: "Missing leftId/rightId" });
      return;
    }
    if (mergedValue === null) {
      res.status(400).json({ error: "Invalid mergedValue (must be string|number|boolean)" });
      return;
    }
    const keepId = keepIdRaw.length > 0 ? keepIdRaw : undefined;
    try {
      const changed = await applyConflictMerge({
        paths,
        leftId,
        rightId,
        mergedValue,
        keepId,
      });
      res.json({
        ok: true,
        pairId: changed.pairId,
        mergedId: changed.mergedId,
        deprecatedId: changed.deprecatedId,
        counts: changed.counts,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/scan-all", async (_req, res) => {
    if (scanAllInFlight) {
      res.status(409).json({ error: "Scan all is already running" });
      return;
    }
    scanAllInFlight = true;
    try {
      const startedAt = Date.now();
      const result = await runInboxTriageAll();
      res.json({
        ok: true,
        duration_ms: Date.now() - startedAt,
        triaged: result.triaged,
        quarantined: result.quarantined,
        duplicates: result.duplicates,
        ignored: result.ignored,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    } finally {
      scanAllInFlight = false;
    }
  });

  app.listen(port, host, () => {
    console.log("memory:dashboard:web running");
    console.log(`- url: http://${host}:${port}`);
    console.log(`- status dir: ${paths.statusDir}`);
    console.log(`- memory file: ${paths.memoryPath}`);
    console.log(`- runtime file: ${paths.workspaceMemoryPath}`);
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`memory:dashboard:web failed: ${message}`);
  process.exitCode = 2;
});
