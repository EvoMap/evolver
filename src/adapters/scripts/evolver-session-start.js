#!/usr/bin/env node
// evolver-session-start.js
// Reads recent evolution memory and injects it as context for the agent session.
// Input: stdin JSON (session context). Output: stdout JSON with agent_message.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { findEvolverRoot, findMemoryGraph } = require('./_runtimePaths');
const { filterRelevantOutcomes } = require('./_memoryFiltering');

function findGitRoot(start) {
  let dir = path.resolve(start || process.cwd());
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function resolveWorkspaceRootForReader() {
  if (process.env.OPENCLAW_WORKSPACE) return process.env.OPENCLAW_WORKSPACE;
  const repoRoot = process.env.EVOLVER_REPO_ROOT || findGitRoot(process.cwd()) || process.cwd();
  const workspaceDir = path.join(repoRoot, 'workspace');
  if (fs.existsSync(workspaceDir)) return workspaceDir;
  return repoRoot;
}

function resolveWorkspaceIdForReader() {
  if (process.env.EVOLVER_WORKSPACE_ID) return String(process.env.EVOLVER_WORKSPACE_ID);
  const file = path.join(resolveWorkspaceRootForReader(), '.evolver', 'workspace-id');
  try {
    const dirStat = fs.lstatSync(path.dirname(file), { throwIfNoEntry: false });
    if (dirStat && dirStat.isSymbolicLink()) return null;
    const fileStat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (raw && /^[a-f0-9]{32,}$/i.test(raw)) return raw;
  } catch { /* workspace id is best-effort in copied hooks */ }
  return null;
}

function filterWorkspaceEntries(entries) {
  const cwd = process.cwd();
  const workspaceId = resolveWorkspaceIdForReader();

  return entries.filter(entry => {
    if (!entry || typeof entry !== 'object') return false;
    if (workspaceId && entry.workspace_id) {
      return String(entry.workspace_id) === String(workspaceId);
    }
    if (entry.cwd) {
      return path.resolve(String(entry.cwd)) === path.resolve(cwd);
    }
    // Older entries did not carry a workspace tag. Do not inject them from
    // hooks because copied hooks often share a user-level fallback memory file.
    return false;
  });
}

function readLastN(filePath, n) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function formatOutcome(entry) {
  const status = entry.outcome ? entry.outcome.status : 'unknown';
  const score = entry.outcome && entry.outcome.score != null ? entry.outcome.score : '?';
  const note = entry.outcome && entry.outcome.note ? entry.outcome.note : '';
  const signals = Array.isArray(entry.signals) ? entry.signals.slice(0, 3).join(', ') : '';
  const ts = entry.timestamp ? entry.timestamp.slice(0, 10) : '';
  const icon = status === 'success' ? '+' : status === 'failed' ? '-' : '?';
  return `[${icon}] ${ts} score=${score} signals=[${signals}] ${note}`.slice(0, 200);
}

// Dedup guard: on platforms like Kiro, the sessionStart-equivalent event
// (`promptSubmit`) fires on every user message in a session. Without this
// guard, recent memory would be re-injected on every prompt. We key the
// dedup on (platform, cwd) with a short TTL so a fresh agent session within
// the same workspace still gets the injection, but mid-session prompts do
// not. Cursor/Claude Code/Codex have true sessionStart events and should
// bypass this check (controlled by EVOLVER_SESSION_START_DEDUP env var,
// which the Kiro adapter sets on the hook command line implicitly via the
// runtime environment, and other adapters leave unset).
function getDedupStatePath() {
  const dir = process.env.EVOLVER_SESSION_STATE_DIR
    || path.join(os.homedir(), '.evolver');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return path.join(dir, 'session-start-state.json');
}

function shouldSkipInjection() {
  // Only apply dedup when explicitly enabled (set by Kiro adapter) OR when
  // we detect a per-prompt-firing platform via PROMPT_SUBMIT heuristic in
  // stdin. The stdin is drained in main(), so we rely on env flag here.
  const dedupEnabled = String(process.env.EVOLVER_SESSION_START_DEDUP || '').toLowerCase() === '1'
    || String(process.env.EVOLVER_SESSION_START_DEDUP || '').toLowerCase() === 'true';
  if (!dedupEnabled) return false;

  const ttlMs = Number(process.env.EVOLVER_SESSION_START_DEDUP_TTL_MS) || (30 * 60 * 1000);
  const key = process.cwd();
  const statePath = getDedupStatePath();

  let state = {};
  try {
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {};
    }
  } catch { state = {}; }

  const now = Date.now();
  const last = state[key];
  if (typeof last === 'number' && now - last < ttlMs) {
    return true;
  }

  state[key] = now;
  try {
    for (const k of Object.keys(state)) {
      if (typeof state[k] !== 'number' || now - state[k] > 24 * 60 * 60 * 1000) {
        delete state[k];
      }
    }
    const tmp = statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, statePath);
  } catch { /* best-effort */ }

  return false;
}

function main() {
  if (shouldSkipInjection()) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const evolverRoot = findEvolverRoot();
  const graphPath = findMemoryGraph(evolverRoot);

  if (!graphPath) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const entries = readLastN(graphPath, 20);
  const scoped = filterWorkspaceEntries(entries);
  const filtered = filterRelevantOutcomes(scoped);

  if (filtered.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const successCount = filtered.filter(e => e.outcome && e.outcome.status === 'success').length;
  const failCount = filtered.filter(e => e.outcome && e.outcome.status === 'failed').length;

  const lines = filtered.map(formatOutcome);
  const summary = [
    `[Evolution Memory] Recent ${filtered.length} outcomes (${successCount} success, ${failCount} failed):`,
    ...lines,
    '',
    'Use successful approaches. Avoid repeating failed patterns.',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    agent_message: summary,
    additionalContext: summary,
  }));
}

main();
