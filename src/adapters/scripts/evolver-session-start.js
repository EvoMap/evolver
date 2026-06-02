#!/usr/bin/env node
// evolver-session-start.js
// Reads recent evolution memory and injects it as context for the agent session.
// Input: stdin JSON (session context). Output: stdout JSON with agent_message.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { findEvolverRoot, findMemoryGraph, resolveProjectDir, resolveWorkspaceId, isGitWorkspace } = require('./_runtimePaths');
const { filterRelevantOutcomes } = require('./_memoryFiltering');

// One-line notice shown (throttled) when the workspace is not a git repo.
// Evolver derives every outcome from the git diff, so in a non-git folder the
// session-end hook records nothing — silently, unless we say so here. We surface
// it in session-start's additionalContext (injected as opening context, which
// does NOT trigger an extra inference round, unlike a stop-hook systemMessage).
const NON_GIT_NOTICE =
  '[Evolver] This folder is not a git repository, so evolution memory is inactive ' +
  '(outcomes are derived from git diffs). Run `git init` here, or open a git project, ' +
  'to enable recall and recording.';
const NON_GIT_NOTICE_TTL_MS = 30 * 60 * 1000; // once per 30 min per folder

// Return up to `n` of the current workspace's most-recent entries, in
// chronological (oldest-first) order.
//
// Why scan from the end: a plain tail-N-then-filter read would let outcomes
// from other projects (which share the user-level fallback graph on npm-global
// installs) crowd this workspace's entries out of the window — we must scope
// to the workspace BEFORE trimming. But parsing the ENTIRE file to do that is
// wasteful: the graph can reach ~100 MB before rotation, and JSON-parsing every
// line on each session start is real CPU/memory cost (Bugbot PR #555 round-3).
//
// So we read the file (cheap; the previous readLastN read it whole too) but
// JSON-parse lines lazily from the newest end, keeping only workspace matches,
// and stop as soon as we have `n`. Parse count is bounded by where this
// workspace's n-th-most-recent entry sits, not by total file size.
function readRecentWorkspaceEntries(filePath, currentId, currentDir, n) {
  let lines;
  try {
    lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (belongsToWorkspace(entry, currentId, currentDir)) out.push(entry);
  }
  return out.reverse(); // newest-collected-first -> chronological
}

// Does this memory-graph entry belong to the current workspace?
//
// The session-end writer stamps two tags: `workspace_id` (forge-resistant,
// preferred) and `cwd` (backward-compat). We scope reads so that one project
// never sees another's outcomes through the shared user-level fallback graph
// (~/.evolver/memory/evolution/memory_graph.jsonl) — the cross-project
// disclosure / prompt-injection surface Bugbot flagged on the writer side
// (PR #105 round-2), which the reader never enforced until now.
//
// Rules, in order:
//   - currentId known + entry.workspace_id present -> must match exactly.
//   - currentId unknown OR entry has neither tag (pre-hardening / Hub-sourced
//     entries) -> do NOT exclude; falling back to "show it" preserves prior
//     behavior and avoids hiding all memory when ids can't be resolved.
//   - As a softer fallback, when the entry has no workspace_id but does carry a
//     cwd, match that against the current project dir.
function belongsToWorkspace(entry, currentId, currentDir) {
  if (entry && typeof entry.workspace_id === 'string' && entry.workspace_id) {
    if (currentId) return entry.workspace_id === currentId;
    return true; // can't compare — don't hide it
  }
  if (entry && typeof entry.cwd === 'string' && entry.cwd) {
    if (currentDir) return entry.cwd === currentDir;
    return true;
  }
  return true; // untagged (legacy / Hub) — never excluded
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

// TTL throttle keyed by an arbitrary string, persisted in session-start-state
// .json. Returns true if `key` fired within the last `ttlMs` (caller should
// suppress); otherwise records "now" for `key` and returns false. Best-effort:
// a state read/write failure just means no throttling (fail open). Shared by
// the Kiro per-prompt dedup and the non-git notice so both age out of the same
// file (entries older than 24h are pruned on write).
function throttled(key, ttlMs) {
  const statePath = getDedupStatePath();
  let state = {};
  try {
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {};
    }
  } catch { state = {}; }

  const now = Date.now();
  const last = state[key];
  if (typeof last === 'number' && now - last < ttlMs) return true;

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

function shouldSkipInjection() {
  // Only apply dedup when explicitly enabled (set by Kiro adapter) OR when
  // we detect a per-prompt-firing platform via PROMPT_SUBMIT heuristic in
  // stdin. The stdin is drained in main(), so we rely on env flag here.
  const dedupEnabled = String(process.env.EVOLVER_SESSION_START_DEDUP || '').toLowerCase() === '1'
    || String(process.env.EVOLVER_SESSION_START_DEDUP || '').toLowerCase() === 'true';
  if (!dedupEnabled) return false;

  const ttlMs = Number(process.env.EVOLVER_SESSION_START_DEDUP_TTL_MS) || (30 * 60 * 1000);
  return throttled(process.cwd(), ttlMs);
}

function main() {
  if (shouldSkipInjection()) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const currentDir = resolveProjectDir();

  // Non-git notice: evolver records nothing in a non-git folder (outcomes come
  // from git diffs), so tell the user — once per folder per TTL — instead of
  // failing silently. Emitted regardless of whether any memory exists below.
  const parts = [];
  if (!isGitWorkspace(currentDir) && !throttled('nongit:' + currentDir, NON_GIT_NOTICE_TTL_MS)) {
    parts.push(NON_GIT_NOTICE);
  }

  const evolverRoot = findEvolverRoot();
  const graphPath = findMemoryGraph(evolverRoot);

  // Scope to the current workspace BEFORE trimming to the most-recent window,
  // so other projects sharing the user-level fallback graph can't crowd this
  // workspace's outcomes out of view. When the workspace id can't be resolved,
  // belongsToWorkspace() falls back to "show it" — no regression vs. the old
  // unscoped behavior.
  if (graphPath) {
    const currentId = resolveWorkspaceId(evolverRoot, currentDir);
    const recent = readRecentWorkspaceEntries(graphPath, currentId, currentDir, 5);
    const filtered = filterRelevantOutcomes(recent);
    if (filtered.length > 0) {
      const successCount = filtered.filter(e => e.outcome && e.outcome.status === 'success').length;
      const failCount = filtered.filter(e => e.outcome && e.outcome.status === 'failed').length;
      parts.push([
        `[Evolution Memory] Recent ${filtered.length} outcomes (${successCount} success, ${failCount} failed):`,
        ...filtered.map(formatOutcome),
        '',
        'Use successful approaches. Avoid repeating failed patterns.',
      ].join('\n'));
    }
  }

  if (parts.length === 0) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const out = parts.join('\n\n');
  process.stdout.write(JSON.stringify({
    agent_message: out,
    additionalContext: out,
  }));
}

// Run as a hook when invoked directly; expose pure helpers for unit tests when
// required as a module. Guarding on require.main keeps the direct-execution
// behavior (the hosts run `node evolver-session-start.js`) unchanged.
if (require.main === module) {
  main();
} else {
  module.exports = { belongsToWorkspace };
}
