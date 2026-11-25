// src/experiment/agentRunner.js
//
// The ONLY module in src/experiment that touches a subprocess. It runs a single
// arm of a comparison by invoking a headless coding-agent CLI -- by default
// `claude -p "<prompt>" --output-format json` -- and maps its JSON envelope
// onto the canonical AgentResult shape (duration / rounds / tokens / cost).
//
// Security: the prompt is passed as an argv element with shell:false, so quotes,
// `$`, backticks etc. in the task can never be interpreted by a shell (same
// injection posture as src/gep/validator/sandboxExecutor.js). Unlike the
// sandbox, the real user env IS passed through -- the agent CLI needs PATH and
// its own auth/credentials to run.
'use strict';

const { spawn } = require('child_process');

const DEFAULT_CMD = 'claude';
const DEFAULT_TIMEOUT_MS = 300000; // 5 min
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 1800000; // 30 min hard cap
const RESULT_CAP = 4000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10 MB — a JSON envelope is tiny; cap a chatty/malformed CLI before it OOMs.

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

function resolveAgentCommand(opts) {
  if (opts && opts.command) return String(opts.command);
  const env = process.env.EVOLVER_EXPERIMENT_AGENT_CMD;
  return env && env.trim() ? env.trim() : DEFAULT_CMD;
}

function resolveExtraArgs(opts) {
  if (opts && Array.isArray(opts.extraArgs)) return opts.extraArgs.map(String);
  const env = process.env.EVOLVER_EXPERIMENT_AGENT_ARGS;
  if (!env || !env.trim()) return [];
  return env.trim().split(/\s+/);
}

function resolveTimeout(opts) {
  let t = opts && Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : null;
  if (t == null) {
    const e = Number(process.env.EVOLVER_EXPERIMENT_TIMEOUT_MS);
    t = Number.isFinite(e) && e > 0 ? e : DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(MIN_TIMEOUT_MS, t), MAX_TIMEOUT_MS);
}

// Parse the `--output-format json` envelope. Tolerant of leading/trailing
// non-JSON noise by falling back to the outermost {...} slice.
function parseAgentJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) { /* fall through */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_) { /* fall through */ }
  }
  return null;
}

function makeFailure(error, command, extra) {
  return Object.assign(
    {
      ok: false,
      isError: true,
      error: error,
      durationMs: 0,
      rounds: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensTotal: 0,
      costUsd: 0,
      resultText: '',
      exitCode: -1,
      timedOut: false,
      runnerName: 'claude-cli',
      agentCommand: command,
    },
    extra || {},
  );
}

// Map a parsed `claude -p --output-format json` envelope onto AgentResult.
function mapAgentResult(json, ctx) {
  const command = ctx.command;
  const exitCode = num(ctx.exitCode, -1);
  const timedOut = !!ctx.timedOut;
  const usage = (json && json.usage) || {};
  const tokensIn = num(usage.input_tokens);
  const tokensOut = num(usage.output_tokens);
  const isError = !!(json && json.is_error);
  const ok = exitCode === 0 && !isError && !timedOut;
  let error = null;
  if (!ok) {
    if (timedOut) error = 'agent_timeout';
    else if (isError) error = 'agent_reported_error';
    else if (exitCode !== 0) error = 'agent_exit_' + exitCode;
  }
  // Prefer the agent's self-reported duration; fall back to wall-clock.
  const durationMs = json && Number.isFinite(Number(json.duration_ms))
    ? num(json.duration_ms)
    : num(ctx.durationMs);
  return {
    ok,
    isError,
    error,
    durationMs,
    rounds: num(json && json.num_turns),
    tokensIn,
    tokensOut,
    tokensTotal: tokensIn + tokensOut,
    costUsd: num(json && json.total_cost_usd),
    resultText: typeof (json && json.result) === 'string' ? json.result.slice(0, RESULT_CAP) : '',
    exitCode,
    timedOut,
    runnerName: 'claude-cli',
    agentCommand: command,
  };
}

/**
 * Run one task prompt through a headless agent CLI, then parse its complete
 * UTF-8 output after the output streams close.
 *
 * @param {string} prompt
 * @param {object} [opts] { command, extraArgs, timeoutMs, cwd }
 * @returns {Promise<AgentResult>} never rejects; failures resolve as { ok:false, error }
 */
function runAgentTask(prompt, opts) {
  opts = opts || {};
  const command = resolveAgentCommand(opts);
  const extraArgs = resolveExtraArgs(opts);
  const timeoutMs = resolveTimeout(opts);
  const cwd = opts.cwd || process.cwd();
  const argv = [...extraArgs, '-p', String(prompt == null ? '' : prompt), '--output-format', 'json'];

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let stdout = '';
    let stderr = '';
    const startedAt = Date.now();

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (child && !child.killed) {
        try { child.kill('SIGKILL'); } catch (_) { /* noop */ }
      }
      done(makeFailure('agent_timeout', command, {
        durationMs: Date.now() - startedAt,
        timedOut: true,
      }));
    }, timeoutMs);

    try {
      child = spawn(command, argv, {
        shell: false,
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      done(makeFailure('agent_spawn_failed: ' + (e && e.message ? e.message : String(e)), command));
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.length > MAX_STDOUT_BYTES) {
        // A well-behaved `--output-format json` envelope is tiny; this much
        // stdout means a runaway/malformed CLI — kill it rather than OOM.
        try { child.kill('SIGKILL'); } catch (_) { /* noop */ }
        done(makeFailure('agent_output_too_large', command, { durationMs: Date.now() - startedAt }));
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > MAX_STDOUT_BYTES) stderr = stderr.slice(-RESULT_CAP);
    });

    child.on('error', (err) => {
      const msg = err && err.code === 'ENOENT'
        ? 'agent_cli_not_found: ' + command
        : 'agent_spawn_error: ' + (err && err.message ? err.message : String(err));
      done(makeFailure(msg, command, { durationMs: Date.now() - startedAt }));
    });

    child.on('close', (code, signal) => {
      const durationMs = Date.now() - startedAt;
      // A signal-terminated child reports code=null, and Number(null) is 0 —
      // num(null, -1) would read it as a CLEAN exit and let a killed arm
      // score ok:true. Map null/undefined explicitly before the numeric path.
      const exitCode = (code === null || code === undefined) ? -1 : num(code, -1);
      const json = parseAgentJson(stdout);
      if (!json) {
        done(makeFailure(
          signal ? 'agent_killed_' + signal : 'agent_output_parse_failed', command, {
            durationMs,
            exitCode,
            resultText: String(stdout || stderr || '').slice(0, RESULT_CAP),
          }));
        return;
      }
      done(mapAgentResult(json, { exitCode, durationMs, timedOut: false, command }));
    });
  });
}

module.exports = {
  runAgentTask,
  parseAgentJson,
  mapAgentResult,
  resolveAgentCommand,
  resolveTimeout,
  DEFAULT_CMD,
};
