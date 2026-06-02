#!/usr/bin/env node
// evolver-session-end.js
// Records evolution outcome at session end.
// Collects git diff stats, extracts signals, records via Hub API or local memory.
// Input: stdin JSON. Output: stdout JSON with `systemMessage` (Claude Code Stop
// hook notification) — or empty `{}` on Cursor where systemMessage is mishandled.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
// 10 MB — prevents RangeError on large child process output (e.g. git log/diff
// on large repos). See GHSA reports / issue #451.
const MAX_EXEC_BUFFER = 10 * 1024 * 1024;

const { findEvolverRoot, findMemoryGraph, resolveProjectDir, resolveWorkspaceId } = require('./_runtimePaths');

// Workspace-id resolution is shared with the session-start reader via
// _runtimePaths.resolveWorkspaceId(). Reader and writer MUST resolve the SAME
// id or workspace scoping silently breaks (no entry would ever match the
// reader's filter), so this logic lives in exactly one place instead of being
// duplicated here. The shared resolver mirrors src/gep/paths.js#getWorkspaceId()
// loaded from the evolver root, with an EVOLVER_WORKSPACE_ID env override —
// consistent with the review-time reader in src/evolve/pipeline/collect.js
// (Bugbot PR #109 round-1 MEDIUM; reader/writer drift flagged on PR #555).

function runGit(args, cwd) {
  // Argv-array form, no shell. Avoids POSIX `2>/dev/null` redirects that
  // break on Windows cmd.exe (#537). Failures (e.g. no HEAD~1 in a fresh
  // repo) are surfaced as a non-zero status; callers distinguish them
  // from successful empty output via the `ok` flag (PR #94 round-6 LOW).
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: MAX_EXEC_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (res.status === 0 && typeof res.stdout === 'string') {
    return { ok: true, out: res.stdout.trim() };
  }
  return { ok: false, out: '' };
}

function getGitDiffStats() {
  // Use the host-provided workspace root, not process.cwd(): Cursor runs some
  // hook events with cwd set to the plugin dir, where `git diff` finds nothing.
  const cwd = resolveProjectDir();
  // Distinguish "git failed (no HEAD~1, etc.)" from "git succeeded with
  // empty output (e.g. empty merge)". The previous `||` chain treated
  // both as falsy and fell through to the working-tree diff, which can
  // surface unrelated unstaged changes as the session outcome.
  const statHead1 = runGit(['diff', '--stat', 'HEAD~1'], cwd);
  const stat = statHead1.ok ? statHead1.out : runGit(['diff', '--stat'], cwd).out;
  const diffHead1 = runGit(['diff', '--no-color', 'HEAD~1'], cwd);
  const diffContent = diffHead1.ok ? diffHead1.out : runGit(['diff', '--no-color'], cwd).out;
  const filesChanged = (stat.match(/\d+ files? changed/) || ['0'])[0];
  const insertions = (stat.match(/(\d+) insertions?/) || [null, '0'])[1];
  const deletions = (stat.match(/(\d+) deletions?/) || [null, '0'])[1];
  // Distinguish "no git repo here" from "repo with no changes" purely for the
  // skip-log message — the diff commands above can't tell the two apart (both
  // yield empty output). A single cheap rev-parse settles it.
  const isRepo = runGit(['rev-parse', '--is-inside-work-tree'], cwd).out === 'true';
  return {
    stat,
    summary: `${filesChanged}, +${insertions}/-${deletions}`,
    diffSnippet: diffContent.slice(0, 2000),
    hasChanges: stat.length > 0,
    isRepo,
  };
}

// Detect whether the hook is running inside Cursor.
//
// Why: Claude Code's Stop hook spec says `systemMessage` is a notification
// shown to the user and is NOT fed back into Claude's context. Cursor's
// Claude Code-compatible runtime currently splices it into the next
// inference round as if it were a user prompt, so Claude "responds" to the
// evolution receipt — visible to users as an unexplained extra reasoning
// turn after every task. Until Cursor fixes this, suppress systemMessage
// on Cursor while keeping the local-memory append intact.
//
// Detection (any of):
//   - TERM_PROGRAM=cursor
//   - CURSOR_TRACE_ID / CURSOR_SESSION_ID set
//   - EVOLVER_HOOK_HOST=cursor (manual override)
// Escape hatch: EVOLVER_HOOK_VERBOSE=1 forces the message on regardless.
function isCursorHost() {
  const verbose = String(process.env.EVOLVER_HOOK_VERBOSE || '').toLowerCase();
  if (verbose === '1' || verbose === 'true') return false;
  if (String(process.env.EVOLVER_HOOK_HOST || '').toLowerCase() === 'cursor') return true;
  if (String(process.env.TERM_PROGRAM || '').toLowerCase() === 'cursor') return true;
  if (process.env.CURSOR_TRACE_ID) return true;
  if (process.env.CURSOR_SESSION_ID) return true;
  return false;
}

function detectSignals(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const signals = [];
  if (/error:|exception:|failed/i.test(lower)) signals.push('log_error');
  if (/timeout|slow|latency|bottleneck/i.test(lower)) signals.push('perf_bottleneck');
  if (/add|implement|feature|new function|new module/i.test(lower)) signals.push('user_feature_request');
  if (/improve|enhance|refactor|optimize/i.test(lower)) signals.push('user_improvement_suggestion');
  if (/not supported|unsupported|not implemented/i.test(lower)) signals.push('capability_gap');
  if (/deploy|ci|pipeline|build failed/i.test(lower)) signals.push('deployment_issue');
  if (/test fail|assertion|expect\(/i.test(lower)) signals.push('test_failure');
  return [...new Set(signals)];
}

function recordToHub(outcome) {
  const hubUrl = process.env.EVOMAP_HUB_URL || process.env.A2A_HUB_URL;
  const apiKey = process.env.EVOMAP_API_KEY || process.env.A2A_NODE_SECRET;
  const nodeId = process.env.EVOMAP_NODE_ID || process.env.A2A_NODE_ID;
  if (!hubUrl || !apiKey) return false;

  try {
    const payload = JSON.stringify({
      gene_id: outcome.geneId || 'ad_hoc',
      signals: outcome.signals,
      status: outcome.status,
      score: outcome.score,
      summary: outcome.summary,
      sender_id: nodeId || undefined,
    });
    // Argv-array form avoids shell interpretation of apiKey, payload, or the
    // hub URL. Values cannot break out through shell metacharacters.
    const res = spawnSync('curl', [
      '-s', '-m', '8', '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${apiKey}`,
      '-d', payload,
      `${hubUrl.replace(/\/+$/, '')}/a2a/evolution/record`,
    ], {
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: MAX_EXEC_BUFFER,
      shell: false,
    });
    if (res.status !== 0 || res.error) return false;
    return true;
  } catch {
    return false;
  }
}

function recordToLocal(graphPath, outcome) {
  try {
    // Resolve the project dir once so the cwd tag and the workspace_id secret
    // share a single, consistent source (both must agree with the session-start
    // reader's resolveProjectDir()-based scoping).
    const projectDir = resolveProjectDir();
    const entry = {
      timestamp: new Date().toISOString(),
      gene_id: outcome.geneId || 'ad_hoc',
      signals: outcome.signals,
      outcome: {
        status: outcome.status,
        score: outcome.score,
        note: outcome.summary,
      },
      // Tag the originating workspace so the review-time reader in
      // collect.js can scope user-level fallback entries to the current
      // cwd. Without this, two unrelated projects sharing the user-level
      // fallback file (~/.evolver/memory/evolution/memory_graph.jsonl,
      // used by npm-global installs) would cross-pollinate each other's
      // review context — a prompt-injection / disclosure surface flagged
      // by Bugbot on PR #105 round-2.
      //
      // workspace_id is the forge-resistant tag (PR #108 round-3): the
      // reader compares it against the secret in the workspace's own
      // .evolver/workspace-id file. cwd is retained as a backward-compat
      // tag so older entries written before this hardening still pass
      // the cwd check.
      //
      // Use resolveProjectDir() (NOT process.cwd()) so the cwd tag records the
      // user's project, consistent with how the diff above is collected and
      // with the session-start reader's cwd fallback. Under Cursor, cwd is the
      // plugin install dir, so a raw process.cwd() tag would never match the
      // reader's resolveProjectDir()-derived currentDir — silently hiding every
      // cwd-only entry (Bugbot PR #555). collect.js only uses cwd as a legacy
      // fallback (disabled once a workspace_id secret exists), so changing the
      // tag's source — still a directory path — does not affect its scoping.
      cwd: projectDir,
      workspace_id: resolveWorkspaceId(undefined, projectDir),
      source: 'hook:session-end',
    };
    fs.appendFileSync(graphPath, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Append a single timestamped line to ~/.evolver/logs/evolution.log (or
// EVOLVER_HOOK_LOG_DIR). Best-effort: a log-write failure must never break the
// hook. Used both for recorded outcomes and for the "skipped, nothing to
// record" notices so a user can always see why a session did or did not
// produce an entry.
function appendEvolutionLog(line) {
  try {
    const logDir = process.env.EVOLVER_HOOK_LOG_DIR
      || path.join(os.homedir(), '.evolver', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'evolution.log'),
      `${new Date().toISOString()} ${line}\n`,
      'utf8'
    );
  } catch { /* best-effort, never break the hook on log write */ }
}

function main() {
  let inputData = '';
  let handled = false;
  let watchdog = null;
  const finish = (payload) => {
    if (handled) return;
    handled = true;
    if (watchdog) clearTimeout(watchdog);
    process.stdout.write(JSON.stringify(payload || {}));
    process.exit(0);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { inputData += chunk; });
  process.stdin.on('end', () => {
    if (handled) return;
    try {
      const diffInfo = getGitDiffStats();

      if (!diffInfo.hasChanges) {
        // No git diff means no signal source — session-end derives the
        // outcome (status/score/signals/summary) entirely from the diff, so
        // there is nothing meaningful to record. This is expected in a
        // non-git workspace or a repo with no changes this session. Rather
        // than fabricate an empty outcome (which would pollute the memory
        // graph), record nothing — but leave a log breadcrumb so the user
        // can tell "evolver ran but had nothing to record" apart from
        // "evolver never fired". (Previously this branch was fully silent.)
        const reason = diffInfo.isRepo
          ? 'no changes detected this session'
          : 'not a git workspace';
        appendEvolutionLog(`[Evolution] Session end: nothing recorded (${reason}).`);
        finish({});
        return;
      }

      const signals = detectSignals(diffInfo.diffSnippet);
      if (signals.length === 0) signals.push('stable_success_plateau');

      const hasErrors = signals.includes('log_error') || signals.includes('test_failure');
      const status = hasErrors ? 'failed' : 'success';
      const score = hasErrors ? 0.3 : 0.8;

      const outcome = {
        geneId: 'ad_hoc',
        signals,
        status,
        score,
        summary: `Session end: ${diffInfo.summary}. Signals: [${signals.join(', ')}]`,
      };

      const evolverRoot = findEvolverRoot();
      const graphPath = findMemoryGraph(evolverRoot);

      const hubOk = recordToHub(outcome);
      const localOk = graphPath ? recordToLocal(graphPath, outcome) : false;

      const target = hubOk ? 'Hub' : localOk ? 'local memory' : 'nowhere (no Hub or local path)';
      const msg = `[Evolution] Session outcome recorded to ${target}: ${outcome.summary}`;

      // Stop hook output schema (per Claude Code docs):
      //   - decision: "approve" | "block"
      //   - reason: string (shown when decision is set)
      //   - systemMessage: string (notification displayed to user)
      //   - continue: boolean
      //   - stopReason: string
      //
      // Earlier versions emitted `followup_message`, `stopMessage`, and
      // `additionalContext` together. `followup_message` is the field that
      // re-injects the receipt into Claude's next inference round, which
      // caused the agent to "respond" to its own evolution log line —
      // visible to users as an unexplained extra reasoning turn after
      // every task. The evolver is supposed to be observational, so we
      // now use `systemMessage` only — that surfaces the receipt to the
      // user without forcing another inference round.
      //
      // Cursor compatibility: Cursor's Claude Code-compatible runtime
      // currently treats `systemMessage` as a user prompt for the next
      // inference round. When we detect Cursor, omit systemMessage too.
      // The receipt is always appended to ~/.evolver/logs/evolution.log
      // so it is never silently lost; users can opt back in to the inline
      // notification with EVOLVER_HOOK_VERBOSE=1.
      appendEvolutionLog(msg);

      finish(isCursorHost() ? {} : { systemMessage: msg });
    } catch (e) {
      finish({});
    }
  });

  watchdog = setTimeout(() => finish({}), 7000);
}

main();
