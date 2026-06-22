#!/usr/bin/env node
function _printProxyTokenUsage(out = process.stderr) {
  out.write('Usage: node index.js proxy-token [--settings FILE]\n');
}

function _readProxyTokenFromSettingsFile(fs, settingsFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return parsed && parsed.proxy && typeof parsed.proxy.token === 'string'
      ? parsed.proxy.token
      : '';
  } catch {
    return '';
  }
}

// `proxy-token` is a credential helper for Codex. Handle it before loading any
// project .env so a workspace cannot change EVOLVER_SETTINGS_DIR or other local
// state used to find the proxy token.
if (process.argv[2] === 'proxy-token') {
  try {
    const _fs = require('fs');
    const _os = require('os');
    const _path = require('path');
    let settingsFile = '';
    for (let i = 3; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '-h' || arg === '--help') {
        _printProxyTokenUsage(process.stdout);
        process.exit(0);
      }
      if (arg === '--settings') {
        if (!process.argv[i + 1]) {
          _printProxyTokenUsage();
          console.error('[proxy-token] missing value for --settings');
          process.exit(2);
        }
        settingsFile = process.argv[i + 1];
        i++;
        continue;
      }
      _printProxyTokenUsage();
      console.error('[proxy-token] unknown argument');
      process.exit(2);
    }
    const defaultSettingsFile = _path.join(
      process.env.EVOLVER_SETTINGS_DIR || _path.join(_os.homedir(), '.evolver'),
      'settings.json',
    );
    const token = _readProxyTokenFromSettingsFile(_fs, settingsFile || defaultSettingsFile);
    if (!token) {
      console.error('[proxy-token] no active proxy token found; start evolver with EVOMAP_PROXY=1 first');
      process.exit(1);
    }
    process.stdout.write(token + '\n');
    process.exit(0);
  } catch (e) {
    console.error('[proxy-token] Failed:', e && e.message || e);
    process.exit(1);
  }
}

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
const os = require('os');
const { getRepoRoot } = require('./src/gep/paths');
const { resolveLoopBridgeMode } = require('./src/evolve/loopBridgeMode');
const fs = require('fs');
const { spawn } = require('child_process');

// Interruptible sleep: SIGCONT (and any future wake hook) can short-circuit
// pending sleeps so a daemon that just woke from macOS sleep doesn't sit
// out the rest of its pre-sleep adaptive-sleep window on the resumed
// monotonic clock. Without this, the heartbeat side recovers via the
// drift detector but the outer evolve cycle stays paused up to maxSleepMs
// (default 5 min) after wake. Each call tracks its own resolver in
// _activeSleeps so the wake hook can resolve all of them.
const _activeSleeps = new Set();
function sleepMs(ms) {
  const n = parseInt(String(ms), 10);
  const t = Number.isFinite(n) ? Math.max(0, n) : 0;
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      _activeSleeps.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, t);
    // NOTE: intentionally NOT calling timer.unref() here. When the daemon is in
    // a long adaptive sleep (up to maxSleepMs = 5 min by default), this timer is
    // often the ONLY ref'd handle keeping the event loop alive. All other timers
    // (_heartbeatTimer, _heartbeatDriftInterval, _selfDrivingPollTimer, etc.) are
    // unref'd, so once the evolve loop's sleepMs timer was also unref'd, Node.js
    // could see zero ref'd handles and silently exit the process mid-sleep. That
    // was the root cause of "first launch ok, idle for a while, then evolver dead
    // with no log trace" on macOS. A ref'd sleep timer is the load-bearing event-
    // loop anchor during idle periods; it fires within maxSleepMs and the daemon
    // then reschedules itself normally. Leaving it ref'd has no observable cost.
    _activeSleeps.add(finish);
  });
}
function _interruptAllSleeps() {
  if (_activeSleeps.size === 0) return;
  // Snapshot first because resolvers mutate the set as they run.
  const finishers = Array.from(_activeSleeps);
  for (const fn of finishers) {
    try { fn(); } catch (_) {}
  }
}

// Round-6 (§19.5): heartbeat-internal wake recovery (drainPool +
// pokeHeartbeat + SSE restart + self-driving-poll re-arm) lives in
// a2aProtocol so the drift detector can drive it directly. Process-
// level wake hooks (sleepMs interrupter, validator daemon poke) are
// registered with a2aProtocol so both the SIGCONT handler and the
// drift detector long-sleep branch run them. Lazy-register so requires
// resolve cleanly under test (single Set of registered hooks; cheap to
// re-register idempotently).
let _wakeHooksRegistered = false;
function _registerProcessWakeHooks() {
  if (_wakeHooksRegistered) return;
  try {
    const a2a = require('./src/gep/a2aProtocol.js');
    if (typeof a2a.registerWakeHook !== 'function') return;
    a2a.registerWakeHook(function () {
      try { _interruptAllSleeps(); } catch (_) {}
    });
    // R13: guards.sleepMs is a separate private helper used for 60-120s
    // backoffs inside evolve.run() arms (active-sessions, system-load,
    // pending-solidify). Without this hook, a guard sleep that spans
    // macOS suspend would block the cycle for the full window on the
    // resumed monotonic clock even though the outer sleep was interrupted.
    a2a.registerWakeHook(function () {
      try {
        const guards = require('./src/evolve/guards');
        if (guards && typeof guards._interruptGuardSleeps === 'function') {
          guards._interruptGuardSleeps();
        }
      } catch (_) {}
    });
    a2a.registerWakeHook(function () {
      try {
        const v = require('./src/gep/validator');
        if (v && typeof v.pokeValidatorDaemon === 'function') {
          v.pokeValidatorDaemon();
        }
      } catch (_) {}
    });
    _wakeHooksRegistered = true;
  } catch (_) {}
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

function classifyInvocation(args) {
  const argv = Array.isArray(args) ? args : [];
  const command = argv[0];
  const isLoop = argv.includes('--loop') || argv.includes('--mad-dog');
  const startsEvolution = !command || command === 'run' || command === '/evolve' || isLoop;
  return { command, isLoop, startsEvolution };
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
// supervisor (NSSM, pm2-windows, etc.) to respawn the daemon on non-zero exit.
// Users who insist can opt back in with EVOLVER_SUICIDE_WINDOWS=true (and accept
// the popups).
function spawnReplacementProcess({ reason, args, logPath }) {
  const isWindows = process.platform === 'win32';
  const allowOnWindows = parseBoolEnv(process.env.EVOLVER_SUICIDE_WINDOWS, false);
  if (isWindows && !allowOnWindows) {
    console.log(
      '[Daemon] Skipping in-process respawn on Windows (' + reason + '). ' +
      'Native Node spawn(detached, windowsHide) opens a cmd popup on every restart (Issue #528). ' +
      'Set EVOLVER_SUICIDE_WINDOWS=true to opt back in. ' +
      'Recommended: run evolver under an external supervisor (NSSM, pm2-windows, etc.) so it restarts on exit.'
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

// Singleton Guard - prevent multiple evolver daemon instances.
//
// Lock location + lease tunables live in src/adapters/scripts/_lockPaths.js
// (issue #176): the session-start hook's auto-restart guard needs the exact
// same resolution, and inlining it in both places drifted. The Round-4
// (per-install-mode pidfile convergence) and Round-9 (lease staleness)
// history notes moved there with the code.
const {
  getLockFilePath,
  lockIsStaleByLease: _lockIsStaleByLease,
  STALE_LOCK_TTL_MS,
  LOCK_REFRESH_MS,
} = require('./src/adapters/scripts/_lockPaths');

function _writeLockAtomic(lockFile, payload) {
  // Round-6 (§19.8): the previous implementation used tmp + rename, which
  // makes the WRITE atomic but not the OWNERSHIP claim. Two processes
  // could both rename their own tmp file over the same lockFile (rename
  // is atomic per call but successive renames overwrite each other), then
  // each read it back and -- if the second rename happened between the
  // first process's rename and its read-back -- see the OTHER process's
  // PID. Each then concludes "I lost the race" and exits, leaving the
  // lockFile owned by no live process. Symmetrically, two processes can
  // each see their own PID if the reads happen between their respective
  // renames, and both conclude they won.
  //
  // The proper primitive is link(2): given a unique tmp file, link to the
  // target path fails atomically with EEXIST if the target already
  // exists. Only one of N concurrent linkers succeeds.
  // NOTE(windows): mode 0o700 / 0o600 are silently ignored on Windows.
  // The lock directory and tmp file will NOT be owner-only on Windows.
  // Isolation relies solely on the user-profile directory ACLs.
  const dir = path.dirname(lockFile);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
  const tmp = lockFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  // link() requires the target NOT to exist. The caller in the takeover
  // path has already unlinked the stale lockFile via fs.unlinkSync
  // (ignoring ENOENT). If a concurrent process beat us to the link, our
  // linkSync below throws EEXIST -- we surface that to the caller and
  // clean up our tmp.
  //
  // EXDEV: fs.link() fails with EXDEV when tmp and lockFile are on different
  // volumes (can happen on Windows when EVOLVER_LOCK_DIR points to a drive
  // other than the tmp dir). Fall back to renameSync, which Node.js handles
  // cross-device by copying + deleting. rename is not atomic in this path,
  // so the EEXIST guard is lost, but this is an unusual configuration and
  // the result is still safe (worst case: two daemons both think they won,
  // the second write wins, the first will exit on its next tick when it
  // reads back a foreign PID via the heartbeat).
  try {
    fs.linkSync(tmp, lockFile);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      // Cross-device: rename falls back to copy+delete inside Node.js; this
      // loses the atomic-EEXIST guarantee but is better than hard-failing.
      try {
        fs.renameSync(tmp, lockFile);
      } catch (renameErr) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw renameErr;
      }
      return; // tmp has been consumed by renameSync, skip unlinkSync below
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
  try { fs.unlinkSync(tmp); } catch (_) {}
}

function _readLockPayload(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    if (!raw) return null;
    // Backward-compat: older lock files contained only the pid as text.
    // Newer payloads are JSON {pid, uid, startedAt}.
    if (raw[0] === '{') {
      try { return JSON.parse(raw); } catch (_) { return null; }
    }
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? { pid: pid } : null;
  } catch (_) { return null; }
}

function _lockPayload() {
  return JSON.stringify({
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    startedAt: new Date().toISOString(),
    // Round-9: marks a daemon that refreshes this lock file's mtime on a
    // lease (see startLockRefresh). Only when this flag is present do
    // acquireLock / refuseHelloIfDaemonRunning trust mtime-staleness to
    // reclaim a lock whose PID is alive -- the PID-reuse / SIGKILL-stale
    // guard. A lock written by an OLDER daemon (no flag) keeps the legacy
    // kill(0)-only behavior so a new binary can never falsely steal a
    // still-running old daemon's lock (which would run two daemons).
    lease: true,
  });
}

// STALE_LOCK_TTL_MS / LOCK_REFRESH_MS / _lockIsStaleByLease come from
// src/adapters/scripts/_lockPaths.js (required next to getLockFilePath
// above) — see issue #176 and the Round-9 history note in that module.
let _lockRefreshTimer = null;

// Start refreshing the lock file's mtime so other processes can tell this
// daemon is alive without trusting a (recyclable) PID. unref'd: it never
// keeps the event loop open on its own, but fires for as long as the daemon
// is otherwise alive.
function startLockRefresh() {
  if (_lockRefreshTimer) return;
  const lockFile = getLockFilePath();
  _lockRefreshTimer = setInterval(function () {
    try {
      const now = new Date();
      fs.utimesSync(lockFile, now, now);
    } catch (_) { /* lock gone / FS error: nothing we can do here */ }
  }, LOCK_REFRESH_MS);
  if (_lockRefreshTimer && typeof _lockRefreshTimer.unref === 'function') {
    _lockRefreshTimer.unref();
  }
}

function stopLockRefresh() {
  if (_lockRefreshTimer) {
    clearInterval(_lockRefreshTimer);
    _lockRefreshTimer = null;
  }
}

function acquireLock() {
  const lockFile = getLockFilePath();
  // NOTE(windows): mode 0o700 / 0o600 are silently ignored on Windows.
  // Lock directory and file permissions provide no OS-level isolation on
  // Windows; rely on user-profile directory ACLs (%USERPROFILE%\.evomap).
  try {
    try { fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 }); } catch (_) {}
    try {
      fs.writeFileSync(lockFile, _lockPayload(), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (exclErr) {
      if (exclErr.code !== 'EEXIST') throw exclErr;
    }
    const payload = _readLockPayload(lockFile);
    if (!payload || !Number.isFinite(payload.pid) || payload.pid <= 0) {
      console.log('[Singleton] Corrupt lock file. Taking over.');
    } else if (_lockIsStaleByLease(lockFile, payload)) {
      // Round-9: a lease-aware daemon has not refreshed this lock's mtime
      // within the stale TTL. Either it was SIGKILLed/crashed, or its PID
      // has since been reused by an unrelated process (kill(0) below would
      // then falsely report it alive and we would refuse to start forever).
      // The expired lease is authoritative: take over.
      console.log('[Singleton] Lock lease expired (PID ' + payload.pid + ', no mtime refresh for > ' +
        Math.round(STALE_LOCK_TTL_MS / 60_000) + 'min). Taking over.');
    } else {
      try {
        process.kill(payload.pid, 0);
        // Process exists. Distinguish "alive, our user" (refuse) from
        // "alive, different uid" (also refuse -- never barge into a root
        // daemon under a user-launched evolver, etc.).
        console.log(`[Singleton] Evolver loop already running (PID ${payload.pid}). Exiting.`);
        return false;
      } catch (e) {
        if (e && e.code === 'EPERM') {
          // PID exists but belongs to another user. Conservatively
          // refuse: barging in would race the existing daemon for
          // secret/heartbeat ownership.
          console.warn(`[Singleton] Lock owned by PID ${payload.pid} (different user). Refusing to take over. ` +
            `Remove ${lockFile} manually if the PID is actually dead.`);
          return false;
        }
        console.log(`[Singleton] Stale lock found (PID ${payload.pid}). Taking over.`);
      }
    }
    // Atomic takeover so two daemons that both observe the same stale PID
    // and pass the kill(0) check cannot both end up "owning" the lock.
    //
    // Bug it fixes: the previous "unconditional unlinkSync then linkSync"
    // pattern was NOT atomic across acquirers. Interleaving where P1 wins
    // the linkSync but P2's unlinkSync then deletes P1's freshly-linked
    // file (P2 never re-verifies it's deleting the same stale lock it
    // observed) lets P2's subsequent linkSync also succeed. Both processes
    // then return true and start a daemon, racing each other on the
    // shared singleton secret store.
    //
    // renameSync is atomic at the filesystem level: only one of N racing
    // acquirers can move the stale lockFile to a unique claim name, the
    // rest see ENOENT and abort. After the claim succeeds, _writeLockAtomic
    // installs the fresh lock; the claim file is unlinked in every exit
    // path so it doesn't accumulate.
    const claimFile = lockFile + '.' + process.pid + '.' + Date.now() + '.takeover';
    try {
      fs.renameSync(lockFile, claimFile);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        // Another concurrent acquirer already claimed the stale lock.
        // They'll race us on _writeLockAtomic below; the EEXIST branch
        // handles the loser case correctly.
      } else {
        console.warn('[Singleton] Cannot claim stale lock at ' + lockFile + ': ' + e.message);
        return false;
      }
    }
    try {
      _writeLockAtomic(lockFile, _lockPayload());
    } catch (linkErr) {
      try { fs.unlinkSync(claimFile); } catch (_) {}
      if (linkErr && linkErr.code === 'EEXIST') {
        // Lost the link race to another concurrent acquirer. Read who
        // won (best-effort) for the log line.
        const winner = _readLockPayload(lockFile);
        console.log('[Singleton] Lost takeover race to PID ' + (winner && winner.pid) + '. Exiting.');
        return false;
      }
      throw linkErr;
    }
    try { fs.unlinkSync(claimFile); } catch (_) {}
    return true;
  } catch (err) {
    console.error('[Singleton] Lock acquisition failed:', err);
    return false;
  }
}

function releaseLock() {
  const lockFile = getLockFilePath();
  try {
    if (fs.existsSync(lockFile)) {
      const payload = _readLockPayload(lockFile);
      if (payload && payload.pid === process.pid) fs.unlinkSync(lockFile);
    }
  } catch (e) { /* ignore */ }
}

// Round-7 (§20.7): the daemon-lock acquireLock() only fires for `--loop`
// mode; CLI subcommands like `evolver fetch` and `evolver sync` run
// without acquiring the lock and freely call sendHelloToHub when
// node_secret is missing. The hub-side hello-with-rotate rewrites the
// node_secret on disk, so two writers (the daemon's heartbeat path
// rotating one secret + this CLI's sendHelloToHub writing a different
// one) race to be "last writer." Whichever wrote second silences the
// other -- the daemon then 401-loops -> enters reauth backoff -> goes
// silent for 30 min..4 h. The original §6 "instance lock" scenario.
//
// This helper does NOT take the lock (the daemon legitimately owns it);
// it only refuses to proceed if a LIVE daemon owns the lock AND we are
// about to send a fresh hello. If the daemon is alive it already has a
// valid secret in ~/.evomap/node_secret, so the right thing for the CLI
// is to wait briefly for the secret to appear (newly registered daemon)
// or exit with an actionable error.
//
// Callers: every CLI subcommand whose runner could call sendHelloToHub()
// when getHubNodeSecret() returns empty. Currently: fetch, sync
// (round-7 §20.7), plus atp-complete, buy, orders, verify (round-8
// §21.8 -- the ATP runners hit the same vector via consumerAgent /
// merchantAgent / atpExecute paths).
function refuseHelloIfDaemonRunning(toolLabel) {
  try {
    const lockFile = getLockFilePath();
    if (!fs.existsSync(lockFile)) return; // no daemon
    const payload = _readLockPayload(lockFile);
    if (!payload || !Number.isFinite(payload.pid) || payload.pid <= 0) return;
    if (payload.pid === process.pid) return; // shouldn't happen for CLI
    // Round-9: a lease-aware lock whose mtime has gone stale means the
    // daemon is dead (or its PID was reused). Do NOT refuse on it -- that
    // was the "CLI hard-exits because it trusts a recyclable PID" hole.
    if (_lockIsStaleByLease(lockFile, payload)) return;
    try {
      process.kill(payload.pid, 0);
    } catch (e) {
      if (e && e.code === 'ESRCH') return; // stale lock, daemon is gone
      // EPERM = alive under a different user; still a real daemon. Fall
      // through to refuse.
    }
    console.error(
      '[' + toolLabel + '] Refusing to send hello: an evolver daemon ' +
      '(PID ' + payload.pid + ') is running and owns ~/.evomap/instance.lock.'
    );
    console.error(
      '       Two concurrent hello calls would rotate node_secret against ' +
      'each other and silence the daemon for hours.'
    );
    console.error(
      '       Either wait for the daemon to register (the secret will ' +
      'appear at ~/.evomap/node_secret), or stop the daemon and retry.'
    );
    process.exit(1);
  } catch (_) {
    // Never let the lock-check helper itself escape; if the helper
    // throws (FS permission, etc.) we fall through to the original code
    // path. The race we're protecting against is rare; failing closed
    // here would block legitimate CLI use.
  }
}

async function main() {
  const args = process.argv.slice(2);
  const invocation = classifyInvocation(args);
  const command = invocation.command;
  const isLoop = invocation.isLoop;
  const isVerbose = args.includes('--verbose') || args.includes('-v') ||
    String(process.env.EVOLVER_VERBOSE || '').toLowerCase() === 'true';
  if (isVerbose) process.env.EVOLVER_VERBOSE = 'true';

  if (invocation.startsEvolution) {
    if (isLoop) {
        // EPIPE protection. The daemon may outlive the controlling
        // terminal (user closes the iTerm tab, ssh session drops, parent
        // shell exits). The SIGHUP handler below covers the signal side,
        // but the underlying pty fd is gone and the FIRST subsequent
        // console.log writes to a closed pipe -> stdout emits 'error'
        // with EPIPE. Without a listener attached, Node escalates EPIPE
        // to uncaughtException, which our handler then turns into
        // process.exit(1). Net result: daemon silently dies the next
        // time it tries to log, with no useful trace. Swallow EPIPE
        // explicitly so the daemon stays alive when its terminal goes
        // away (matching standard daemonization practice).
        try {
          // EPIPE: swallow (daemon must outlive its controlling terminal).
          // Non-EPIPE (EIO, ENOSPC on redirected log, etc.): the listener
          // already prevents 'error' from escalating to uncaughtException,
          // so write a one-line trace to the *other* stream so operators
          // can see the failure mode instead of finding a silent daemon.
          process.stdout.on('error', function (err) {
            if (err && err.code === 'EPIPE') return;
            try { process.stderr.write('[evolver] stdout error: ' + (err && (err.code || err.message) || err) + '\n'); } catch (_) {}
          });
          process.stderr.on('error', function (err) {
            if (err && err.code === 'EPIPE') return;
            try { process.stdout.write('[evolver] stderr error: ' + (err && (err.code || err.message) || err) + '\n'); } catch (_) {}
          });
        } catch (_) {}

        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;
        function ts() { return '[' + new Date().toISOString() + ']'; }
        // Wrap originals in try/catch so a broken transport (closed pty,
        // disk full on a redirected log file) cannot escape and trip
        // unhandledException -> exit(1) the next time we log.
        console.log = (...args) => {
          try { originalLog.call(console, ts(), ...args); } catch (_) {}
        };
        console.warn = (...args) => {
          try { originalWarn.call(console, ts(), ...args); } catch (_) {}
        };
        console.error = (...args) => {
          try { originalError.call(console, ts(), ...args); } catch (_) {}
        };
    }

    console.log('Starting evolver...');

    // Preflight: fail fast if git is not on PATH. On Windows in particular
    // a missing git binary can cause evolver to hang silently (see #394),
    // because several cycle-critical steps shell out to git early (repo
    // resolution, diff, blast-radius). Catching this up front makes the
    // failure mode obvious.
    try {
      const { execSync } = require('child_process');
      execSync('git --version', { stdio: 'ignore', timeout: 5000, windowsHide: true });
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
        // Round-9: refresh the lock lease so other processes can detect a
        // crash / PID reuse via stale mtime instead of trusting kill(0).
        startLockRefresh();

        // Linux OOM score adjustment: lower oom_score_adj so the kernel
        // deprioritises evolver when choosing an OOM victim. This is a
        // best-effort hint -- the kernel can still kill us under extreme
        // memory pressure, but we will not be the first target.
        //
        // Value -500 (range -1000..1000; -1000 = never kill, 0 = default,
        // +1000 = kill first). -500 gives meaningful protection without
        // reserving the slot for truly critical system services.
        //
        // Requires the process to be either root or to have CAP_SYS_RESOURCE.
        // On most Docker/k8s images running as non-root this write will fail
        // with EACCES -- that is expected and harmless; we log a one-liner so
        // operators know to pass --oom-score-adj=-500 via their container spec,
        // or to set /proc/<pid>/oom_score_adj from the supervising process.
        //
        // Users who want to set this from outside the process (safer, no CAP):
        //   echo -500 > /proc/$(pgrep -f "node.*evolver.*--loop")/oom_score_adj
        //
        // Opt-out: EVOLVER_DISABLE_OOM_ADJUST=1
        if (process.platform === 'linux' &&
            String(process.env.EVOLVER_DISABLE_OOM_ADJUST || '') !== '1') {
          try {
            const _oomPath = '/proc/self/oom_score_adj';
            const _oomTarget = '-500';
            require('fs').writeFileSync(_oomPath, _oomTarget + '\n', 'utf8');
            console.log('[evolver] Set Linux oom_score_adj=' + _oomTarget +
              ' to reduce OOM-kill priority.');
          } catch (oomErr) {
            // EACCES under non-root / no CAP_SYS_RESOURCE is expected; EPERM
            // inside stricter seccomp/apparmor profiles.  Both are non-fatal.
            const oomCode = oomErr && oomErr.code ? oomErr.code : 'unknown';
            console.log('[evolver] Could not set oom_score_adj (' + oomCode +
              '). To protect evolver from OOM kill, run as root, add ' +
              'CAP_SYS_RESOURCE, or set oom_score_adj externally via your ' +
              'container spec (e.g. resources.requests + oom_score_adj in k8s).');
          }
        }

        // Round-4: macOS App Nap / QoS demotion mitigation. Without this,
        // a backgrounded `evolver --loop` running in an iTerm tab gets its
        // process QoS demoted to UTILITY/BACKGROUND once the parent app
        // is no longer focused. CPU runtime caps to ~5% of one core,
        // setTimeout resolution drops toward 1 Hz, disk I/O is throttled.
        // The drift detector cannot rescue this because the demotion does
        // NOT cause Date.now() to jump -- only the inter-tick interval
        // dilates, which the detector samples through its own (also
        // demoted) setInterval. Net result: heartbeat appears alive but
        // ticks fire so slowly that the hub marks the node offline,
        // matching the user-reported "first launch ok -> idle -> dead
        // forever" pattern.
        //
        // os.setPriority() raises BSD process priority; macOS bridges that
        // to Mach thread QoS via the priority bridge so the demotion does
        // not engage. -10 is the most negative value raisable without
        // root. Failures are logged but non-fatal (e.g. EPERM under a
        // restrictive sandbox -- the daemon continues, just unprotected).
        // Opt-out via EVOLVER_DISABLE_PRIORITY_BOOST=1 for users on
        // power-constrained battery profiles who would rather accept
        // the throttle than the extra wake-time.
        if (process.platform === 'darwin' &&
            String(process.env.EVOLVER_DISABLE_PRIORITY_BOOST || '') !== '1') {
          let priorityBoostOk = false;
          try {
            const os = require('os');
            os.setPriority(0, -10);
            // Round-5: actually verify the boost landed. macOS silently
            // returns success from setPriority(2) under some sandboxes
            // even when the underlying syscall was rejected by the
            // Mach thread-policy bridge. Read it back; if the value is
            // still 0 (or worse), App Nap will engage and the user
            // sees the "first launch -> idle -> dead" symptom from
            // round-3 with NO log evidence to RCA from.
            const observed = os.getPriority();
            if (observed <= -10) {
              priorityBoostOk = true;
              console.log('[evolver] Raised process priority on macOS to ' + observed +
                ' to prevent App Nap / QoS demotion.');
            } else {
              console.warn('[evolver] setPriority(-10) reported success but observed priority is ' +
                observed + '; App Nap protection NOT in effect. ' +
                'Run with EVOLVER_CAFFEINATE=1 or via `caffeinate -is node index.js --loop`.');
            }
          } catch (e) {
            console.warn('[evolver] setPriority(-10) refused (' + (e && e.code || 'unknown') +
              '): ' + (e && e.message || e) + '. App Nap protection NOT in effect. ' +
              'Run with EVOLVER_CAFFEINATE=1 or via `caffeinate -is node index.js --loop`.');
          }
          // Round-5: caffeinate side-child. Round-4 made this opt-in via
          // EVOLVER_CAFFEINATE=1 to avoid the extra Activity-Monitor row;
          // the round-5 audit found that 99% of users never set the env
          // var, so the App Nap fallback was effectively unused. Promote
          // to default-on when the priority boost did NOT land (so we
          // either have priority or have caffeinate, never neither),
          // unless the user has explicitly opted out via
          // EVOLVER_CAFFEINATE=0. The combined effect: a fresh laptop
          // user gets at least one layer of throttle protection without
          // having to learn about either env var.
          const caffeinateRaw = String(process.env.EVOLVER_CAFFEINATE || '').toLowerCase().trim();
          const caffeinateOptedIn = caffeinateRaw === '1' || caffeinateRaw === 'true';
          const caffeinateOptedOut = caffeinateRaw === '0' || caffeinateRaw === 'false';
          const caffeinateFallback = !priorityBoostOk && !caffeinateOptedOut;
          if (caffeinateOptedIn || caffeinateFallback) {
            try {
              const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], {
                detached: true,
                stdio: 'ignore',
              });
              child.unref();
              console.log('[evolver] Spawned caffeinate -i -w ' + process.pid +
                ' to block App Nap (pid ' + child.pid + ').' +
                (caffeinateFallback ? ' (fallback because priority boost was refused)' : ''));
            } catch (e) {
              console.warn('[evolver] caffeinate spawn failed: ' +
                (e && e.message || e) + '. App Nap may throttle the heartbeat. ' +
                'Install caffeinate (Xcode CLT) or run under a launchd plist with NSAppSleepDisabled=1.');
            }
          }
        }

        // Event-loop keep-alive anchor (defense-in-depth for the sleepMs fix).
        //
        // All timers in a2aProtocol.js (heartbeat, drift detector, self-driving
        // poll, SSE reconnect) are unref'd so they never prevent a clean exit.
        // The sleepMs() timer above is now ref'd (the primary fix), but as an
        // additional safety net we install one ref'd setInterval here that fires
        // every 10 minutes. Its only job is to emit a lightweight log line so
        // the evolver_loop.log gets touched even when the daemon is completely
        // idle (no session signals, evolve cycle sleeping at maxSleepMs). This
        // guarantees the event loop has at least one ref'd handle at all times
        // while the daemon is running, and provides a heartbeat-on-disk so
        // lifecycle.checkHealth() (MAX_SILENCE_MS = 30 min default) does not
        // wrongly declare the process stagnant during legitimate long idle windows.
        // Cleared in shutdown() so it does not outlive the daemon.
        const _KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;
        let _keepAliveTimer = setInterval(function () {
          try {
            // Inline append that mirrors a2aProtocol._appendHeartbeatLog's
            // ENOENT-retry (that helper is not exported).
            const a2aKA = require('./src/gep/a2aProtocol');
            if (typeof a2aKA.getHeartbeatStats === 'function') {
              const s = a2aKA.getHeartbeatStats();
              const { getEvolverLogPath } = require('./src/gep/paths');
              const fsKA = require('fs');
              const pathKA = require('path');
              try {
                const logPath = getEvolverLogPath();
                fsKA.mkdirSync(pathKA.dirname(logPath), { recursive: true });
                const line = JSON.stringify({
                  ts: new Date().toISOString(),
                  type: 'keepalive_tick',
                  hb_running: s.running,
                  hb_last_tick_ago_s: s.lastTickAt ? Math.round((Date.now() - s.lastTickAt) / 1000) : null,
                }) + '\n';
                try {
                  fsKA.appendFileSync(logPath, line, { encoding: 'utf8' });
                } catch (e) {
                  if (e && e.code === 'ENOENT') {
                    try {
                      fsKA.mkdirSync(pathKA.dirname(logPath), { recursive: true });
                      fsKA.appendFileSync(logPath, line, { encoding: 'utf8' });
                    } catch (_) { /* log destination broken; do not throw out */ }
                  }
                }
              } catch (_) { /* never let the log write kill the timer */ }
            }
          } catch (_) { /* never let any error kill the keep-alive timer */ }
        }, _KEEPALIVE_INTERVAL_MS);
        // Intentionally ref'd: this is the explicit event-loop anchor.
        // Do NOT add .unref() here -- that would defeat the purpose.

        function shutdown() {
          if (_keepAliveTimer) { clearInterval(_keepAliveTimer); _keepAliveTimer = null; }
          stopLockRefresh();
          releaseLock();
          // stopHeartbeat() clears the drift detector interval and the heartbeat
          // timer, preventing "ghost tick" log noise after exit and ensuring a
          // clean state if the process is somehow continued (test harness, etc.).
          try { require('./src/gep/a2aProtocol').stopHeartbeat(); } catch (e) {}
          try { require('./src/gep/a2aProtocol').stopEventStream(); } catch (e) {}
        }
        process.on('exit', shutdown);
        process.on('SIGINT', () => { shutdown(); process.exit(); });
        process.on('SIGTERM', () => { shutdown(); process.exit(); });
        // SIGHUP: two meanings depending on platform and how the daemon was started.
        //
        // macOS / interactive terminal: closing the iTerm/Terminal tab sends
        // SIGHUP to the controlling process, and Node's default action is to
        // terminate. That is the most common "first-launch, then idle, then
        // evolver dead" path on macOS. As a daemon we intentionally ignore it.
        //
        // Linux systemd: `systemctl reload evolver` delivers SIGHUP to signal
        // configuration reload. The socket / connection state may be stale (e.g.
        // the hub URL changed in .env, or the admin wants a fresh hello after a
        // manual secret rotation). We treat reload as a soft wake-recovery: drain
        // the undici pool, poke the heartbeat, and restart the SSE stream, which
        // is identical to what SIGCONT / the drift detector do on system resume.
        // We also emit sd_notify RELOADING=1 / READY=1 so systemd can track the
        // reload state (required for Type=notify units that call systemctl reload).
        //
        // A one-shot (non --loop) invocation keeps the default behavior because
        // this branch is gated on `isLoop`.
        process.on('SIGHUP', () => {
          try {
            if (process.platform === 'linux') {
              // On Linux, SIGHUP from systemd means reload, not terminal close.
              // Announce reload state to the service manager first so systemd
              // does not time out waiting, then perform the recovery, then signal
              // READY=1 again to confirm we are back in steady state.
              try {
                const a2aForSd = require('./src/gep/a2aProtocol.js');
                if (typeof a2aForSd._sdNotify === 'function') {
                  // MONOTONIC_USEC requires microseconds from the monotonic clock.
                  // process.hrtime() returns [sec, nsec] from a fixed epoch;
                  // avoids BigInt literals for Node <10.3 compatibility.
                  const _hrt = process.hrtime();
                  const _monUsec = _hrt[0] * 1000000 + Math.floor(_hrt[1] / 1000);
                  a2aForSd._sdNotify('RELOADING=1\nMONOTONIC_USEC=' + _monUsec);
                }
              } catch (_) {}
              console.warn('[evolver] Received SIGHUP on Linux (systemctl reload?). ' +
                'Running wake recovery (drain pool + poke heartbeat + restart SSE). ' +
                'To stop the daemon use SIGINT/SIGTERM.');
              try {
                const a2a = require('./src/gep/a2aProtocol.js');
                if (typeof a2a._runWakeRecovery === 'function') a2a._runWakeRecovery();
              } catch (_) {}
              // Interrupt any pending sleepMs so the evolve loop picks up
              // immediately after the reload rather than sitting out its window.
              try { _interruptAllSleeps(); } catch (_) {}
              // Signal READY=1 to close the RELOADING window. systemd will mark
              // the reload complete once it sees this notification.
              try {
                const a2aForSd2 = require('./src/gep/a2aProtocol.js');
                if (typeof a2aForSd2._sdNotify === 'function') {
                  a2aForSd2._sdNotify('READY=1');
                }
              } catch (_) {}
            } else {
              // macOS / non-systemd: terminal-close semantics, ignore the signal.
              console.warn('[evolver] Received SIGHUP (controlling terminal closed?). ' +
                'Daemon ignoring -- heartbeat loop continues. To stop the daemon use SIGINT/SIGTERM.');
            }
          } catch (_) {}
        });
        // SIGCONT fires on `kill -CONT`, debugger detach, and some VM/sleep
        // resume paths. Nudge the heartbeat loop so it doesn't sit waiting for
        // its next scheduled tick (which could be up to 30 min away under
        // backoff) before reconnecting after a wake event. Also restart the
        // SSE stream: the underlying TCP socket almost certainly died during
        // the SIGSTOP window without a FIN reaching us, and the existing
        // exponential reconnect could be up to 120s away on the resumed
        // monotonic clock.
        // Round-6 (§19.5): register process-level wake hooks so both the
        // SIGCONT handler and the drift detector's long-sleep branch
        // (a2aProtocol) interrupt the outer evolve sleepMs and poke the
        // validator daemon, not just the heartbeat-internal recovery.
        _registerProcessWakeHooks();
        // SIGCONT is not supported on Windows (process.on() throws ERR_UNKNOWN_SIGNAL).
        // Wake recovery on Windows is handled exclusively by the drift detector.
        if (process.platform !== 'win32') {
          process.on('SIGCONT', () => {
            // Real recovery delegates to a2aProtocol._runWakeRecovery so
            // SIGCONT and the drift detector share one code path. NOTE:
            // per followups §18.2, SIGCONT is never sent by the macOS
            // kernel on system wake; this handler primarily covers:
            //   - hypervisor/docker resume (container unpause)
            //   - `kill -CONT <pid>` from operators or supervisors
            //   - Linux debugger attach/detach (ptrace SIGSTOP+SIGCONT;
            //     on Linux this is a true job-control signal unlike macOS)
            //   - `docker unpause` (sends SIGCONT to all cgroup processes)
            // Bare-metal macOS wake recovery is driven by the drift
            // detector only. _runWakeRecovery() has a 1s debounce gate so
            // a rapid burst (e.g. gdb repeatedly attaching) collapses into
            // one recovery without leaking undici agents or SSE connections.
            try {
              const a2a = require('./src/gep/a2aProtocol.js');
              if (typeof a2a._runWakeRecovery === 'function') a2a._runWakeRecovery();
            } catch (_) {}
          });
        }
        process.on('uncaughtException', (err) => {
          console.error('[FATAL] Uncaught exception:', err && err.stack ? err.stack : String(err));
          releaseLock();
          process.exit(1);
        });
        // Sliding window: only exit if many rejections cluster in a short
        // period AND the daemon shows no other signs of life. A daemon
        // running for weeks can accumulate harmless, unrelated rejections
        // (transient network blips, hub timeouts); the original cumulative
        // counter would eventually kill the process for noise. Cluster =
        // real failure cascade. But macOS wake bursts also synthesize
        // clusters: heartbeat / SSE / validator / merchantAgent / ATP all
        // fire near-simultaneously on resume and any subsystem with an
        // unhandled async-callback throw can blow past 5 rejections in
        // seconds. We add a liveness gate so an actively-recovering
        // daemon doesn't kill itself in the middle of a wake-recovery
        // storm. Threshold and window widened to match the macOS-wake
        // amplification observed in round-2 testing.
        const REJECTION_WINDOW_MS = 5 * 60 * 1000;
        const REJECTION_THRESHOLD = 10;
        const RECENT_LIVENESS_MS = 60 * 1000;
        let _rejectionTimestamps = [];
        function _heartbeatLooksAlive() {
          // Round-6 (§19.8): the previous implementation reached into
          // the `_testing` namespace and returned false (= "treat as
          // dead, exit on cluster") if that test-only accessor was
          // unavailable. Under bundling / minification / a future
          // refactor that drops the `_testing` export, this turned a
          // recovery storm into a guaranteed exit -- the OPPOSITE of
          // what the gate exists to do. Switched to the public
          // getHeartbeatStats() API (which surfaces `running` and
          // `lastTickAt` for exactly this purpose) and made the
          // require failure path "fail open" -- assume alive so we
          // don't kill an actively-recovering daemon just because the
          // module load failed on this turn.
          //
          // Round-10: `running` + recent `lastTickAt` alone are not
          // enough to claim "alive." `lastTickAt` is stamped at the
          // TOP of every heartbeat tick, regardless of whether the
          // tick actually makes progress -- including ticks that
          // immediately bail out because the loop is spinning in a
          // reauth backoff window (see a2aProtocol.js getHeartbeatStats
          // comment near :2940, which acknowledges that the loop
          // showed `running: true, lastTickAt: <recent>` even when
          // silent for 30 min waiting on a reauth backoff). In that
          // state a rejection cascade originating OUTSIDE the
          // heartbeat would be repeatedly forgiven while the loop is
          // not actually making forward progress. Require additionally
          // that `consecutiveFailures === 0` and that we are not
          // currently inside a reauth backoff window, so "alive" means
          // "making progress," not just "ticking."
          //
          // Trade-off: a transient hub blip that bumps
          // `consecutiveFailures` to 1 will now NOT forgive a
          // concurrent rejection cascade. That is intentional --
          // cascade-forgiveness exists to avoid flapping during a
          // healthy loop; during an unhealthy loop we should not keep
          // absorbing rejections silently.
          try {
            const a2a = require('./src/gep/a2aProtocol.js');
            if (!a2a || typeof a2a.getHeartbeatStats !== 'function') {
              // Cannot read state -- fail open. A real wedged daemon
              // will be caught by the next rejection if/when stats
              // become available, or by other watchdogs.
              return true;
            }
            const s = a2a.getHeartbeatStats();
            if (!s || !s.running) return false;
            const last = s.lastTickAt || 0;
            if (!(last > 0 && (Date.now() - last) < RECENT_LIVENESS_MS)) return false;
            // Round-10: gate on success state, not just tick freshness.
            if ((s.consecutiveFailures || 0) > 0) return false;
            if ((s.reauthBackoffUntil || 0) > Date.now()) return false;
            return true;
          } catch (_) {
            // Module load threw -- fail open for the same reason as
            // above. A genuinely broken require would surface via
            // uncaughtException long before this gate matters.
            return true;
          }
        }
        process.on('unhandledRejection', (reason) => {
          const now = Date.now();
          _rejectionTimestamps.push(now);
          _rejectionTimestamps = _rejectionTimestamps.filter(function (t) {
            return now - t < REJECTION_WINDOW_MS;
          });
          console.error('[FATAL] Unhandled promise rejection (' + _rejectionTimestamps.length + ' in window):', reason && reason.stack ? reason.stack : String(reason));
          if (_rejectionTimestamps.length >= REJECTION_THRESHOLD) {
            if (_heartbeatLooksAlive()) {
              console.warn('[FATAL] ' + _rejectionTimestamps.length + ' rejections within ' +
                (REJECTION_WINDOW_MS / 1000) + 's BUT heartbeat ticked in the last ' +
                (RECENT_LIVENESS_MS / 1000) + 's. Treating as recovery storm, not exiting. ' +
                'Resetting rejection window so a real subsequent cascade can still trip the trap.');
              _rejectionTimestamps = [];
              return;
            }
            console.error('[FATAL] ' + _rejectionTimestamps.length + ' unhandled rejections within ' + (REJECTION_WINDOW_MS / 1000) + 's and no recent heartbeat activity. Exiting to avoid corrupt state.');
            releaseLock();
            process.exit(1);
          }
        });

        process.env.EVOLVE_LOOP = 'true';
        // Issue #96: from v1.85.0, --loop defaults EVOLVE_BRIDGE=true so the
        // daemon actually evolves the working tree. The previous default of
        // 'false' caused 33 days of empty cycling on Aurora — every cycle
        // hit rejectPendingRun(reason=loop_bridge_disabled_autoreject_no_rollback)
        // and produced no EvolutionEvent. Failed cycles still recover safely
        // via rollbackTracked (src/gep/gitOps.js#rollbackTracked, mode=stash
        // by default since v1.81.0): the daemon's changes get pushed to a
        // stash entry the user can recover with `git stash pop`.
        // Set EVOLVE_BRIDGE=false explicitly to opt back into observe-only.
        const bridgeMode = resolveLoopBridgeMode(process.env);
        console.log(`Loop mode enabled (internal daemon, bridge=${bridgeMode.value}, verbose=${isVerbose}).`);
        for (const line of bridgeMode.banner) console.warn(line);

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

        // Hub outcome mirror diagnostic. memoryGraph.syncEventToHub posts every
        // outcome/attempt/solidify/skill_emit event to <hub>/a2a/memory/event
        // by default, which is what populates this node's recall stream from
        // the Hub side (consumed by gep-mcp-server's gep_recall). It is silent
        // best-effort: failures don't crash the daemon but also don't surface,
        // so users get a "why does gep_recall return 0 matches" puzzle. A
        // single startup line says explicitly whether the mirror is on, what
        // node it would post as, and what to flip if you want it off.
        try {
          const a2a = require('./src/gep/a2aProtocol');
          const mirrorOff = process.env.MEMORY_GRAPH_SYNC_HUB === '0';
          const hubUrl = typeof a2a.getHubUrl === 'function' ? a2a.getHubUrl() : '';
          const nodeId = typeof a2a.getNodeId === 'function' ? a2a.getNodeId() : '';
          const hasSecret = typeof a2a.getHubNodeSecret === 'function' && !!a2a.getHubNodeSecret();
          if (mirrorOff) {
            console.log('[HubMirror] DISABLED — set MEMORY_GRAPH_SYNC_HUB=1 (or unset it) to mirror outcome events to <hub>/a2a/memory/event.');
          } else if (!hubUrl || !nodeId || !hasSecret) {
            console.log(`[HubMirror] inactive — missing one of: hub=${hubUrl ? 'OK' : 'MISSING'} node_id=${nodeId ? 'OK' : 'MISSING'} secret=${hasSecret ? 'OK' : 'MISSING'}. Local memory graph is unaffected.`);
          } else {
            console.log(`[HubMirror] ENABLED — outcome/attempt/solidify/skill_emit events mirror to ${hubUrl}/a2a/memory/event as ${nodeId}. Set MEMORY_GRAPH_SYNC_HUB=0 to disable.`);
          }
        } catch (_mirrorDiagErr) { /* diagnostics must never block startup */ }

        // RecallVerify diagnostic banner: parallel to HubMirror but reads its
        // own env, since verification can run with HubMirror off (verifier
        // events are local-only on first ship).
        try {
          const enabled = String(process.env.EVOLVE_RECALL_VERIFY || '0') === '1';
          const sampleRateRaw = Number(process.env.EVOLVE_RECALL_VERIFY_SAMPLE_RATE);
          const sampleRate = Number.isFinite(sampleRateRaw) && sampleRateRaw >= 0 && sampleRateRaw <= 1 ? sampleRateRaw : 1.0;
          if (!enabled) {
            console.log('[RecallVerify] DISABLED (default) — opt-in observability only. Set EVOLVE_RECALL_VERIFY=1 to verify published assets round-trip via Hub Phase 2 lookup.');
          } else {
            console.log(`[RecallVerify] ENABLED — verifying published assets via Hub Phase 2 lookup, sample_rate=${sampleRate}. Set EVOLVE_RECALL_VERIFY=0 to disable.`);
          }
        } catch (_rvDiagErr) { /* diagnostics must never block startup */ }

        const { getEvolutionDir, getEvolverLogPath } = require('./src/gep/paths');
        const solidifyStatePath = path.join(getEvolutionDir(), 'evolution_solidify_state.json');
        const cycleProgressPath = path.join(getEvolutionDir(), 'cycle_progress.json');

        const minSleepMs = parseMs(process.env.EVOLVER_MIN_SLEEP_MS, 2000);
        const maxSleepMs = parseMs(process.env.EVOLVER_MAX_SLEEP_MS, 300000);
        const idleThresholdMs = parseMs(process.env.EVOLVER_IDLE_THRESHOLD_MS, 500);
        const pendingSleepMs = parseMs(
          process.env.EVOLVE_PENDING_SLEEP_MS ||
            process.env.EVOLVE_MIN_INTERVAL,
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
            try {
              const { injectProxyEnv } = require('./src/proxy/inject');
              const injected = injectProxyEnv(proxyInfo);
              if (injected.injected) {
                console.log('[Proxy] Auto-injected client env for Claude Code/Codex/Cursor. Set EVOMAP_PROXY_AUTO_INJECT=off to disable.');
              } else {
                console.log('[Proxy] Auto-inject skipped: ' + injected.reason);
              }
            } catch (injectErr) {
              console.warn('[Proxy] Auto-inject failed: ' + (injectErr && injectErr.message || injectErr));
            }
            const { registerMailboxTransport } = require('./src/gep/mailboxTransport');
            registerMailboxTransport();
            process.env.A2A_TRANSPORT = 'mailbox';
            try {
              const a2a = require('./src/gep/a2aProtocol');
              a2a.startSystemdNotifyWatchdog(function () {
                try {
                  const proxy = proxyInfo && proxyInfo.proxy;
                  const lifecycle = proxy && proxy.lifecycle;
                  if (lifecycle && typeof lifecycle.getHeartbeatStats === 'function') {
                    const stats = lifecycle.getHeartbeatStats();
                    // Hub-backed lifecycle stats are authoritative even when stopped;
                    // systemd should starve and restart instead of seeing a false ping.
                    if (stats && (stats.running || proxy.hubUrl)) return stats;
                  }
                } catch (_) {}
                return { running: true, consecutiveFailures: 0, lastTickAt: Date.now() };
              });
            } catch (sdErr) {
              console.warn('[Heartbeat] systemd notify/watchdog setup failed: ' + (sdErr && sdErr.message || sdErr));
            }
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

        // RecallVerify worker: starts once per process; drains the publish-
        // verification queue with backoff. unref'd so it never blocks exit.
        try {
          if (String(process.env.EVOLVE_RECALL_VERIFY || '0') === '1') {
            require('./src/gep/recallVerifier').startWorker();
          }
        } catch (rvStartErr) {
          console.warn('[RecallVerify] startWorker failed: ' + (rvStartErr && rvStartErr.message || rvStartErr));
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

        // OAuth token auto-refresh: if a device-flow OAuth token is present,
        // keep it fresh in the background so long-running `evolver run` loops
        // never hit an expired a2a token mid-request. No-op for node_secret nodes.
        try {
          const { loadOAuthToken, startTokenAutoRefresh } = require('./src/gep/oauthLogin');
          if (loadOAuthToken()) {
            startTokenAutoRefresh();
            console.log('[OAuth] token auto-refresh scheduled.');
          }
        } catch (oauthRefreshErr) {
          console.warn('[OAuth] auto-refresh setup failed: ' + (oauthRefreshErr && oauthRefreshErr.message || oauthRefreshErr));
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

        // ATP: capability-gap auto-buyer. OPT-IN as of consent-required
        // change — new installs do not auto-spend until the user explicitly
        // runs `evolver atp enable` or answers `y` at the first-run prompt.
        // Also starts the merchant-side auto-deliver daemon so claimed ATP
        // tasks actually call submitDelivery and settle instead of expiring.
        try {
          try {
            const { runPrompt } = require('./src/atp/cliAutobuyPrompt');
            await runPrompt();
          } catch (promptErr) {
            console.warn('[ATP-AutoBuyer] first-run prompt failed: ' + (promptErr && promptErr.message || promptErr));
          }
          const { autoBuyer } = require('./src/atp');
          const consent = autoBuyer.getConsent();
          if (consent.enabled) {
            const hubUrl = process.env.A2A_HUB_URL || process.env.EVOMAP_HUB_URL || '';
            if (hubUrl) {
              // Round-5: previously this bare start() call was a true
              // fire-and-forget. If autoBuyer.start returned a rejected
              // promise (transient hub error, bad config, mid-wake DNS
              // flap), the unhandledRejection escaped to the
              // process-level handler -- which, post round-3, only
              // exits if heartbeat is also dead. Net effect: daemon
              // stays alive but the autobuyer is half-initialized and
              // silently ignores claims. Attach a catch so the
              // operator can see the failure and the daemon-survival
              // gate is not relied on.
              try {
                const _autoBuyerPromise = autoBuyer.start({
                  dailyCap: Number(process.env.ATP_AUTOBUY_DAILY_CAP_CREDITS) || undefined,
                  perOrderCap: Number(process.env.ATP_AUTOBUY_PER_ORDER_CAP_CREDITS) || undefined,
                });
                if (_autoBuyerPromise && typeof _autoBuyerPromise.catch === 'function') {
                  _autoBuyerPromise.catch(function (abErr) {
                    console.warn('[ATP-AutoBuyer] start() rejected: ' + (abErr && abErr.message || abErr));
                  });
                }
              } catch (abSyncErr) {
                console.warn('[ATP-AutoBuyer] start() threw synchronously: ' + (abSyncErr && abSyncErr.message || abSyncErr));
              }
              if (consent.source === 'default') {
                // First-run on a non-TTY (daemon, hook, CI) where the prompt
                // could not fire AND no env override + no ack file. autoBuyer
                // is starting with the default-on policy — surface a single
                // WARN per process so users see what is happening and how to
                // opt out, instead of discovering it via a credit balance dip.
                let safeHubUrl;
                try { safeHubUrl = new URL(hubUrl).origin; }
                catch { safeHubUrl = '(configured)'; }
                console.warn('[ATP-AutoBuyer] ATP auto-spend is ON (default for new installs).');
                console.warn('               Hub: ' + safeHubUrl + '  Caps: ' +
                  (process.env.ATP_AUTOBUY_DAILY_CAP_CREDITS || '50') + ' credits/day, ' +
                  (process.env.ATP_AUTOBUY_PER_ORDER_CAP_CREDITS || '10') + '/order' +
                  ' (cold-start half-cap for the first 5 min).');
                console.warn('               To opt out: evolver atp disable  (or EVOLVER_ATP_AUTOBUY=off)');
              }
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
              // Round-5: same fire-and-forget hardening as autoBuyer above.
              try {
                const _autoDeliverPromise = autoDeliver.start({
                  pollMs: Number(process.env.ATP_AUTODELIVER_POLL_MS) || undefined,
                });
                if (_autoDeliverPromise && typeof _autoDeliverPromise.catch === 'function') {
                  _autoDeliverPromise.catch(function (adErr) {
                    console.warn('[ATP-AutoDeliver] start() rejected: ' + (adErr && adErr.message || adErr));
                  });
                }
              } catch (adSyncErr) {
                console.warn('[ATP-AutoDeliver] start() threw synchronously: ' + (adSyncErr && adSyncErr.message || adSyncErr));
              }
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
        const { autoDistillLlm } = require('./src/gep/autoDistillLlm'); // P3: autonomous LLM distillation (shadow-first, off by default)
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
                // P3: autonomous LLM-quality distillation of SUCCESS capsules.
                // Default off; shadow logs a candidate; enforce upserts (after a
                // real run-green gate). Reuses the P1 exec bridge under the hood.
                if ((process.env.EVOLVER_AUTO_DISTILL_LLM || 'off') !== 'off') {
                  try {
                    const llmRes = await autoDistillLlm();
                    if (llmRes && llmRes.ok && llmRes.gene) {
                      console.log('[OMLS] Idle-window LLM distillation enforced gene: ' + llmRes.gene.id);
                    } else if (llmRes && llmRes.reason === 'shadow_logged') {
                      console.log('[OMLS] LLM distillation shadow candidate: ' + (llmRes.candidate && llmRes.candidate.id));
                    }
                  } catch (e) {
                    if (isVerbose) console.warn('[OMLS] LLM distill error (non-fatal): ' + (e.message || e));
                  }
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
              // P2: conversation capability -> distilled gene (shadow-only v1).
              // Deliberately OUTSIDE the should_distill guard: should_distill is
              // true only at aggressive/deep intensity, but headless/air-gapped
              // hosts fall back to 'normal', which would make P2 a dead feature.
              // A freshly-discovered capability is time-relevant; gate it solely on
              // its own flag + the per-slug cooldown + a non-empty queue (all of
              // which already bound spend). Default off => zero behavior change.
              if ((process.env.EVOLVER_CONV_DISTILL_ENABLED || 'off') !== 'off') {
                try {
                  const { autoDistillConversation } = require('./src/gep/autoDistillConv');
                  const convRes = await autoDistillConversation();
                  if (convRes && convRes.ok) console.log('[P2] conv-distill ' + convRes.mode + ' candidate: ' + (convRes.gene_id || convRes.reason));
                } catch (e) {
                  if (isVerbose) console.warn('[P2] conv-distill error (non-fatal): ' + (e.message || e));
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
      const res = await solidify({
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
  } else if (command === 'exec') {
    // node index.js exec --harness=claude-code [--once] [--max-cycles N]
    // P1 auto-exec bridge: run the Brain, scrape its sessions_spawn(...), spawn
    // the Hand (headless claude) to apply + solidify. Shadow-first opt-in.
    if (String(process.env.EVOLVE_EXEC_BRIDGE || '').toLowerCase() !== 'true') {
      console.error('[exec] EVOLVE_EXEC_BRIDGE is not "true". The auto-exec bridge is opt-in. Refusing.');
      process.exit(2);
    }
    const getFlag = (n) => {
      const i = args.findIndex(a => a === `--${n}` || a.startsWith(`--${n}=`));
      if (i === -1) return undefined;
      const h = args[i];
      if (h.includes('=')) return h.split('=').slice(1).join('='); // --n=value
      // bare --n: if the next token is a value (not another --flag), consume it
      // (#179 r6: support `--max-cycles N` space-separated, not just =N). A
      // trailing bare flag with no following value stays boolean true (e.g. --once).
      const next = args[i + 1];
      return (next !== undefined && !next.startsWith('--')) ? next : true;
    };
    const harness = String(getFlag('harness') || 'claude-code');
    const once = getFlag('once') === true;
    // #179 r7: validate --max-cycles. Number('foo')||0 silently became 0 =
    // unbounded daemon — a typo must fail fast, not run forever. Absent flag =>
    // 0 (intentional unbounded). A present value must be a non-negative integer.
    const rawMaxCycles = getFlag('max-cycles');
    let maxCycles = 0;
    if (rawMaxCycles !== undefined && rawMaxCycles !== true) {
      const n = Number(rawMaxCycles);
      if (!Number.isInteger(n) || n < 0) {
        console.error(`[exec] invalid --max-cycles '${rawMaxCycles}' (expected a non-negative integer; 0 or omit = unbounded)`);
        process.exit(2);
      }
      maxCycles = n;
    } else if (rawMaxCycles === true) {
      console.error('[exec] --max-cycles requires a value (e.g. --max-cycles 5 or --max-cycles=5)');
      process.exit(2);
    }
    if (!['claude-code', 'openclaw', 'codex', 'opencode'].includes(harness)) {
      console.error(`[exec] unknown --harness '${harness}' (expected claude-code | openclaw | codex | opencode)`);
      process.exit(2);
    }
    try {
      const { runExecBridge } = require('./src/gep/execBridge');
      const res = await runExecBridge({ harness, once, maxCycles });
      console.log(`[exec] done: cycles=${res.cycles} lastOutcome=${res.lastOutcome}`);
      // Exit 0 only on a genuine success. A bounded/daemon run that ended in
      // hand_failed/brain_failed/no_spawn must report non-zero to shells & CI
      // (Bugbot #179: do not exit 0 on failure just because cycles>0).
      process.exit(res.lastOutcome === 'success' ? 0 : 1);
    } catch (error) {
      console.error('[exec] bridge error:', error && error.message ? error.message : error);
      process.exit(1);
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
      const unstaged = execSync('git diff', { cwd: repoRoot, encoding: 'utf8', timeout: 30000, maxBuffer: MAX_EXEC_BUFFER, windowsHide: true }).trim();
      const staged = execSync('git diff --cached', { cwd: repoRoot, encoding: 'utf8', timeout: 30000, maxBuffer: MAX_EXEC_BUFFER, windowsHide: true }).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', { cwd: repoRoot, encoding: 'utf8', timeout: 10000, maxBuffer: MAX_EXEC_BUFFER, windowsHide: true }).trim();
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
        const res = await solidify({
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
        execSync('git checkout -- .', { cwd: repoRoot, encoding: 'utf8', timeout: 30000, maxBuffer: MAX_EXEC_BUFFER, windowsHide: true });
        // Preserve user state on reject: .env files, node_modules, runtime
        // PID files, and a dedicated workspace/ dir (if one exists) MUST NOT
        // be wiped by an automated rollback. Users have reported losing
        // secrets and runtime caches to an aggressive git clean.
        execSync('git clean -fd -e node_modules -e workspace -e .env -e ".env.*" -e "*.pid"', {
          cwd: repoRoot, encoding: 'utf8', timeout: 30000, maxBuffer: MAX_EXEC_BUFFER, windowsHide: true,
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
    const { hubFetch } = require('./src/gep/hubFetch');

    const hubUrl = getHubUrl();
    if (!hubUrl) {
      console.error('[fetch] A2A_HUB_URL is not configured.');
      console.error('Set it via environment variable or .env file:');
      console.error('  export A2A_HUB_URL=https://evomap.ai');
      process.exit(1);
    }

    try {
      if (!getHubNodeSecret()) {
        // Round-7 (§20.7): if a daemon is up and we have no secret, we
        // would race the daemon's hello and silently corrupt its
        // node_secret. Refuse cleanly with a hint instead.
        refuseHelloIfDaemonRunning('fetch');
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

      const resp = await hubFetch(endpoint, {
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
          console.error('    https://github.com/EvoMap/evolver/issues');
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
    const { hubFetch } = require('./src/gep/hubFetch');
    const { upsertGene, upsertCapsule, loadGenes, loadCapsules } = require('./src/gep/assetStore');
    const { getGepAssetsDir, getMemoryDir } = require('./src/gep/paths');

    const hubUrl = getHubUrl();
    if (!hubUrl) {
      console.error('[sync] A2A_HUB_URL is not configured.');
      process.exit(1);
    }

    try {
      if (!getHubNodeSecret()) {
        // Round-7 (§20.7): refuse a fresh hello if a live daemon owns
        // the lock; the daemon's secret will appear shortly.
        refuseHelloIfDaemonRunning('sync');
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
          const resp = await hubFetch(url, {
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
            const detailResp = await hubFetch(baseUrl + '/a2a/assets/' + encodeURIComponent(assetId) + '?detailed=true', {
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

  } else if (command === 'login') {
    const { deviceLogin, resolveHubUrl, tokenFile } = require('./src/gep/oauthLogin');
    const hubUrl = resolveHubUrl();
    try {
      console.log('Logging in to ' + hubUrl + ' ...');
      const tok = await deviceLogin({
        hubUrl,
        onCode: ({ userCode, verificationUri }) => {
          console.log('\nTo authorize this device:');
          console.log('  1. open  ' + verificationUri);
          console.log('  2. enter code:  ' + userCode);
          console.log('\nWaiting for approval (Ctrl-C to cancel)...');
        },
      });
      console.log('\n✓ Logged in. Token stored at ' + tokenFile() + ' (expires ' + new Date(tok.expires_at).toISOString() + ').');
      process.exit(0);
    } catch (error) {
      console.error('login failed: ' + (error && error.message || error));
      process.exit(1);
    }

  } else if (command === 'logout') {
    const { clearOAuthToken, tokenFile } = require('./src/gep/oauthLogin');
    const removed = clearOAuthToken();
    console.log(removed ? ('Logged out (removed ' + tokenFile() + ').') : 'No OAuth token to remove.');
    process.exit(0);

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

  } else if (command === 'reset-local-secret') {
    // Wipe every local store of node_secret in one shot, so a daemon stuck
    // after a manual web reset (https://evomap.ai/account -> Reset Secret)
    // can boot clean. Local stores involved:
    //   - MailboxStore: ~/.evomap/mailbox/state.json key node_secret + version
    //   - Legacy files: ~/.evomap/node_secret and ~/.evomap/node_secret_version
    //   - Shell env:    A2A_NODE_SECRET / EVOMAP_NODE_SECRET and matching
    //                   version vars (we cannot mutate the parent shell; we
    //                   just print the unset hint)
    const path = require('path');
    const fs = require('fs');
    // Honor an explicit HOME override (used by tests to redirect to a fake
    // home) before falling back to os.homedir(). On POSIX, os.homedir() also
    // reads $HOME first, so this is a no-op in practice on macOS/Linux. On
    // Windows, os.homedir() reads %USERPROFILE% and ignores HOME -- without
    // this fallback, test/resetLocalSecret.test.js cannot inject a fake home
    // and the reset operates on the real user dir.
    const home = process.env.HOME || os.homedir();
    const stateFile = path.join(home, '.evomap', 'mailbox', 'state.json');
    const legacyFile = path.join(home, '.evomap', 'node_secret');
    const legacyVersionFile = path.join(home, '.evomap', 'node_secret_version');
    let cleared = 0;
    try {
      if (fs.existsSync(stateFile)) {
        const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        let mutated = false;
        for (const k of ['node_secret', 'node_secret_source', 'node_secret_version']) {
          if (raw[k] !== undefined && raw[k] !== '') {
            raw[k] = '';
            mutated = true;
          }
        }
        if (mutated) {
          fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');
          cleared += 1;
          console.log('[reset-local-secret] cleared MailboxStore at ' + stateFile);
        } else {
          console.log('[reset-local-secret] MailboxStore had no node_secret to clear');
        }
      }
      if (fs.existsSync(legacyFile)) {
        fs.unlinkSync(legacyFile);
        cleared += 1;
        console.log('[reset-local-secret] removed legacy file ' + legacyFile);
      }
      if (fs.existsSync(legacyVersionFile)) {
        fs.unlinkSync(legacyVersionFile);
        cleared += 1;
        console.log('[reset-local-secret] removed legacy file ' + legacyVersionFile);
      }
    } catch (err) {
      console.error('[reset-local-secret] error:', err && err.message || err);
      process.exit(1);
    }
    const stillSetEnv = [
      'A2A_NODE_SECRET',
      'A2A_NODE_SECRET_VERSION',
      'EVOMAP_NODE_SECRET',
      'EVOMAP_NODE_SECRET_VERSION',
    ].filter((key) => process.env[key]);
    if (stillSetEnv.length > 0) {
      console.log('');
      console.log('[reset-local-secret] Node secret env vars are still set in this shell: ' + stillSetEnv.join(', '));
      console.log('[reset-local-secret] Run:    unset A2A_NODE_SECRET A2A_NODE_SECRET_VERSION EVOMAP_NODE_SECRET EVOMAP_NODE_SECRET_VERSION');
      console.log('[reset-local-secret] Or update secret and version as a matched pair before restarting the daemon.');
    } else {
      console.log('[reset-local-secret] Node secret env vars are not set in env -- good.');
    }
    console.log('[reset-local-secret] ' + cleared + ' location(s) cleared. Restart the daemon to pick a fresh secret from the hub.');
    process.exit(0);

  } else if (command === 'atp-complete') {
    // Invoked by a spawned Cursor sub-session after it has written the ATP
    // task answer to a file. Drives publish -> task/complete -> atp/deliver.
    try {
      // Round-8 (§21.8): if a daemon is up and the spawned subsession
      // somehow has no secret on disk, the inner completeAtpTask ->
      // _ensureNodeSecret -> sendHelloToHub call would race the
      // daemon's hello and silently corrupt the daemon's node_secret
      // (same vector round-7 §20.7 closed for fetch/sync). In the
      // common happy path the daemon already registered, the secret
      // exists, the guard is a no-op. Imported lazily so the helper
      // resolution does not slow down unrelated subcommands.
      try {
        const { getHubNodeSecret } = require('./src/gep/a2aProtocol');
        if (!getHubNodeSecret()) refuseHelloIfDaemonRunning('atp-complete');
      } catch (_) { /* never block ATP completion on a guard error */ }
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

  } else if (command === 'buy' || command === 'orders' || command === 'verify' || command === 'atp') {
    try {
      // Round-8 (§21.8): same daemon-vs-CLI race protection as fetch/sync
      // and atp-complete. The ATP runners (consumerAgent / merchantAgent
      // / atpExecute) all call sendHelloToHub when getHubNodeSecret() is
      // empty, which clobbers a running daemon's secret and silences it
      // for 30 min..4 h. The check is a no-op when a secret already
      // exists (the common case once the daemon has registered).
      try {
        const { getHubNodeSecret } = require('./src/gep/a2aProtocol');
        if (!getHubNodeSecret()) refuseHelloIfDaemonRunning(command);
      } catch (_) { /* never block ATP CLI on a guard error */ }
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
      } else if (command === 'verify') {
        parsed = atpCli.parseVerifyArgs(subArgs);
        runner = atpCli.runVerify;
      } else {
        parsed = atpCli.parseAtpArgs(subArgs);
        runner = atpCli.runAtp;
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

  } else if (command === 'recipe') {
    // recipe build  — assemble a DNA blueprint from owned Gene/Capsule assets
    // recipe reuse  — fetch + express an existing recipe into an organism
    const sub = args[1];
    const {
      getHubUrl, getNodeId, getHubNodeSecret, sendHelloToHub, rotateNodeSecret,
      hubCreateRecipe, hubPublishRecipe, hubGetRecipe, hubExpressRecipe,
    } = require('./src/gep/a2aProtocol');

    const hubUrl = getHubUrl();
    if (!hubUrl) {
      console.error('[recipe] A2A_HUB_URL is not configured. Set A2A_HUB_URL (e.g. https://evomap.ai).');
      process.exit(1);
    }

    function flagVal(name) {
      const eq = args.find(a => typeof a === 'string' && a.startsWith('--' + name + '='));
      return eq ? eq.split('=').slice(1).join('=') : null;
    }
    async function ensureRegistered(tag) {
      if (!getHubNodeSecret()) {
        console.log('[' + tag + '] No node_secret found. Registering with Hub...');
        const hello = await sendHelloToHub();
        if (!hello || !hello.ok) {
          console.error('[' + tag + '] Failed to register with Hub:', (hello && hello.error) || 'unknown');
          process.exit(1);
        }
        console.log('[' + tag + '] Registered as ' + getNodeId());
      }
    }
    // True when the hub rejected our node_secret as stale/invalid — the one
    // case where a rotate-and-retry is the documented recovery.
    function isStaleSecret(result) {
      if (!result || result.ok) return false;
      if (result.status !== 401 && result.status !== 403) return false;
      const e = String(result.error || '');
      return e.includes('node_secret_invalid') || e.includes('node_secret_not_set');
    }
    // Run a hub call; if it fails because our node_secret is stale, rotate
    // once and retry. Rotation only works when the CURRENT secret is still
    // server-valid (the hub authenticates the rotate with it). If the secret
    // has fully diverged from the server, rotation cannot recover it — that
    // requires re-registering, so we surface the actionable recovery path
    // instead of silently looping.
    let _authRecoveryFailed = false;
    async function callWithAuthRetry(tag, fn) {
      let result = await fn();
      if (isStaleSecret(result) && typeof rotateNodeSecret === 'function' && !_authRecoveryFailed) {
        console.log('[' + tag + '] node_secret stale; rotating via /a2a/hello and retrying...');
        const rot = await rotateNodeSecret();
        if (rot && rot.ok) {
          result = await fn();
        } else {
          _authRecoveryFailed = true;
          console.error('[' + tag + '] Could not auto-rotate: the local node_secret has diverged from the Hub and can no longer authenticate a rotate.');
          console.error('  Recover by either:');
          console.error('    1. Reset Secret on the web (Account -> Reset Secret), then run: node index.js reset-local-secret');
          console.error('    2. Or register a fresh node: set a new A2A_NODE_ID and retry (auto-provisions).');
        }
      }
      return result;
    }
    function reportHubError(tag, result) {
      console.error('[' + tag + '] Hub call failed' + (result.status ? ' (HTTP ' + result.status + ')' : '') + ': ' + (result.error || 'unknown'));
      if (result.status === 401 || result.status === 403) console.error('  Auth failed. If this persists, delete ~/.evomap/node_secret and retry.');
      else if (result.status === 402) console.error('  Insufficient credits. Check your balance at ' + hubUrl);
    }

    if (sub === 'build') {
      // --genes=<asset_id,...> ordered; types resolved from the local asset store.
      const genesArg = flagVal('genes');
      const title = flagVal('title');
      const description = flagVal('description');
      const doPublish = args.includes('--publish');
      if (!genesArg || !title) {
        console.error('Usage: node index.js recipe build --title="..." --genes=<asset_id,...> [--description="..."] [--price=N] [--publish]');
        console.error('  Builds a DRAFT recipe by default. --publish is opt-in and pushes it live.');
        process.exit(1);
      }
      const { loadGenes, loadCapsules } = require('./src/gep/assetStore');
      const typeById = new Map();
      try {
        for (const g of (loadGenes() || [])) if (g && g.asset_id) typeById.set(g.asset_id, 'Gene');
        for (const c of (loadCapsules() || [])) if (c && c.asset_id) typeById.set(c.asset_id, 'Capsule');
      } catch (e) { /* fall back to Gene below */ }

      const ids = genesArg.split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) { console.error('[recipe build] --genes is empty.'); process.exit(1); }
      if (ids.length > 20) { console.error('[recipe build] at most 20 steps per recipe.'); process.exit(1); }
      const steps = ids.map((asset_id, i) => ({
        asset_id,
        asset_type: typeById.get(asset_id) || 'Gene',
        position: i,
      }));

      await ensureRegistered('recipe build');
      const priceVal = flagVal('price');
      const createRes = await callWithAuthRetry('recipe build', () => hubCreateRecipe({
        title, steps, description: description || undefined,
        pricePerExecution: priceVal ? Number(priceVal) : undefined,
      }));
      if (!createRes.ok) { reportHubError('recipe build', createRes); process.exit(1); }
      const recipe = (createRes.data && (createRes.data.recipe || createRes.data)) || {};
      const recipeId = recipe.id;
      console.log('[recipe build] Created DRAFT recipe ' + recipeId + ' ("' + title + '", ' + steps.length + ' steps).');

      if (doPublish && recipeId) {
        const pubRes = await callWithAuthRetry('recipe build', () => hubPublishRecipe(recipeId));
        if (!pubRes.ok) { reportHubError('recipe build', pubRes); process.exit(1); }
        console.log('[recipe build] Published recipe ' + recipeId + ' to the marketplace.');
      } else if (!doPublish) {
        console.log('[recipe build] Left as draft. Re-run with --publish to make it live.');
      }
      process.exit(0);
    } else if (sub === 'reuse') {
      const recipeId = flagVal('id') || (args[2] && !String(args[2]).startsWith('-') ? args[2] : null);
      if (!recipeId) {
        console.error('Usage: node index.js recipe reuse --id=<recipe_id> [--input=<json>]');
        process.exit(1);
      }
      await ensureRegistered('recipe reuse');
      const getRes = await hubGetRecipe(recipeId);
      if (!getRes.ok) { reportHubError('recipe reuse', getRes); process.exit(1); }
      let inputPayload = {};
      const inputArg = flagVal('input');
      if (inputArg) {
        try { inputPayload = JSON.parse(inputArg); }
        catch (e) { console.error('[recipe reuse] --input must be valid JSON.'); process.exit(1); }
      }
      const expRes = await callWithAuthRetry('recipe reuse', () => hubExpressRecipe(recipeId, inputPayload));
      if (!expRes.ok) { reportHubError('recipe reuse', expRes); process.exit(1); }
      console.log('[recipe reuse] Expressed recipe ' + recipeId + '.');
      if (isVerbose) console.log(JSON.stringify(expRes.data, null, 2));
      process.exit(0);
    } else {
      console.error('Usage: node index.js recipe <build|reuse> [flags]');
      console.error('  build --title="..." --genes=<asset_id,...> [--publish]   (draft unless --publish)');
      console.error('  reuse --id=<recipe_id> [--input=<json>]');
      process.exit(1);
    }

  } else if (command === 'experiment') {
    // Comparative experiment runner: run the SAME task twice -- a baseline arm
    // and a variant arm that reuses a gene's strategy -- via a headless agent
    // CLI, collect duration/rounds/tokens/pass-rate, and print a comparison
    // JSON to stdout. Consumed by EvoMap Desktop's ExperimentsAPI.Run, which
    // spawns `node index.js experiment --request-file=<json>` and parses stdout.
    try {
      const expCli = require('./src/experiment/cli');
      const parsed = expCli.parseExperimentArgs(args.slice(1));
      if (!parsed.ok) {
        console.error('[Experiment] ' + parsed.error);
        console.error(expCli.printExperimentUsage());
        process.exit(2);
      }
      const res = await expCli.runExperiment(parsed.opts, { err: (...a) => console.error(...a) });
      // stdout carries ONLY the structured JSON so the Go caller can JSON.parse
      // it without log contamination; all logging above went to stderr. res.data
      // is already secret-redacted by runExperiment (sanitizePayload).
      if (res && res.data) process.stdout.write(JSON.stringify(res.data) + '\n');
      process.exit(res && typeof res.exitCode === 'number' ? res.exitCode : (res && res.ok ? 0 : 1));
    } catch (expErr) {
      console.error('[Experiment] CLI error:', expErr && expErr.message || expErr);
      process.exit(1);
    }

  } else {
    console.log(`Usage: node index.js [run|/evolve|login|logout|proxy-token|solidify|review|distill|fetch|sync|asset-log|webui|setup-hooks|recipe|buy|orders|verify|atp|atp-complete|experiment] [--loop]
  - login                      (authorize this device via the hub, gh-auth-login style; stores an OAuth token used instead of node_secret)
  - logout                     (remove the stored OAuth token)
  - proxy-token                (print the local proxy bearer token for command-backed client auth)
  - experiment flags:
    - --task="..." --metric="..."              (required; same task, baseline vs variant)
    - --gene=<geneId>                          (variant arm reuses this gene's strategy)
    - --baseline="..." --variant="..." --validation="c1;;c2" --request-file=<json>
  - recipe flags:
    - build --title="..." --genes=<asset_id,...> [--description] [--price=N] [--publish]
                              (builds a DRAFT DNA blueprint; --publish is opt-in)
    - reuse --id=<recipe_id> [--input=<json>]   (express a recipe into an organism)
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
  classifyInvocation,
  resolveLoopBridgeMode,
  CycleTimeoutError,
  writeCycleProgressAtomic,
  spawnReplacementProcess,
};
