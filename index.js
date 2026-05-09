#!/usr/bin/env node
// Load .env BEFORE any internal require so that a2aProtocol and ATP
// modules see A2A_NODE_SECRET / A2A_NODE_ID / A2A_HUB_URL at first
// access and never fall back to a stale persisted/cached secret.
// Reported in #460.
//
// Load order matters (see #526): we must not call getRepoRoot() before
// .env is loaded, otherwise EVOLVER_REPO_ROOT set in .env is silently
// ignored because getRepoRoot() caches the .git-walk result on first
// call. Strategy:
//   1. Try .env at process.cwd() first. This is where a user running
//      `evolver` from their project root expects the file, and it is
//      independent of getRepoRoot() caching.
//   2. Read EVOLVER_REPO_ROOT from process.env (dotenv just populated it
//      if set in cwd/.env).
//   3. Only now call getRepoRoot(), which will honor EVOLVER_REPO_ROOT
//      if present; then try .env at that root as well (dotenv never
//      overwrites already-set keys, so step 1 wins when both exist).
try {
  const _path = require('path');
  // Step 1: load .env from process.cwd() before any internal require.
  // Matches the regression test for #460 which asserts
  // `require('dotenv').config` appears before any ./src/* require other
  // than ./src/gep/paths.
  require('dotenv').config({ path: _path.join(process.cwd(), '.env') });
  // Suppress the "Using host git repository at" banner during bootstrap.
  // If .env at the discovered root overrides EVOLVER_REPO_ROOT, the
  // initial banner would point at the wrong path and mislead users
  // debugging the very chicken-and-egg problem #526 reported. The banner
  // prints for real when getRepoRoot() is called later by application code.
  const _prevQuiet = process.env.EVOLVER_QUIET_PARENT_GIT;
  process.env.EVOLVER_QUIET_PARENT_GIT = '1';
  const { getRepoRoot: _getRepoRoot } = require('./src/gep/paths');
  const _root = _getRepoRoot();
  if (_root && _root !== process.cwd()) {
    require('dotenv').config({ path: _path.join(_root, '.env') });
  }
  if (_prevQuiet === undefined) delete process.env.EVOLVER_QUIET_PARENT_GIT;
  else process.env.EVOLVER_QUIET_PARENT_GIT = _prevQuiet;
} catch (e) { /* dotenv is optional */ }

const evolve = require('./src/evolve');
const { solidify } = require('./src/gep/solidify');
const path = require('path');
const { getRepoRoot } = require('./src/gep/paths');
const fs = require('fs');
const { spawn } = require('child_process');

function sleepMs(ms) {
  const n = parseInt(String(ms), 10);
  const t = Number.isFinite(n) ? Math.max(0, n) : 0;
  return new Promise(resolve => setTimeout(resolve, t));
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Mark a pending evolution run as rejected (state-only, no git rollback).
 * @param {string} statePath - Path to evolution_solidify_state.json
 * @returns {boolean} true if a pending run was found and rejected
 */
function rejectPendingRun(statePath) {
  try {
    const state = readJsonSafe(statePath);
    if (state && state.last_run && state.last_run.run_id) {
      state.last_solidify = {
        run_id: state.last_run.run_id,
        rejected: true,
        reason: 'loop_bridge_disabled_autoreject_no_rollback',
        timestamp: new Date().toISOString(),
      };
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, statePath);
      return true;
    }
  } catch (e) {
    console.warn('[Loop] Failed to clear pending run state: ' + (e.message || e));
  }

  return false;
}

function isPendingSolidify(state) {
  const lastRun = state && state.last_run ? state.last_run : null;
  const lastSolid = state && state.last_solidify ? state.last_solidify : null;
  if (!lastRun || !lastRun.run_id) return false;
  if (!lastSolid || !lastSolid.run_id) return true;
  return String(lastSolid.run_id) !== String(lastRun.run_id);
}

function parseMs(v, fallback) {
  const n = parseInt(String(v == null ? '' : v), 10);
  if (Number.isFinite(n)) return Math.max(0, n);
  return fallback;
}

function parseBoolEnv(v, fallback) {
  if (v == null) return fallback;
  const s = String(v).toLowerCase().trim();
  if (s === '' ) return fallback;
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true;
  return fallback;
}

class CycleTimeoutError extends Error {
  constructor(timeoutMs, phase, cycleNum) {
    super('Cycle hard-timeout exceeded after ' + timeoutMs + 'ms (cycle=' + cycleNum + ', phase=' + phase + ')');
    this.name = 'CycleTimeoutError';
    this.code = 'CYCLE_TIMEOUT';
    this.timeoutMs = timeoutMs;
    this.phase = phase;
    this.cycleNum = cycleNum;
  }
}

// Issue #528: on Windows, child_process.spawn(detached: true, windowsHide: true)
// allocates a new conhost window every time -- windowsHide is silently ignored
// in detached mode. So suicide-respawn (cycles >= max, RSS over budget, or the
// new cycle hard-timeout) opens a new cmd popup on every restart. We now skip
// the in-process detached spawn on Windows by default and rely on an external
// supervisor (feishu-evolver-wrapper >= 1.10.0, NSSM, pm2-windows, etc.) to
// respawn the daemon on non-zero exit. Users who insist can opt back in with
// EVOLVER_SUICIDE_WINDOWS=true (and accept the popups).
function spawnReplacementProcess({ reason, args, logPath }) {
  const isWindows = process.platform === 'win32';
  const allowOnWindows = parseBoolEnv(process.env.EVOLVER_SUICIDE_WINDOWS, false);
  if (isWindows && !allowOnWindows) {
    console.log(
      '[Daemon] Skipping in-process respawn on Windows (' + reason + '). ' +
      'Native Node spawn(detached, windowsHide) opens a cmd popup on every restart (Issue #528). ' +
      'Set EVOLVER_SUICIDE_WINDOWS=true to opt back in. ' +
      'Recommended: run evolver under feishu-evolver-wrapper >= 1.10.0, NSSM, or pm2-windows so the supervisor restarts on exit.'
    );
    return { spawned: false, reason: 'windows_default_skip' };
  }
  try {
    const logFd = fs.openSync(logPath, 'a');
    const spawnOpts = {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
      windowsHide: true,
    };
    const child = spawn(process.execPath, [__filename, ...args], spawnOpts);
    child.unref();
    return { spawned: true };
  } catch (e) {
    console.error('[Daemon] Spawn-replacement failed (' + reason + '): ' + (e && e.message || e));
    return { spawned: false, reason: 'spawn_error', error: e };
  }
}

// Atomic write of the cycle_progress.json file. Wrapper polls this file every
// 60s; if updated_at goes stale beyond EVOLVE_INNER_STUCK_TIMEOUT_SEC the
// wrapper treats the inner core as zombie and SIGKILLs it. See Issue #19 (the
// 22-day stuck-cycle incident) and the cross-repo timeout plan for context.
function writeCycleProgressAtomic(progressPath, fields) {
  try {
    const data = Object.assign({}, fields, { updated_at: Date.now() });
    const tmp = progressPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, progressPath);
    return true;
  } catch (e) {
    return false;
  }
}

function getLastSignals(statePath) {
  try {
    const st = readJsonSafe(statePath);
    return (st && st.last_run && Array.isArray(st.last_run.signals)) ? st.last_run.signals : [];
  } catch (e) {
    return [];
  }
}

// Singleton Guard - prevent multiple evolver daemon instances
function acquireLock() {
  const lockFile = path.join(__dirname, 'evolver.pid');
  try {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return true;
    } catch (exclErr) {
      if (exclErr.code !== 'EEXIST') throw exclErr;
    }
    const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      console.log('[Singleton] Corrupt lock file (invalid PID). Taking over.');
    } else {
      try {
        process.kill(pid, 0);
        console.log(`[Singleton] Evolver loop already running (PID ${pid}). Exiting.`);
        return false;
      } catch (e) {
        console.log(`[Singleton] Stale lock found (PID ${pid}). Taking over.`);
      }
    }
    fs.writeFileSync(lockFile, String(process.pid));
    return true;
  } catch (err) {
    console.error('[Singleton] Lock acquisition failed:', err);
    return false;
  }
}

function releaseLock() {
  const lockFile = path.join(__dirname, 'evolver.pid');
  try {
    if (fs.existsSync(lockFile)) {
       const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
       if (pid === process.pid) fs.unlinkSync(lockFile);
    }
  } catch (e) { /* ignore */ }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const isLoop = args.includes('--loop') || args.includes('--mad-dog');
  const isVerbose = args.includes('--verbose') || args.includes('-v') ||
    String(process.env.EVOLVER_VERBOSE || '').toLowerCase() === 'true';
  if (isVerbose) process.env.EVOLVER_VERBOSE = 'true';

  if (!command || command === 'run' || command === '/evolve' || isLoop) {
    if (isLoop) {
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;
        function ts() { return '[' + new Date().toISOString() + ']'; }
        console.log = (...args) => { originalLog.call(console, ts(), ...args); };
        console.warn = (...args) => { originalWarn.call(console, ts(), ...args); };
        console.error = (...args) => { originalError.call(console, ts(), ...args); };
    }

    console.log('Starting evolver...');

    // Preflight: fail fast if git is not on PATH. On Windows in particular
    // a missing git binary can cause evolver to hang silently (see #394),
    // because several cycle-critical steps shell out to git early (repo
    // resolution, diff, blast-radius). Catching this up front makes the
    // failure mode obvious.
    try {
      const { execSync } = require('child_process');
      execSync('git --version', { stdio: 'ignore', timeout: 5000 });
    } catch (_gitErr) {
      console.error('');
      console.error('[Preflight] Could not run "git --version". Evolver requires git to be installed and available on PATH.');
      console.error('[Preflight] On Windows: install Git from https://git-scm.com/download/win and make sure `git --version` works in a fresh terminal.');
      console.error('[Preflight] On macOS:   xcode-select --install  (or `brew install git`)');
      console.error('[Preflight] On Linux:   sudo apt-get install -y git  (or your distro equivalent)');
      console.error('');
      process.exit(1);
    }
    
    if (isLoop) {
        // Internal daemon loop (no wrapper required).
        if (!acquireLock()) process.exit(0);
        function shutdown() {
          releaseLock();
          try { require('./src/gep/a2aProtocol').stopEventStream(); } catch (e) {}
        }
        process.on('exit', shutdown);
        process.on('SIGINT', () => { shutdown(); process.exit(); });
        process.on('SIGTERM', () => { shutdown(); process.exit(); });
        process.on('uncaughtException', (err) => {
          console.error('[FATAL] Uncaught exception:', err && err.stack ? err.stack : String(err));
          releaseLock();
          process.exit(1);
        });
        let _unhandledRejectionCount = 0;
        process.on('unhandledRejection', (reason) => {
          _unhandledRejectionCount++;
          console.error('[FATAL] Unhandled promise rejection (' + _unhandledRejectionCount + '):', reason && reason.stack ? reason.stack : String(reason));
          if (_unhandledRejectionCount >= 5) {
            console.error('[FATAL] Too many unhandled rejections (' + _unhandledRejectionCount + '). Exiting to avoid corrupt state.');
            releaseLock();
            process.exit(1);
          }
        });

        process.env.EVOLVE_LOOP = 'true';
        if (!process.env.EVOLVE_BRIDGE) {
          process.env.EVOLVE_BRIDGE = 'false';
        }
        console.log(`Loop mode enabled (internal daemon, bridge=${process.env.EVOLVE_BRIDGE}, verbose=${isVerbose}).`);

        // Startup diagnostic: in daemon mode evolver consumes its own stdout
        // instead of handing `sessions_spawn(...)` directives to a host
        // runtime (OpenClaw). If the operator expects real-time agent assist
        // they are likely using the wrong mode; if they intend daemon mode
        // they still need AGENT_NAME / AGENT_SESSIONS_DIR pointing at a live
        // agent or the loop will just cycle on its own logs. Emit a single
        // warning at startup so "empty cycling" has a visible breadcrumb.
        try {
          const { diagnoseSessionSourceEmpty } = require('./src/evolve');
          const diag = diagnoseSessionSourceEmpty();
          const hasAnySource = diag.agentSessionsDirExists ||
            diag.cursorDirExists || diag.claudeDirExists || diag.codexDirExists ||
            Boolean(diag.cursorTranscriptsDir);
          if (!hasAnySource) {
            console.warn('[Daemon] No session sources detected at startup. Loop mode runs background self-maintenance but cannot observe a live agent without at least one of:');
            console.warn(`  - ~/.openclaw/agents/<AGENT_NAME>/sessions/ (current AGENT_NAME=${diag.agentName}, exists=${diag.agentSessionsDirExists})`);
            console.warn('  - ~/.cursor / ~/.claude / ~/.codex (IDE transcripts)');
            console.warn('  - EVOLVER_CURSOR_TRANSCRIPTS_DIR (explicit override)');
            if (diag.availableOpenClawAgents.length > 0) {
              console.warn(`  Available OpenClaw agents under ~/.openclaw/agents/: ${diag.availableOpenClawAgents.join(', ')}`);
              console.warn('  Set AGENT_NAME=<agent> or AGENT_SESSIONS_DIR=<abs path> to the one actually doing work.');
            }
            for (const hint of diag.hints) {
              console.warn(`  HINT: ${hint}`);
            }
            console.warn('  If you want real-time agent assist (not background self-maintenance), run `evolver run` from inside the agent session instead of `evolver --loop`.');
          }
        } catch (_diagErr) { /* diagnostics must never block startup */ }

        const { getEvolutionDir, getEvolverLogPath } = require('./src/gep/paths');
        const solidifyStatePath = path.join(getEvolutionDir(), 'evolution_solidify_state.json');
        const cycleProgressPath = path.join(getEvolutionDir(), 'cycle_progress.json');

        const minSleepMs = parseMs(process.env.EVOLVER_MIN_SLEEP_MS, 2000);
        const maxSleepMs = parseMs(process.env.EVOLVER_MAX_SLEEP_MS, 300000);
        const idleThresholdMs = parseMs(process.env.EVOLVER_IDLE_THRESHOLD_MS, 500);
        const pendingSleepMs = parseMs(
          process.env.EVOLVE_PENDING_SLEEP_MS ||
            process.env.EVOLVE_MIN_INTERVAL ||
            process.env.FEISHU_EVOLVER_INTERVAL,
          120000
        );

        const maxCyclesPerProcess = parseMs(process.env.EVOLVER_MAX_CYCLES_PER_PROCESS, 100) || 100;
        const maxRssMb = parseMs(process.env.EVOLVER_MAX_RSS_MB, 500) || 500;
        const suicideEnabled = String(process.env.EVOLVER_SUICIDE || '').toLowerCase() !== 'false';

        // Issue #19: hard timeout around evolve.run() to break out of zombie
        // cycles (e.g. unclosed socket / stuck LLM call). On timeout we throw
        // CycleTimeoutError, log diagnostic stderr, and force suicide-respawn
        // so the wrapper sees a fresh PID + cycle. Also write cycle_progress
        // every progressUpdateMs so the wrapper has a true heartbeat to poll.
        const cycleTimeoutEnabled = parseBoolEnv(process.env.EVOLVER_CYCLE_TIMEOUT_ENABLED, true);
        const cycleTimeoutMs = parseMs(process.env.EVOLVER_CYCLE_TIMEOUT_MS, 2700000); // 45 min default
        const progressUpdateMs = parseMs(process.env.EVOLVER_PROGRESS_UPDATE_MS, 60000); // 1 min default

        // Start hub heartbeat (keeps node alive independently of evolution cycles)
        try {
          if (process.env.EVOMAP_PROXY === '1' || process.env.A2A_TRANSPORT === 'mailbox') {
            const { startProxy } = require('./src/proxy');
            const proxyInfo = await startProxy({
              hubUrl: process.env.A2A_HUB_URL,
            });
            console.log('[Proxy] Started on ' + proxyInfo.url);
            const { registerMailboxTransport } = require('./src/gep/mailboxTransport');
            registerMailboxTransport();
            process.env.A2A_TRANSPORT = 'mailbox';
          } else {
            const a2a = require('./src/gep/a2aProtocol');
            try { a2a.startHeartbeat(); }
            catch (hbErr) { console.warn('[Heartbeat] startHeartbeat failed: ' + (hbErr && hbErr.message || hbErr)); }
            try { a2a.startEventStream(); }
            catch (ssErr) { console.warn('[SSE] startEventStream failed: ' + (ssErr && ssErr.message || ssErr)); }
          }
        } catch (e) {
          console.warn('[Heartbeat] Failed to start: ' + (e.message || e));
        }

        // Validator daemon: independent timer that fetches and executes
        // validation tasks regardless of the main evolve loop's idle gating.
        // Honors EVOLVER_VALIDATOR_ENABLED and the persisted feature flag.
        try {
          const { startValidatorDaemon } = require('./src/gep/validator');
          if (startValidatorDaemon()) {
            console.log('[ValidatorDaemon] started.');
          }
        } catch (vdErr) {
          console.warn('[ValidatorDaemon] failed to start: ' + (vdErr && vdErr.message || vdErr));
        }

        // ATP: auto-start merchant agent if enabled
        try {
          const { defaultHandler, merchantAgent } = require('./src/atp');
          const atpMode = defaultHandler.getAtpMode();
          if (atpMode === 'auto' || atpMode === 'on') {
            const hubUrl = process.env.A2A_HUB_URL || process.env.EVOMAP_HUB_URL || '';
            if (hubUrl) {
              const services = defaultHandler.resolveAtpServices();
              merchantAgent.start({
                services: services,
                onOrder: defaultHandler.defaultOrderHandler,
                pollMs: 30000,
              }).catch(function (atpErr) {
                console.warn('[ATP] merchantAgent.start failed: ' + (atpErr && atpErr.message || atpErr));
              });
            }
          }
        } catch (atpInitErr) {
          console.warn('[ATP] Auto-init failed: ' + (atpInitErr && atpInitErr.message || atpInitErr));
        }

        // ATP: capability-gap auto-buyer. Default ON as of ATP liquidity
        // unlock; disable with EVOLVER_ATP_AUTOBUY=off. Also starts the
        // merchant-side auto-deliver daemon so claimed ATP tasks actually
        // call submitDelivery and settle instead of expiring.
        try {
          try {
            const { runPrompt } = require('./src/atp/cliAutobuyPrompt');
            await runPrompt();
          } catch (promptErr) {
            console.warn('[ATP-AutoBuyer] first-run prompt failed: ' + (promptErr && promptErr.message || promptErr));
          }
          const autoBuyRaw = (process.env.EVOLVER_ATP_AUTOBUY || 'on').toLowerCase().trim();
          const autoBuyOn = autoBuyRaw !== 'off' && autoBuyRaw !== '0' && autoBuyRaw !== 'false';
          if (autoBuyOn) {
            const hubUrl = process.env.A2A_HUB_URL || process.env.EVOMAP_HUB_URL || '';
            if (hubUrl) {
              const { autoBuyer } = require('./src/atp');
              autoBuyer.start({
                dailyCap: Number(process.env.ATP_AUTOBUY_DAILY_CAP_CREDITS) || undefined,
                perOrderCap: Number(process.env.ATP_AUTOBUY_PER_ORDER_CAP_CREDITS) || undefined,
              });
            } else {
              console.warn('[ATP-AutoBuyer] autobuy enabled but no hub URL configured, skipping.');
            }
          }
          const autoDeliverRaw = (process.env.EVOLVER_ATP_AUTODELIVER || 'on').toLowerCase().trim();
          const autoDeliverOn = autoDeliverRaw !== 'off' && autoDeliverRaw !== '0' && autoDeliverRaw !== 'false';
          if (autoDeliverOn) {
            const hubUrl = process.env.A2A_HUB_URL || process.env.EVOMAP_HUB_URL || '';
            if (hubUrl) {
              const autoDeliver = require('./src/atp/autoDeliver');
              autoDeliver.start({
                pollMs: Number(process.env.ATP_AUTODELIVER_POLL_MS) || undefined,
              });
            } else {
              console.warn('[ATP-AutoDeliver] autodeliver enabled but no hub URL configured, skipping.');
            }
          }
        } catch (autoBuyInitErr) {
          console.warn('[ATP-AutoBuyer] Init failed: ' + (autoBuyInitErr && autoBuyInitErr.message || autoBuyInitErr));
        }

        // Hoist module refs used inside the loop to avoid repeated module lookups per cycle
        const idleScheduler = require('./src/gep/idleScheduler');
        const { shouldDistillFromFailures: shouldDF, autoDistillFromFailures: autoDF } = require('./src/gep/skillDistiller');
        const { tryExplore } = require('./src/gep/explore');

        let currentSleepMs = minSleepMs;
        let cycleCount = 0;

        while (true) {
          try {
          cycleCount += 1;

          // Ralph-loop gating: do not run a new cycle while previous run is pending solidify.
          const st0 = readJsonSafe(solidifyStatePath);
          if (isPendingSolidify(st0)) {
            await sleepMs(Math.max(pendingSleepMs, minSleepMs));
            continue;
          }

          const t0 = Date.now();
          let ok = false;
          // Issue #19: write progress at cycle start, refresh it every
          // progressUpdateMs (default 60s) while evolve.run() is active, and
          // wrap evolve.run() with Promise.race(timeout) so a hung internal
          // call cannot freeze the daemon for days.
          writeCycleProgressAtomic(cycleProgressPath, {
            pid: process.pid,
            outer_cycle: cycleCount,
            inner_cycle: cycleCount,
            started_at: t0,
            phase: 'evolve.run',
          });
          let progressTicker = null;
          if (progressUpdateMs > 0) {
            progressTicker = setInterval(function () {
              writeCycleProgressAtomic(cycleProgressPath, {
                pid: process.pid,
                outer_cycle: cycleCount,
                inner_cycle: cycleCount,
                started_at: t0,
                phase: 'evolve.run',
              });
            }, progressUpdateMs);
            if (typeof progressTicker.unref === 'function') progressTicker.unref();
          }
          let cycleTimeoutHandle = null;
          let cycleTimedOut = false;
          try {
            const evolvePromise = evolve.run();
            if (cycleTimeoutEnabled && cycleTimeoutMs > 0) {
              const timeoutPromise = new Promise(function (_, reject) {
                cycleTimeoutHandle = setTimeout(function () {
                  cycleTimedOut = true;
                  reject(new CycleTimeoutError(cycleTimeoutMs, 'evolve.run', cycleCount));
                }, cycleTimeoutMs);
                if (cycleTimeoutHandle && typeof cycleTimeoutHandle.unref === 'function') cycleTimeoutHandle.unref();
              });
              await Promise.race([evolvePromise, timeoutPromise]);
            } else {
              await evolvePromise;
            }
            ok = true;

            if (String(process.env.EVOLVE_BRIDGE || '').toLowerCase() === 'false') {
              const stAfterRun = readJsonSafe(solidifyStatePath);
              if (isPendingSolidify(stAfterRun)) {
                const cleared = rejectPendingRun(solidifyStatePath);
                if (cleared) {
                  console.warn('[Loop] Auto-rejected pending run because bridge is disabled in loop mode (state only, no rollback).');
                }
              }
            }
          } catch (error) {
            const msg = error && error.message ? String(error.message) : String(error);
            if (error && error.code === 'CYCLE_TIMEOUT') {
              console.error('[Daemon] ' + msg);
              if (progressTicker) { clearInterval(progressTicker); progressTicker = null; }
              if (cycleTimeoutHandle) { clearTimeout(cycleTimeoutHandle); cycleTimeoutHandle = null; }
              writeCycleProgressAtomic(cycleProgressPath, {
                pid: process.pid,
                outer_cycle: cycleCount,
                inner_cycle: cycleCount,
                started_at: t0,
                phase: 'cycle_timeout_respawn',
              });
              spawnReplacementProcess({
                reason: 'cycle_hard_timeout',
                args: args,
                logPath: getEvolverLogPath(),
              });
              releaseLock();
              process.exit(1);
            }
            console.error(`Evolution cycle failed: ${msg}`);
          } finally {
            if (progressTicker) { clearInterval(progressTicker); progressTicker = null; }
            if (cycleTimeoutHandle) { clearTimeout(cycleTimeoutHandle); cycleTimeoutHandle = null; }
          }
          const dt = Date.now() - t0;

          // Adaptive sleep: treat very fast cycles as "idle", backoff; otherwise reset to min.
          if (!ok || dt < idleThresholdMs) {
            currentSleepMs = Math.min(maxSleepMs, Math.max(minSleepMs, currentSleepMs * 2));
          } else {
            currentSleepMs = minSleepMs;
          }

          // OMLS-inspired idle scheduling: adjust sleep and trigger aggressive
          // operations (distillation, reflection) during detected idle windows.
          let omlsMultiplier = 1;
          try {
            const schedule = idleScheduler.getScheduleRecommendation();
            if (schedule.enabled && schedule.sleep_multiplier > 0) {
              omlsMultiplier = schedule.sleep_multiplier;
              if (schedule.should_distill) {
                try {
                  if (shouldDF()) {
                    const dfResult = autoDF();
                    if (dfResult && dfResult.ok) {
                      console.log('[OMLS] Idle-window failure distillation: ' + dfResult.gene.id);
                    }
                  }
                } catch (e) {
                  if (isVerbose) console.warn('[OMLS] Distill error: ' + (e.message || e));
                }
              }
              if (schedule.should_explore) {
                try {
                  const exploreResult = await tryExplore([], schedule, getRepoRoot());
                  if (exploreResult && exploreResult.signals && exploreResult.signals.length > 0) {
                    console.log('[OMLS] Explore discovered ' + exploreResult.signals.length + ' signals: ' + exploreResult.signals.slice(0, 5).join(', '));
                  }
                } catch (e) {
                  if (isVerbose) console.warn('[OMLS] Explore error: ' + (e.message || e));
                }
              }
              if (isVerbose && schedule.idle_seconds >= 0) {
                console.log(`[OMLS] idle=${schedule.idle_seconds}s intensity=${schedule.intensity} multiplier=${omlsMultiplier}`);
              }
            }
          } catch (e) {
            if (isVerbose) console.warn('[OMLS] Scheduler error: ' + (e.message || e));
          }

          // Suicide check (memory leak protection). On Windows the
          // in-process respawn opens a cmd popup (Issue #528), so by default
          // we delegate to an external supervisor by exiting with a non-zero
          // code instead. See spawnReplacementProcess() for the policy.
          if (suicideEnabled) {
            const memMb = process.memoryUsage().rss / 1024 / 1024;
            if (cycleCount >= maxCyclesPerProcess || memMb > maxRssMb) {
              console.log(`[Daemon] Restarting self (cycles=${cycleCount}, rssMb=${memMb.toFixed(0)})`);
              const result = spawnReplacementProcess({
                reason: 'max_cycles_or_rss',
                args: args,
                logPath: getEvolverLogPath(),
              });
              if (result.spawned) {
                releaseLock();
                process.exit(0);
              } else if (result.reason === 'windows_default_skip') {
                console.log('[Daemon] Exiting with code 1 to let external supervisor respawn.');
                releaseLock();
                process.exit(1);
              } else {
                // Non-Windows spawn error: keep the lock and fall through to
                // the next iteration of the loop instead of leaving the daemon
                // dead. This matches the pre-1.79.1 behavior where a failed
                // spawn was logged and the process continued running.
                console.error('[Daemon] Spawn failed, continuing current process.');
              }
            }
          }

          let saturationMultiplier = 1;
          try {
            const lastSignals = getLastSignals(solidifyStatePath);
            if (lastSignals.includes('force_steady_state')) {
              saturationMultiplier = 4;
              console.log('[Daemon] Saturation detected. Entering steady-state mode (4x sleep).');
            } else if (lastSignals.includes('evolution_saturation')) {
              saturationMultiplier = 2;
              console.log('[Daemon] Approaching saturation. Reducing evolution frequency (2x sleep).');
            }
          } catch (e) {
            if (isVerbose) console.warn('[Daemon] Saturation check error: ' + (e.message || e));
          }

          // Jitter to avoid lockstep restarts.
          const jitter = Math.floor(Math.random() * 250);
          const totalSleepMs = Math.max(minSleepMs, (currentSleepMs + jitter) * saturationMultiplier * omlsMultiplier);
          if (isVerbose) {
            const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
            const signals = getLastSignals(solidifyStatePath).join(',');
            console.log(`[Verbose] cycle=${cycleCount} ok=${ok} dt=${dt}ms sleep=${totalSleepMs}ms (base=${currentSleepMs} jitter=${jitter} sat=${saturationMultiplier}x) rss=${memMb}MB signals=[${signals}]`);
          }
          writeCycleProgressAtomic(cycleProgressPath, {
            pid: process.pid,
            outer_cycle: cycleCount,
            inner_cycle: cycleCount,
            started_at: t0,
            phase: 'sleep',
          });
          await sleepMs(totalSleepMs);

          } catch (loopErr) {
            console.error('[Daemon] Unexpected loop error (recovering): ' + (loopErr && loopErr.message ? loopErr.message : String(loopErr)));
            await sleepMs(Math.max(minSleepMs, 10000));
          }
        }
    } else {
        // Normal Single Run
        try {
            await evolve.run();
        } catch (error) {
            console.error('Evolution failed:', error);
            process.exit(1);
        }
    }

    // Post-run hint
    console.log('\n' + '=======================================================');
    console.log('Evolver finished. If you use this project, consider starring the upstream repository.');
    console.log('Upstream: https://github.com/EvoMap/evolver');
    console.log('=======================================================\n');
    
  } else if (command === 'solidify') {
    const dryRun = args.includes('--dry-run');
    const noRollback = args.includes('--no-rollback');
    const intentFlag = args.find(a => typeof a === 'string' && a.startsWith('--intent='));
    const summaryFlag = args.find(a => typeof a === 'string' && a.startsWith('--summary='));
    const intent = intentFlag ? intentFlag.slice('--intent='.length) : null;
    const summary = summaryFlag ? summaryFlag.slice('--summary='.length) : null;

    try {
      const res = solidify({
        intent: intent || undefined,
        summary: summary || undefined,
        dryRun,
        rollbackOnFailure: !noRollback,
      });
      const st = res && res.ok ? 'SUCCESS' : 'FAILED';
      console.log(`[SOLIDIFY] ${st}`);
      if (res && res.gene) console.log(JSON.stringify(res.gene, null, 2));
      if (res && res.event) console.log(JSON.stringify(res.event, null, 2));
      if (res && res.capsule) console.log(JSON.stringify(res.capsule, null, 2));

      if (res && res.ok && !dryRun) {
        try {
          const { shouldDistill, prepareDistillation, autoDistill, shouldDistillFromFailures, autoDistillFromFailures } = require('./src/gep/skillDistiller');
          const { readStateForSolidify } = require('./src/gep/solidify');
          const solidifyState = readStateForSolidify();
          const count = solidifyState.solidify_count || 0;
          const autoDistillInterval = 5;
          const autoTrigger = count > 0 && count % autoDistillInterval === 0;

          if (autoTrigger || shouldDistill()) {
            const auto = autoDistill();
            if (auto && auto.ok && auto.gene) {
              console.log('[Distiller] Auto-distilled gene: ' + auto.gene.id);
            } else {
              const dr = prepareDistillation();
              if (dr && dr.ok && dr.promptPath) {
                const trigger = autoTrigger ? `auto (every ${autoDistillInterval} solidifies, count=${count})` : 'threshold';
                console.log('\n[DISTILL_REQUEST]');
                console.log(`Distillation triggered: ${trigger}`);
                console.log('Read the prompt file, process it with your LLM,');
                console.log('save the LLM response to a file, then run:');
                console.log('  node index.js distill --response-file=<path_to_llm_response>');
                console.log('Prompt file: ' + dr.promptPath);
                console.log('[/DISTILL_REQUEST]');
              }
            }
          }

          if (shouldDistillFromFailures()) {
            const failureResult = autoDistillFromFailures();
            if (failureResult && failureResult.ok && failureResult.gene) {
              console.log('[Distiller] Repair gene distilled from failures: ' + failureResult.gene.id);
            }
          }
        } catch (e) {
          console.warn('[Distiller] Init failed (non-fatal): ' + (e.message || e));
        }
      }

      if (res && res.hubReviewPromise) {
        await res.hubReviewPromise;
      }

      // Post-solidify urgent questions: when solidify fails or produces a
      // low-quality outcome, generate questions and send them to Hub immediately.
      if (!dryRun) {
        try {
          const { generateUrgentQuestions } = require('./src/gep/questionGenerator');
          const { fetchTasks } = require('./src/gep/taskReceiver');
          const urgentOpts = {};

          if (!res || !res.ok) {
            if (res && res.validation && !res.validation.ok) {
              urgentOpts.validationFailed = true;
              const failedStep = res.validation.results && res.validation.results.find(function (r) { return !r.ok; });
              urgentOpts.validationErrors = failedStep ? (failedStep.err || failedStep.cmd || '') : '';
            }
            urgentOpts.geneId = res && res.gene ? res.gene.id : undefined;
            const evtOutcome = res && res.event && res.event.outcome;
            if (evtOutcome && typeof evtOutcome.score === 'number' && evtOutcome.score < 0.3) {
              urgentOpts.lowConfidence = true;
              urgentOpts.confidenceScore = evtOutcome.score;
              urgentOpts.intent = res.event.intent;
            }
            if (res && res.blast && res.blast.files === 0 && res.blast.lines === 0) {
              urgentOpts.zeroBlastRadius = true;
              urgentOpts.hadSignals = true;
              urgentOpts.signals = res.event && Array.isArray(res.event.signals) ? res.event.signals : [];
            }
            if (res && res.constraintCheck && Array.isArray(res.constraintCheck.violations)) {
              const llmRejectV = res.constraintCheck.violations.find(function (v) { return String(v).startsWith('llm_review_rejected'); });
              if (llmRejectV) {
                urgentOpts.llmReviewRejected = true;
                urgentOpts.llmReviewReason = String(llmRejectV).replace('llm_review_rejected: ', '');
              }
            }
            const lr = readJsonSafe(path.join(require('./src/gep/paths').getEvolutionDir(), 'evolution_solidify_state.json'));
            if (lr && lr.last_run && lr.last_run.active_task_id) {
              urgentOpts.taskCompletionFailed = true;
              urgentOpts.taskTitle = lr.last_run.active_task_title || '';
              urgentOpts.taskSignals = Array.isArray(lr.last_run.task_signals) ? lr.last_run.task_signals.join(', ') : '';
            }
          } else if (res.event && res.event.outcome && res.event.outcome.score < 0.3) {
            urgentOpts.lowConfidence = true;
            urgentOpts.confidenceScore = res.event.outcome.score;
            urgentOpts.intent = res.event.intent;
          }

          if (Object.keys(urgentOpts).length > 0) {
            const urgentQs = generateUrgentQuestions(urgentOpts);
            if (urgentQs.length > 0) {
              console.log('[UrgentQ] Generated ' + urgentQs.length + ' urgent question(s) from solidify outcome.');
              try {
                const fetchRes = await fetchTasks({ questions: urgentQs });
                if (fetchRes.questions_created) {
                  const accepted = fetchRes.questions_created.filter(function (q) { return !q.error; });
                  if (accepted.length > 0) {
                    console.log('[UrgentQ] Hub accepted ' + accepted.length + ' urgent question(s) as bounties.');
                  }
                }
              } catch (err) {
                console.log('[UrgentQ] Send failed (non-fatal): ' + (err && err.message ? err.message : err));
              }
            }
          }
        } catch (e) {
          console.log('[UrgentQ] Init failed (non-fatal): ' + (e && e.message ? e.message : e));
        }
      }

      process.exit(res && res.ok ? 0 : 2);
    } catch (error) {
      console.error('[SOLIDIFY] Error:', error);
      process.exit(2);
    }
  } else if (command === 'distill') {
    const responseFileFlag = args.find(a => typeof a === 'string' && a.startsWith('--response-file='));
    if (!responseFileFlag) {
      console.error('Usage: node index.js distill --response-file=<path>');
      process.exit(1);
    }
    const responseFilePath = responseFileFlag.slice('--response-file='.length);
    {
      const { getRepoRoot } = require('./src/gep/paths');
      const resolvedResponsePath = path.resolve(responseFilePath);
      const resolvedRepoRoot = path.resolve(getRepoRoot());
      if (responseFilePath.includes('..') || !resolvedResponsePath.startsWith(resolvedRepoRoot)) {
        console.error('[Distill] ERROR: Invalid response-file path "' + responseFilePath + '" - path traversal detected or path is outside the repository.');
        process.exit(2);
      }
    }
    try {
      const responseText = fs.readFileSync(responseFilePath, 'utf8');
      const { completeDistillation } = require('./src/gep/skillDistiller');
      const result = completeDistillation(responseText);
      if (result && result.ok) {
        console.log('[Distiller] Gene produced: ' + result.gene.id);
        console.log(JSON.stringify(result.gene, null, 2));
      } else {
        console.warn('[Distiller] Distillation did not produce a gene: ' + (result && result.reason || 'unknown'));
      }
      process.exit(result && result.ok ? 0 : 2);
    } catch (error) {
      console.error('[DISTILL] Error:', error);
      process.exit(2);
    }

  } else if (command === 'review' || command === '--review') {
    const { getEvolutionDir, getRepoRoot } = require('./src/gep/paths');
    const { loadGenes } = require('./src/gep/assetStore');
    const { execSync } = require('child_process');
    const MAX_EXEC_BUFFER = 10 * 1024 * 1024; // 10MB; see GHSA reports / #451

    const statePath = path.join(getEvolutionDir(), 'evolution_solidify_state.json');
    const state = readJsonSafe(statePath);
    const lastRun = state && state.last_run ? state.last_run : null;

    if (!lastRun || !lastRun.run_id) {
      console.log('[Review] No pending evolution run to review.');
      console.log('Run "node index.js run" first to produce changes, then review before solidifying.');
      process.exit(0);
    }

    const lastSolid = state && state.last_solidify ? state.last_solidify : null;
    if (lastSolid && String(lastSolid.run_id) === String(lastRun.run_id)) {
      console.log('[Review] Last run has already been solidified. Nothing to review.');
      process.exit(0);
    }

    const repoRoot = getRepoRoot();
    let diff = '';
    try {
      const unstaged = execSync('git diff', { cwd: repoRoot, encoding: 'utf8', timeout: 30000, maxBuffer: MAX_EXEC_BUFFER }).trim();
      const staged = execSync('git diff --cached', { cwd: repoRoot, encoding: 'utf8', timeout: 30000, maxBuffer: MAX_EXEC_BUFFER }).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', { cwd: repoRoot, encoding: 'utf8', timeout: 10000, maxBuffer: MAX_EXEC_BUFFER }).trim();
      if (staged) diff += '=== Staged Changes ===\n' + staged + '\n\n';
      if (unstaged) diff += '=== Unstaged Changes ===\n' + unstaged + '\n\n';
      if (untracked) diff += '=== Untracked Files ===\n' + untracked + '\n';
    } catch (e) {
      diff = '(failed to capture diff: ' + (e.message || e) + ')';
    }

    const genes = loadGenes();
    const geneId = lastRun.selected_gene_id ? String(lastRun.selected_gene_id) : null;
    const gene = geneId ? genes.find(g => g && g.type === 'Gene' && g.id === geneId) : null;
    const signals = Array.isArray(lastRun.signals) ? lastRun.signals : [];
    const mutation = lastRun.mutation || null;

    console.log('\n' + '='.repeat(60));
    console.log('[Review] Pending evolution run: ' + lastRun.run_id);
    console.log('='.repeat(60));
    console.log('\n--- Gene ---');
    if (gene) {
      console.log('  ID:       ' + gene.id);
      console.log('  Category: ' + (gene.category || '?'));
      console.log('  Summary:  ' + (gene.summary || '?'));
      if (Array.isArray(gene.strategy) && gene.strategy.length > 0) {
        console.log('  Strategy:');
        gene.strategy.forEach((s, i) => console.log('    ' + (i + 1) + '. ' + s));
      }
    } else {
      console.log('  (no gene selected or gene not found: ' + (geneId || 'none') + ')');
    }

    console.log('\n--- Signals ---');
    if (signals.length > 0) {
      signals.forEach(s => console.log('  - ' + s));
    } else {
      console.log('  (no signals)');
    }

    console.log('\n--- Mutation ---');
    if (mutation) {
      console.log('  Category:   ' + (mutation.category || '?'));
      console.log('  Risk Level: ' + (mutation.risk_level || '?'));
      if (mutation.rationale) console.log('  Rationale:  ' + mutation.rationale);
    } else {
      console.log('  (no mutation data)');
    }

    if (lastRun.blast_radius_estimate) {
      console.log('\n--- Blast Radius Estimate ---');
      const br = lastRun.blast_radius_estimate;
      console.log('  Files changed: ' + (br.files_changed || '?'));
      console.log('  Lines changed: ' + (br.lines_changed || '?'));
    }

    console.log('\n--- Diff ---');
    if (diff.trim()) {
      console.log(diff.length > 5000 ? diff.slice(0, 5000) + '\n... (truncated, ' + diff.length + ' chars total)' : diff);
    } else {
      console.log('  (no changes detected)');
    }
    console.log('='.repeat(60));

    if (args.includes('--approve')) {
      console.log('\n[Review] Approved. Running solidify...\n');
      try {
        const res = solidify({
          intent: lastRun.intent || undefined,
          rollbackOnFailure: true,
        });
        const st = res && res.ok ? 'SUCCESS' : 'FAILED';
        console.log(`[SOLIDIFY] ${st}`);
        if (res && res.gene) console.log(JSON.stringify(res.gene, null, 2));
        if (res && res.hubReviewPromise) {
          await res.hubReviewPromise;
        }
        process.exit(res && res.ok ? 0 : 2);
      } catch (error) {
        console.error('[SOLIDIFY] Error:', error);
        process.exit(2);
      }
    } else if (args.includes('--reject')) {
      console.log('\n[Review] Rejected. Rolling back changes...');
      try {
        execSync('git checkout -- .', { cwd: repoRoot, encoding: 'utf8', timeout: 30000, maxBuffer: MAX_EXEC_BUFFER });
        // Preserve user state on reject: .env files, node_modules, runtime
        // PID files, and a dedicated workspace/ dir (if one exists) MUST NOT
        // be wiped by an automated rollback. Users have reported losing
        // secrets and runtime caches to an aggressive git clean.
        execSync('git clean -fd -e node_modules -e workspace -e .env -e ".env.*" -e "*.pid"', {
          cwd: repoRoot, encoding: 'utf8', timeout: 30000, maxBuffer: MAX_EXEC_BUFFER,
        });
        const evolDir = getEvolutionDir();
        const sp = path.join(evolDir, 'evolution_solidify_state.json');
        if (fs.existsSync(sp)) {
          const s = readJsonSafe(sp);
          if (s && s.last_run) {
            s.last_solidify = { run_id: s.last_run.run_id, rejected: true, timestamp: new Date().toISOString() };
            const tmpReject = `${sp}.tmp`;
            fs.writeFileSync(tmpReject, JSON.stringify(s, null, 2) + '\n', 'utf8');
            fs.renameSync(tmpReject, sp);
          }
        }
        console.log('[Review] Changes rolled back.');
      } catch (e) {
        console.error('[Review] Rollback failed:', e.message || e);
        process.exit(2);
      }
    } else {
      console.log('\nTo approve and solidify:  node index.js review --approve');
      console.log('To reject and rollback:   node index.js review --reject');
    }

  } else if (command === 'fetch') {
    let skillId = null;
    const eqFlag = args.find(a => typeof a === 'string' && (a.startsWith('--skill=') || a.startsWith('-s=')));
    if (eqFlag) {
      skillId = eqFlag.split('=').slice(1).join('=');
    } else {
      const sIdx = args.indexOf('-s');
      const longIdx = args.indexOf('--skill');
      const flagIdx = sIdx !== -1 ? sIdx : longIdx;
      if (flagIdx !== -1 && args[flagIdx + 1] && !String(args[flagIdx + 1]).startsWith('-')) {
        skillId = args[flagIdx + 1];
      }
    }
    if (!skillId) {
      const positional = args[1];
      if (positional && !String(positional).startsWith('-')) skillId = positional;
    }

    if (!skillId) {
      console.error('Usage: evolver fetch --skill <skill_id>');
      console.error('       evolver fetch -s <skill_id>');
      process.exit(1);
    }

    const { getHubUrl, getNodeId, buildHubHeaders, sendHelloToHub, getHubNodeSecret } = require('./src/gep/a2aProtocol');

    const hubUrl = getHubUrl();
    if (!hubUrl) {
      console.error('[fetch] A2A_HUB_URL is not configured.');
      console.error('Set it via environment variable or .env file:');
      console.error('  export A2A_HUB_URL=https://evomap.ai');
      process.exit(1);
    }

    try {
      if (!getHubNodeSecret()) {
        console.log('[fetch] No node_secret found. Sending hello to Hub to register...');
        const helloResult = await sendHelloToHub();
        if (!helloResult || !helloResult.ok) {
          console.error('[fetch] Failed to register with Hub:', helloResult && helloResult.error || 'unknown');
          process.exit(1);
        }
        console.log('[fetch] Registered as ' + getNodeId());
      }

      const endpoint = hubUrl.replace(/\/+$/, '') + '/a2a/skill/store/' + encodeURIComponent(skillId) + '/download';
      const nodeId = getNodeId();

      console.log('[fetch] Downloading skill: ' + skillId);

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: buildHubHeaders(),
        body: JSON.stringify({ sender_id: nodeId }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        let errorDetail = '';
        let errorCode = '';
        try {
          const j = JSON.parse(body);
          errorDetail = j.detail || j.message || j.error || '';
          errorCode = j.error || j.code || '';
        } catch (_) {
          errorDetail = body ? body.slice(0, 500) : '';
        }
        console.error('[fetch] Download failed (HTTP ' + resp.status + ')' + (errorCode ? ': ' + errorCode : ''));
        if (errorDetail && errorDetail !== errorCode) {
          console.error('  Detail: ' + errorDetail);
        }
        if (resp.status === 404) {
          console.error('  Skill "' + skillId + '" not found or not publicly available.');
          console.error('  Check the skill ID spelling, or browse available skills at https://evomap.ai');
        } else if (resp.status === 401 || resp.status === 403) {
          console.error('  Authentication failed. Try:');
          console.error('    1. Delete ~/.evomap/node_secret and retry');
          console.error('    2. Re-register: set A2A_NODE_ID and run fetch again');
        } else if (resp.status === 402) {
          console.error('  Insufficient credits. Check your balance at https://evomap.ai');
        } else if (resp.status >= 500) {
          console.error('  Server error. The Hub may be temporarily unavailable.');
          console.error('  Try again in a few minutes. If the issue persists, report at:');
          console.error('    https://github.com/autogame-17/evolver/issues');
        }
        if (isVerbose) {
          console.error('[Verbose] Endpoint: ' + endpoint);
          console.error('[Verbose] Status: ' + resp.status + ' ' + (resp.statusText || ''));
          console.error('[Verbose] Response body: ' + (body || '(empty)').slice(0, 2000));
        }
        process.exit(1);
      }

      const data = await resp.json();
      const outFlag = args.find(a => typeof a === 'string' && a.startsWith('--out='));
      const safeId = String(data.skill_id || skillId).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      // Reject safeId values that would either stay inside cwd instead of
      // descending into skills/, or escape cwd entirely. The sanitizing regex
      // above permits `.`, so `..` / `.` / empty survive it; `path.join('.',
      // 'skills', '..')` collapses to `.` which turns the download directory
      // into the user's working directory and lets Hub-supplied bundled_files
      // overwrite `index.js`, `package.json`, etc. See GHSA-cfcj-hqpf-hccf.
      if (
        safeId === '' ||
        safeId === '.' ||
        safeId === '..' ||
        safeId.includes('/') ||
        safeId.includes('\\') ||
        safeId.includes('\0')
      ) {
        console.error('[fetch] Hub returned an invalid skill_id: ' + JSON.stringify(safeId));
        process.exit(1);
      }
      let outDir;
      if (outFlag) {
        const rawOut = outFlag.slice('--out='.length);
        if (!rawOut || rawOut.trim() === '') {
          console.error('[fetch] --out= value cannot be empty');
          process.exit(1);
        }
        const resolvedOut = path.resolve(process.cwd(), rawOut);
        const cwd = path.resolve(process.cwd());
        const rel = path.relative(cwd, resolvedOut);
        // Reject paths that escape the current working directory or are
        // absolute on a different volume/root. This prevents --out=../../etc
        // from writing outside the project tree.
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          console.error('[fetch] --out= must resolve to a path inside the current working directory');
          console.error('  Provided:  ' + rawOut);
          console.error('  Resolved:  ' + resolvedOut);
          console.error('  Workdir:   ' + cwd);
          process.exit(1);
        }
        outDir = resolvedOut;
      } else {
        // Defense in depth: apply the same traversal check to the default
        // branch so any remaining path-smuggling shape in `safeId` is caught.
        const candidate = path.resolve(process.cwd(), 'skills', safeId);
        const skillsRoot = path.resolve(process.cwd(), 'skills');
        const rel = path.relative(skillsRoot, candidate);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          console.error('[fetch] Hub-provided skill_id escapes skills/ directory: ' + JSON.stringify(safeId));
          process.exit(1);
        }
        outDir = candidate;
      }

      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

      if (data.content) {
        fs.writeFileSync(path.join(outDir, 'SKILL.md'), data.content, 'utf8');
      }

      const ALLOWED_SKILL_EXTENSIONS = new Set([
        '.js', '.mjs', '.cjs', '.ts',
        '.json', '.md', '.txt',
        '.sh', '.py',
        '.yml', '.yaml',
      ]);
      const MAX_SKILL_FILE_BYTES = 512 * 1024;
      // Even with outDir locked to skills/, a legitimate-looking skill can
      // ship a bundled file named `package.json`, `index.js`, or any other
      // top-level project artifact whose name collides with something the
      // user may later copy back up. Prefix-guard the resolved path so every
      // write stays strictly within the resolved outDir (no trailing `/..`
      // in basename, no absolute path smuggling) and never points at cwd.
      const resolvedOutDir = path.resolve(outDir);
      const resolvedCwd = path.resolve(process.cwd());

      const bundled = Array.isArray(data.bundled_files) ? data.bundled_files : [];
      const skippedFiles = [];
      for (const file of bundled) {
        if (!file || !file.name || typeof file.content !== 'string') continue;
        const safeName = path.basename(file.name);
        if (!safeName || safeName === '.' || safeName === '..') {
          skippedFiles.push(String(file.name));
          continue;
        }
        const ext = path.extname(safeName).toLowerCase();
        if (!ALLOWED_SKILL_EXTENSIONS.has(ext)) {
          console.warn('[fetch] Skipped skill file with disallowed extension: ' + safeName);
          skippedFiles.push(safeName);
          continue;
        }
        if (Buffer.byteLength(file.content, 'utf8') > MAX_SKILL_FILE_BYTES) {
          console.warn('[fetch] Skipped skill file exceeding ' + MAX_SKILL_FILE_BYTES + ' bytes: ' + safeName);
          skippedFiles.push(safeName);
          continue;
        }
        const destPath = path.resolve(resolvedOutDir, safeName);
        const relToOut = path.relative(resolvedOutDir, destPath);
        if (relToOut.startsWith('..') || path.isAbsolute(relToOut)) {
          console.warn('[fetch] Skipped bundled file whose resolved path escapes outDir: ' + safeName);
          skippedFiles.push(safeName);
          continue;
        }
        // Never let a bundled write touch the evolver's own cwd -- this is
        // the concrete attack shape from GHSA-cfcj-hqpf-hccf (fetch default
        // branch writing to `./index.js`). outDir should always be under
        // skills/ now, but belt-and-braces keep the guarantee explicit.
        if (path.dirname(destPath) === resolvedCwd) {
          console.warn('[fetch] Skipped bundled file that would land in cwd: ' + safeName);
          skippedFiles.push(safeName);
          continue;
        }
        fs.writeFileSync(destPath, file.content, 'utf8');
      }

      console.log('[fetch] Skill downloaded to: ' + outDir);
      console.log('  Name:    ' + (data.name || skillId));
      console.log('  Version: ' + (data.version || '?'));
      console.log('  Files:   SKILL.md' + (bundled.length > 0 ? ', ' + bundled.map(f => f.name).join(', ') : ''));
      if (data.already_purchased) {
        console.log('  Fetch cost: free (already purchased)');
      } else {
        console.log('  Fetch cost: ' + (data.credit_cost || 0) + ' credits');
      }
    } catch (error) {
      if (error && error.name === 'TimeoutError') {
        console.error('[fetch] Request timed out (30s). Check your network and A2A_HUB_URL.');
        console.error('  Hub URL: ' + hubUrl);
      } else {
        console.error('[fetch] Error: ' + (error && error.message || error));
        if (error && error.cause) console.error('  Cause: ' + (error.cause.message || error.cause.code || error.cause));
        if (isVerbose && error && error.stack) console.error('[Verbose] Stack:\n' + error.stack);
      }
      process.exit(1);
    }

  } else if (command === 'sync') {
    const { getHubUrl, getNodeId, buildHubHeaders, sendHelloToHub, getHubNodeSecret } = require('./src/gep/a2aProtocol');
    const { upsertGene, upsertCapsule, loadGenes, loadCapsules } = require('./src/gep/assetStore');
    const { getGepAssetsDir, getMemoryDir } = require('./src/gep/paths');

    const hubUrl = getHubUrl();
    if (!hubUrl) {
      console.error('[sync] A2A_HUB_URL is not configured.');
      process.exit(1);
    }

    try {
      if (!getHubNodeSecret()) {
        console.log('[sync] No node_secret found. Sending hello to Hub to register...');
        const helloResult = await sendHelloToHub();
        if (!helloResult || !helloResult.ok) {
          console.error('[sync] Failed to register with Hub:', helloResult && helloResult.error || 'unknown');
          process.exit(1);
        }
        console.log('[sync] Registered as ' + getNodeId());
      }

      const nodeId = getNodeId();
      const baseUrl = hubUrl.replace(/\/+$/, '');
      const typeFilter = (function () {
        const f = args.find(function (a) { return typeof a === 'string' && a.startsWith('--type='); });
        return f ? f.slice('--type='.length) : null;
      })();
      const scopeArg = (function () {
        const f = args.find(function (a) { return typeof a === 'string' && a.startsWith('--scope='); });
        return f ? f.slice('--scope='.length) : 'all';
      })();
      const statusFilter = (function () {
        const f = args.find(function (a) { return typeof a === 'string' && a.startsWith('--status='); });
        return f ? f.slice('--status='.length) : null;
      })();
      const exportPath = (function () {
        const f = args.find(function (a) { return typeof a === 'string' && a.startsWith('--export='); });
        return f ? f.slice('--export='.length) : null;
      })();
      const dryRun = args.includes('--dry-run');
      const listUnpublished = !args.includes('--no-unpublished-list');
      const force = args.includes('--force');
      const limitPerPage = 100;

      const validScopes = new Set(['all', 'purchased', 'published']);
      if (!validScopes.has(scopeArg)) {
        console.error('[sync] Invalid --scope=' + scopeArg + '. Expected: all, purchased, published.');
        process.exit(1);
      }
      const doPurchased = scopeArg === 'all' || scopeArg === 'purchased';
      const doPublished = scopeArg === 'all' || scopeArg === 'published';

      async function fetchAllPages(endpoint, extraParams) {
        const out = [];
        let cursor = null;
        let page = 0;
        while (true) {
          page++;
          let url = baseUrl + endpoint + '?node_id=' + encodeURIComponent(nodeId) + '&limit=' + limitPerPage;
          if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
          if (typeFilter) url += '&type=' + encodeURIComponent(typeFilter);
          if (extraParams) {
            for (const [k, v] of Object.entries(extraParams)) {
              if (v != null) url += '&' + k + '=' + encodeURIComponent(v);
            }
          }
          const resp = await fetch(url, {
            method: 'GET',
            headers: buildHubHeaders(),
            signal: AbortSignal.timeout(30000),
          });
          if (!resp.ok) {
            const body = await resp.text().catch(function () { return ''; });
            throw new Error('Hub HTTP ' + resp.status + ' on ' + endpoint + ': ' + body.slice(0, 500));
          }
          const data = await resp.json();
          if (Array.isArray(data.assets)) out.push.apply(out, data.assets);
          if (isVerbose) console.log('[sync]   ' + endpoint + ' page ' + page + ': ' + (data.count || 0) + ' (total ' + out.length + ')');
          if (data.has_more && data.next_cursor) cursor = data.next_cursor;
          else break;
        }
        return out;
      }

      let purchasedAssets = [];
      let publishedAssets = [];

      if (doPurchased) {
        console.log('[sync] Fetching purchased assets from Hub...');
        purchasedAssets = await fetchAllPages('/a2a/assets/purchased');
        console.log('[sync]   purchased: ' + purchasedAssets.length + ' asset(s)');
      }
      if (doPublished) {
        console.log('[sync] Fetching published-by-me assets from Hub (includes drafts)...');
        publishedAssets = await fetchAllPages('/a2a/assets/published-by-me', { status: statusFilter });
        console.log('[sync]   published: ' + publishedAssets.length + ' asset(s)');
      }

      const seen = new Set();
      const allAssets = [];
      for (const src of [purchasedAssets, publishedAssets]) {
        for (const asset of src) {
          if (!asset || !asset.asset_id) continue;
          if (seen.has(asset.asset_id)) continue;
          seen.add(asset.asset_id);
          allAssets.push(asset);
        }
      }

      if (allAssets.length === 0) {
        console.log('[sync] No remote assets to sync.');
        if (!exportPath && !(listUnpublished && doPublished)) {
          process.exit(0);
        }
      }

      const existingGenes = loadGenes();
      const existingCapsules = loadCapsules();
      // Dedup by Hub asset_id is the only safe key. Local-facing `id` (e.g.
      // `gene_gep_repair_from_errors`) collides between bundled default seed
      // genes and identically-named assets that the user later published, so
      // dedup-by-id silently skips legitimate Hub copies on first sync. Track
      // hub_asset_id (set by previous syncs / publishes) and only skip when
      // we've already seen the same Hub-side identity.
      const localHubAssetIds = new Set();
      for (const g of existingGenes) {
        if (g && g.hub_asset_id) localHubAssetIds.add(String(g.hub_asset_id));
      }
      for (const c of existingCapsules) {
        if (c && c.hub_asset_id) localHubAssetIds.add(String(c.hub_asset_id));
      }
      const localGeneIds = new Set(existingGenes.filter(function (g) { return g && g.id; }).map(function (g) { return g.id; }));
      const localCapsuleIds = new Set(existingCapsules.filter(function (c) { return c && c.id; }).map(function (c) { return c.id; }));

      let synced = 0;
      let skippedAlreadySynced = 0;
      let skippedIdCollision = 0;
      let fetchErrors = 0;

      for (const asset of allAssets) {
        const assetId = asset.asset_id;
        const assetType = asset.asset_type;
        const localId = asset.local_id || assetId;

        if (assetType !== 'Gene' && assetType !== 'Capsule') {
          skippedAlreadySynced++;
          continue;
        }

        // Already-synced check: same Hub asset_id is already in our local
        // store. Idempotent skip; safe to no-op even with --force because
        // re-fetching the same payload would only rewrite identical bytes.
        if (!force && localHubAssetIds.has(String(assetId))) {
          skippedAlreadySynced++;
          continue;
        }

        // Local-id collision: a local entry with the same user-facing id
        // already exists but has no hub_asset_id (e.g. bundled default seed
        // gene, or a hand-edited entry). Without --force we keep the
        // user-owned entry and warn so the user can decide.
        if (!force) {
          if (assetType === 'Gene' && localGeneIds.has(localId)) {
            if (isVerbose) console.warn('  [sync] Skipping ' + localId + ' (local id collision; pass --force to overwrite with Hub copy)');
            skippedIdCollision++;
            continue;
          }
          if (assetType === 'Capsule' && localCapsuleIds.has(localId)) {
            if (isVerbose) console.warn('  [sync] Skipping ' + localId + ' (local id collision; pass --force to overwrite with Hub copy)');
            skippedIdCollision++;
            continue;
          }
        }

        if (dryRun) {
          console.log('  [dry-run] Would sync: ' + assetType + ' ' + assetId + (force ? ' (force)' : ''));
          synced++;
          continue;
        }

        try {
          let payload = asset.payload;
          if (!payload) {
            const detailResp = await fetch(baseUrl + '/a2a/assets/' + encodeURIComponent(assetId) + '?detailed=true', {
              method: 'GET',
              headers: buildHubHeaders(),
              signal: AbortSignal.timeout(15000),
            });
            if (!detailResp.ok) {
              if (isVerbose) console.warn('  [sync] Failed to fetch detail for ' + assetId + ' (HTTP ' + detailResp.status + ')');
              fetchErrors++;
              continue;
            }
            const detail = await detailResp.json();
            payload = detail.payload || {};
          }

          if (assetType === 'Gene') {
            const geneObj = {
              type: 'Gene',
              id: payload.id || localId,
              category: payload.category || 'unknown',
              signals: Array.isArray(payload.signals) ? payload.signals : [],
              strategy: Array.isArray(payload.strategy) ? payload.strategy : [],
              avoid: Array.isArray(payload.avoid) ? payload.avoid : [],
              validation: payload.validation || {},
              summary: payload.summary || asset.summary || '',
              hub_asset_id: assetId,
              synced_at: new Date().toISOString(),
            };
            upsertGene(geneObj);
            localGeneIds.add(geneObj.id);
            localHubAssetIds.add(String(assetId));
          } else {
            const capsuleObj = {
              type: 'Capsule',
              id: payload.id || localId,
              gene: payload.gene || null,
              genes_used: Array.isArray(payload.genes_used) ? payload.genes_used : [],
              outcome: payload.outcome || {},
              execution_trace: payload.execution_trace || {},
              summary: payload.summary || asset.summary || '',
              hub_asset_id: assetId,
              synced_at: new Date().toISOString(),
            };
            upsertCapsule(capsuleObj);
            localCapsuleIds.add(capsuleObj.id);
            localHubAssetIds.add(String(assetId));
          }
          synced++;
        } catch (fetchErr) {
          if (isVerbose) console.warn('  [sync] Error fetching ' + assetId + ': ' + (fetchErr && fetchErr.message || fetchErr));
          fetchErrors++;
        }
      }

      const skippedTotal = skippedAlreadySynced + skippedIdCollision;
      console.log('[sync] Done. scope=' + scopeArg + ' synced=' + synced + ' skipped=' + skippedTotal + ' (already_synced=' + skippedAlreadySynced + ', id_collision=' + skippedIdCollision + ') errors=' + fetchErrors);
      if (skippedIdCollision > 0 && !force) {
        console.log('[sync] ' + skippedIdCollision + ' Hub asset(s) share a local id with an existing local entry that has no hub_asset_id.');
        console.log('[sync] Re-run with --force to overwrite those local entries with the Hub copies.');
      }
      if (dryRun) console.log('[sync] (dry-run mode: no files were modified)');

      if (listUnpublished && doPublished) {
        const hubGeneIds = new Set();
        const hubCapsuleIds = new Set();
        for (const a of publishedAssets) {
          const lid = a.local_id || a.asset_id;
          if (a.asset_type === 'Gene') hubGeneIds.add(lid);
          else if (a.asset_type === 'Capsule') hubCapsuleIds.add(lid);
        }
        const unpublishedGenes = existingGenes.filter(function (g) {
          return g && g.id && !hubGeneIds.has(g.id) && !g.hub_asset_id;
        });
        const unpublishedCapsules = existingCapsules.filter(function (c) {
          return c && c.id && !hubCapsuleIds.has(c.id) && !c.hub_asset_id;
        });
        if (unpublishedGenes.length || unpublishedCapsules.length) {
          console.log('[sync] Local-only (not on Hub): genes=' + unpublishedGenes.length + ' capsules=' + unpublishedCapsules.length);
          if (isVerbose) {
            for (const g of unpublishedGenes.slice(0, 20)) console.log('    gene: ' + g.id);
            for (const c of unpublishedCapsules.slice(0, 20)) console.log('    capsule: ' + c.id);
            if (unpublishedGenes.length + unpublishedCapsules.length > 40) {
              console.log('    ... (truncated; use --export=<path>.gepx to bundle all)');
            }
          }
        }
      }

      if (exportPath) {
        if (dryRun) {
          console.log('[sync] [dry-run] Would export to ' + exportPath);
        } else {
          const { exportGepx } = require('./src/gep/portable');
          const assetsDir = getGepAssetsDir();
          const memoryGraphPath = require('path').join(getMemoryDir(), 'memory_graph.jsonl');
          try {
            const result = exportGepx({
              assetsDir,
              memoryGraphPath,
              outputPath: exportPath,
              agentId: nodeId,
              agentName: process.env.AGENT_NAME || 'evolver',
            });
            console.log('[sync] Exported .gepx -> ' + result.outputPath);
            console.log('[sync]   stats: ' + JSON.stringify(result.manifest.statistics));
          } catch (exportErr) {
            console.error('[sync] Export failed: ' + (exportErr && exportErr.message || exportErr));
            process.exit(1);
          }
        }
      }
    } catch (error) {
      if (error && error.name === 'TimeoutError') {
        console.error('[sync] Request timed out. Check your network and A2A_HUB_URL.');
      } else {
        console.error('[sync] Error: ' + (error && error.message || error));
      }
      process.exit(1);
    }

  } else if (command === 'asset-log') {
    const { summarizeCallLog, readCallLog, getLogPath } = require('./src/gep/assetCallLog');

    const runIdFlag = args.find(a => typeof a === 'string' && a.startsWith('--run='));
    const actionFlag = args.find(a => typeof a === 'string' && a.startsWith('--action='));
    const lastFlag = args.find(a => typeof a === 'string' && a.startsWith('--last='));
    const sinceFlag = args.find(a => typeof a === 'string' && a.startsWith('--since='));
    const jsonMode = args.includes('--json');

    const opts = {};
    if (runIdFlag) opts.run_id = runIdFlag.slice('--run='.length);
    if (actionFlag) opts.action = actionFlag.slice('--action='.length);
    if (lastFlag) opts.last = parseInt(lastFlag.slice('--last='.length), 10);
    if (sinceFlag) opts.since = sinceFlag.slice('--since='.length);

    if (jsonMode) {
      const entries = readCallLog(opts);
      console.log(JSON.stringify(entries, null, 2));
    } else {
      const summary = summarizeCallLog(opts);
      console.log(`\n[Asset Call Log] ${getLogPath()}`);
      console.log(`  Total entries: ${summary.total_entries}`);
      console.log(`  Unique assets: ${summary.unique_assets}`);
      console.log(`  Unique runs:   ${summary.unique_runs}`);
      console.log(`  By action:`);
      for (const [action, count] of Object.entries(summary.by_action)) {
        console.log(`    ${action}: ${count}`);
      }
      if (summary.entries.length > 0) {
        console.log(`\n  Recent entries:`);
        const show = summary.entries.slice(-10);
        for (const e of show) {
          const ts = e.timestamp ? e.timestamp.slice(0, 19) : '?';
          const assetShort = e.asset_id ? e.asset_id.slice(0, 20) + '...' : '(none)';
          const sigPreview = Array.isArray(e.signals) ? e.signals.slice(0, 3).join(', ') : '';
          console.log(`    [${ts}] ${e.action || '?'}  asset=${assetShort}  score=${e.score || '-'}  mode=${e.mode || '-'}  signals=[${sigPreview}]  run=${e.run_id || '-'}`);
        }
      } else {
        console.log('\n  No entries found.');
      }
      console.log('');
    }

  } else if (command === 'webui') {
    const portFlag = args.find(a => typeof a === 'string' && a.startsWith('--port='));
    const port = portFlag ? Number(portFlag.slice('--port='.length)) : undefined;
    const { startWebUi } = require('./src/webui');
    try {
      const info = await startWebUi({ port });
      console.log('[webui] Open ' + info.url);
      const shutdown = async () => {
        try { await info.server.stop(); } catch (_) {}
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await new Promise(() => {});
    } catch (error) {
      console.error('[webui] Failed: ' + (error && error.message || error));
      process.exit(1);
    }

  } else if (command === 'setup-hooks') {
    const hookAdapter = require('./src/adapters/hookAdapter');
    const { setupHooks, resolveConfigRoot, detectPlatform, loadAdapter } = hookAdapter;

    const platformFlag = args.find(a => typeof a === 'string' && a.startsWith('--platform='));
    const platform = platformFlag ? platformFlag.slice('--platform='.length) : undefined;
    const force = args.includes('--force');
    const uninstall = args.includes('--uninstall');
    const verifyOnly = args.includes('--verify');

    if (verifyOnly) {
      // Read-only verification: do not touch any files, just report whether
      // the previously-installed hooks/plugin look healthy. Lets users answer
      // "is the plugin actually loaded?" without grepping opencode logs.
      try {
        const platformId = platform || detectPlatform(process.cwd());
        if (!platformId) {
          console.error('[setup-hooks] --verify: could not detect platform. Pass --platform=opencode|cursor|claude-code|codex|kiro');
          process.exit(2);
        }
        const adapter = loadAdapter(platformId);
        if (!adapter || typeof adapter.verify !== 'function') {
          console.error('[setup-hooks] --verify: platform ' + platformId + ' does not support verification yet.');
          process.exit(2);
        }
        const configRoot = resolveConfigRoot(platformId, process.cwd());
        const report = adapter.verify({ configRoot });
        if (typeof adapter.printVerifyReport === 'function') {
          adapter.printVerifyReport(report);
        } else {
          console.log(JSON.stringify(report, null, 2));
        }
        process.exit(report.ok ? 0 : 1);
      } catch (verifyErr) {
        console.error('[setup-hooks] --verify error:', verifyErr && verifyErr.message || verifyErr);
        process.exit(1);
      }
    }

    try {
      const result = await setupHooks({
        platform,
        cwd: process.cwd(),
        force,
        uninstall,
        evolverRoot: __dirname,
      });
      if (result && result.ok) {
        if (!uninstall && result.files) {
          console.log('\n[setup-hooks] Files created/updated:');
          for (const f of result.files) {
            console.log('  ' + f);
          }
        }
        process.exit(0);
      } else {
        console.error('[setup-hooks] Failed: ' + (result && result.error || 'unknown'));
        process.exit(1);
      }
    } catch (error) {
      console.error('[setup-hooks] Error:', error && error.message || error);
      process.exit(1);
    }

  } else if (command === 'atp-complete') {
    // Invoked by a spawned Cursor sub-session after it has written the ATP
    // task answer to a file. Drives publish -> task/complete -> atp/deliver.
    try {
      const subArgs = args.slice(1);
      function flag(name) {
        const pref = '--' + name + '=';
        const hit = subArgs.find(function (a) { return typeof a === 'string' && a.startsWith(pref); });
        return hit ? hit.slice(pref.length) : null;
      }
      function list(name) {
        const raw = flag(name);
        if (!raw) return null;
        return raw.split(',').map(function (s) { return String(s).trim(); }).filter(Boolean);
      }
      const taskId = flag('task-id');
      const orderId = flag('order-id');
      const answerFile = flag('answer-file');
      const summary = flag('summary');
      const capabilities = list('capabilities');
      const signals = list('signals');
      if (!taskId || !orderId || !answerFile) {
        console.error('[ATP-Complete] Missing required flags: --task-id, --order-id, --answer-file');
        console.error('Usage: node index.js atp-complete --task-id=<tid> --order-id=<oid> --answer-file=<path> [--summary="..."] [--capabilities=cap1,cap2] [--signals=sig1,sig2]');
        process.exit(2);
      }
      const { completeAtpTask } = require('./src/atp/atpExecute');
      const res = await completeAtpTask({ taskId, orderId, answerFile, summary, capabilities, signals });
      if (res && res.ok) {
        console.log('[ATP-Complete] OK asset_id=' + res.assetId + (res.deliveryId ? ' delivery_id=' + res.deliveryId : ''));
        process.exit(0);
      }
      console.error('[ATP-Complete] FAILED stage=' + (res && res.stage) + ' error=' + (res && res.error));
      process.exit(1);
    } catch (atpCompleteErr) {
      console.error('[ATP-Complete] Error:', atpCompleteErr && atpCompleteErr.message || atpCompleteErr);
      process.exit(1);
    }

  } else if (command === 'buy' || command === 'orders' || command === 'verify') {
    try {
      const atpCli = require('./src/atp/cli');
      const subArgs = args.slice(1); // drop the command token (e.g. "buy") itself
      let parsed;
      let runner;
      if (command === 'buy') {
        parsed = atpCli.parseBuyArgs(subArgs);
        runner = atpCli.runBuy;
      } else if (command === 'orders') {
        parsed = atpCli.parseOrdersArgs(subArgs);
        runner = atpCli.runOrders;
      } else {
        parsed = atpCli.parseVerifyArgs(subArgs);
        runner = atpCli.runVerify;
      }
      if (!parsed.ok) {
        console.error('[ATP] ' + parsed.error);
        console.error(atpCli.printUsage());
        process.exit(2);
      }
      const res = await runner(parsed.opts);
      process.exit(res && typeof res.exitCode === 'number' ? res.exitCode : 0);
    } catch (atpCliErr) {
      console.error('[ATP] CLI error:', atpCliErr && atpCliErr.message || atpCliErr);
      process.exit(1);
    }

  } else {
    console.log(`Usage: node index.js [run|/evolve|solidify|review|distill|fetch|sync|asset-log|webui|setup-hooks|buy|orders|verify|atp-complete] [--loop]
  - fetch flags:
    - --skill=<id> | -s <id>   (skill ID to download)
    - --out=<dir>              (output directory, default: ./skills/<skill_id>)
  - sync flags:
    - --scope=all|purchased|published   (default: all)
    - --type=Gene|Capsule               (filter by asset type)
    - --status=draft,promoted,all       (only for published scope; default promoted+draft)
    - --export=<path.gepx>              (also bundle local assets into a .gepx archive)
    - --no-unpublished-list             (suppress local-only asset list)
    - --force                           (overwrite local entries that share an id with a Hub asset; bypasses default-seed dedup)
    - --dry-run                         (preview without writing to local store)
  - solidify flags:
    - --dry-run
    - --no-rollback
    - --intent=repair|optimize|innovate
    - --summary=...
  - review flags:
    - --approve                (approve and solidify the pending changes)
    - --reject                 (reject and rollback the pending changes)
  - distill flags:
    - --response-file=<path>  (LLM response file for skill distillation)
  - setup-hooks flags:
    - --platform=cursor|claude-code|codex|kiro|opencode  (auto-detect if omitted)
    - --force                              (overwrite existing config)
    - --uninstall                          (remove evolver hooks)
    - --verify                             (read-only: print install health for the chosen platform)
  - asset-log flags:
    - --run=<run_id>           (filter by run ID)
    - --action=<action>        (filter: hub_search_hit, hub_search_miss, asset_reuse, asset_reference, asset_publish, asset_publish_skip)
    - --last=<N>               (show last N entries)
    - --since=<ISO_date>       (entries after date)
    - --json                   (raw JSON output)
  - webui flags:
    - --port=<N>               (local Web UI port, default 19821)

  ATP (Agent Transaction Protocol) subcommands:
  - buy <caps>                 (place an ATP order; caps is comma-separated)
    - --budget=<N>             (credits to spend, default 10)
    - --question="..."         (order description)
    - --routing=<mode>         (fastest|cheapest|auction|swarm, default fastest)
    - --verify=<mode>          (auto|ai_judge|bilateral, default auto)
    - --no-wait                (return immediately after placing)
    - --timeout=<seconds>      (lifecycle timeout, default 300)
  - orders                     (list your recent ATP orders / deliveries)
    - --role=consumer|merchant (default consumer)
    - --status=pending|verified|disputed|settled
    - --limit=<N>              (1..100, default 20)
    - --json                   (raw JSON)
  - verify <orderId>           (confirm delivery or trigger AI judge)
    - --action=confirm|ai_judge (default confirm)
  - atp-complete               (internal: spawned Cursor sub-session uses this to settle an ATP task)
    - --task-id=<tid>          (Hub task id, required)
    - --order-id=<oid>         (ATP DeliveryProof id, required)
    - --answer-file=<path>     (file containing the merchant answer, required)
    - --summary="..."          (capsule summary, optional)
    - --capabilities=a,b       (listing capabilities, optional)
    - --signals=s1,s2          (task signals, optional)

Validator role (decentralized validation, default ON since v1.69.0):
  - EVOLVER_VALIDATOR_ENABLED=0    opt out (env beats persisted flag and default)
  - EVOLVER_VALIDATOR_ENABLED=1    explicitly opt in
  - unset                          honor persisted flag from ~/.evomap/feature_flags.json,
                                   else default ON. The hub may push a flag update via
                                   the mailbox (event type: feature_flag_update).
  - Earnings: validators earn credits + reputation from successful consensus.
    See docs/validator.md for details.`);
  }
}

if (require.main === module) {
  main().catch(function (err) {
    console.error('[FATAL] Top-level error:', err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  readJsonSafe,
  rejectPendingRun,
  isPendingSolidify,
  parseBoolEnv,
  CycleTimeoutError,
  writeCycleProgressAtomic,
  spawnReplacementProcess,
};
