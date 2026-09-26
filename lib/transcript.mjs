// lib/transcript.mjs — reads the tail of a Claude Code transcript (JSONL) and summarises the current
// turn: which project files were edited and whether anything verified them after the last edit.
// Everything here fails soft: an unreadable transcript is an empty turn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const DELEGATION_TOOLS = new Set(['Agent', 'Task']);
const BROWSER_TOOL = /^mcp__(Claude_Browser|claude-in-chrome|Claude_Code_iOS_Simulator|playwright|puppeteer)/i;

// Commands that exercise the change: test runners, type checks, builds, linters, and requests
// against a locally running app.
const VERIFY_COMMAND = new RegExp([
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t|check|verify|typecheck|type-check|lint|build|e2e|ci)\b`,
  String.raw`\bnode\s+--test\b`,
  String.raw`\b(vitest|jest|mocha|ava|playwright|cypress|pytest|tox|nox|rspec|phpunit|pest|tsc|eslint|ruff|mypy|pyright)\b`,
  String.raw`\bpython3?\s+-m\s+(pytest|unittest|mypy)\b`,
  String.raw`\bgo\s+(test|vet|build)\b`,
  String.raw`\bcargo\s+(test|nextest|check|clippy|build)\b`,
  String.raw`\b(mvn|gradle|gradlew)\b[^|;&]*\b(test|verify|check|build)\b`,
  String.raw`\bdotnet\s+(test|build)\b`,
  String.raw`\b(rake|mix|deno|swift)\s+test\b`,
  String.raw`\bphp\s+artisan\s+test\b`,
  String.raw`\bxcodebuild\b[^|;&]*\b(test|build)\b`,
  String.raw`\bmake\s+(test|check|verify|build)\b`,
  String.raw`\bcurl\b[^|;&]*\b(localhost|127\.0\.0\.1)\b`,
  // Applying SQL to a (scratch) database is how schema and migration files get checked.
  String.raw`\b(psql|sqlite3|mysql|mariadb)\b`,
  String.raw`(^|[\s/])(test|tests|check|e2e|verify)[\w.-]*\.(sh|mjs|js|ts|py)\b`,
].join('|'));

export function readTail(file, maxBytes = 4 * 1024 * 1024) {
  try {
    const resolved = String(file ?? '').replace(/^~(?=\/|$)/, os.homedir());
    const { size } = fs.statSync(resolved);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(resolved, 'r');
    try {
      fs.readSync(fd, buf, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  }
}

export function parseEntries(text) {
  const entries = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn or foreign line; skip it.
    }
  }
  return entries;
}

function isHumanText(entry) {
  if (entry?.type !== 'user' || entry.isMeta) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((b) => b?.type === 'text') && !content.some((b) => b?.type === 'tool_result');
}

// The entries after the last message a person (or the harness on their behalf) sent.
export function currentTurn(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isHumanText(entries[i])) return entries.slice(i + 1);
  }
  return entries.slice();
}

function toolUses(entries) {
  const uses = [];
  for (const entry of entries) {
    if (entry?.type !== 'assistant') continue;
    for (const block of entry.message?.content || []) {
      if (block?.type === 'tool_use') uses.push(block);
    }
  }
  return uses;
}

function projectFile(filePath, cwd) {
  if (!filePath || !cwd) return null;
  const abs = path.resolve(cwd, String(filePath));
  const rel = path.relative(path.resolve(cwd), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

// The report a subagent delivered through the SubagentHandback tool (auto mode), if any.
export function handbackReport(turn) {
  const handback = toolUses(turn).filter((u) => u.name === 'SubagentHandback').at(-1);
  const message = handback?.input?.message;
  return typeof message === 'string' && message.trim() ? message : null;
}

// The working directory recorded on the most recent transcript entry (a worktree for isolated agents).
export function turnCwd(turn) {
  for (let i = turn.length - 1; i >= 0; i--) {
    if (typeof turn[i]?.cwd === 'string' && turn[i].cwd) return turn[i].cwd;
  }
  return null;
}

export function analyzeTurn(turn, { cwd } = {}) {
  const uses = toolUses(turn);
  const edits = [];
  let lastEdit = -1;
  uses.forEach((use, i) => {
    if (!EDIT_TOOLS.has(use.name)) return;
    const rel = projectFile(use.input?.file_path ?? use.input?.notebook_path, cwd);
    if (!rel || DOC_FILE.test(rel)) return;
    if (!edits.includes(rel)) edits.push(rel);
    lastEdit = i;
  });
  let verification = null;
  if (lastEdit >= 0) {
    for (const use of uses.slice(lastEdit + 1)) {
      if (use.name === 'Bash' && VERIFY_COMMAND.test(String(use.input?.command ?? ''))) { verification = 'bash'; break; }
      if (BROWSER_TOOL.test(use.name)) { verification = 'browser'; break; }
      if (DELEGATION_TOOLS.has(use.name)) { verification = 'delegated'; break; }
    }
  }
  return { edits, verifiedAfterEdit: verification !== null, verification };
}
