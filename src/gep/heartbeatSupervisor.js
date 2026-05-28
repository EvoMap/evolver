'use strict';

const DRIFT_CHECK_MS = 30_000;
const DRIFT_SLEEP_THRESHOLD_MS = 90_000;
const LIVENESS_CHECK_MS = 60_000;
// Wedge detection: if totalSent has not advanced for this long, the
// internal loop is either fully stopped attempting (timer dead) or in a
// backoff so long that the inter-attempt gap exceeds the threshold --
// both look like "no progress" to the hub. Issue a stop+start.
//
// IMPORTANT (verified against the obfuscated module): `totalSent`
// increments on every send ATTEMPT that completes an HTTP round-trip,
// regardless of status code. A 503 response still bumps it. So the
// wedge does NOT catch "loop attempts fast but every attempt is
// rejected" -- only "loop has slowed or stopped attempting". For the
// stuck-in-backoff case, the obfuscated module's documented 30-min
// backoff cap means we wait at most WEDGE_THRESHOLD_MS (15 min) of
// dead time before forcing a fresh cadence via stop+start.
const WEDGE_THRESHOLD_MS = 15 * 60 * 1000;
// Companion gate to the totalSent-freshness wedge. Closes the documented
// blind spot where `totalSent` keeps advancing on every attempt (because
// the obfuscated module increments it on HTTP round-trip, not success)
// while the hub steadily returns errors. If consecutiveFailures stays at
// or above this threshold, the loop is "alive but failing" and a fresh
// stop+start drops accumulated backoff to retry the cadence from zero.
// Without this, a hub returning 503 (or any failure) in a tight loop is
// invisible to the wedge -- the user-perceived "evolver is dead" symptom
// the supervisor exists to mitigate.
//
// Pair with `_lastHardRestartAt + _wedgeThresholdMs` thrash guard so the
// gate cannot fire faster than the wedge cadence: a restart that doesn't
// fix the underlying issue must not produce a tight stop+start loop.
const CONSECUTIVE_FAILURE_RESTART_THRESHOLD = 10;
// After this many _hardRestart()s without ever seeing the underlying loop
// recover (i.e. totalSent advances AND consecutiveFailures drops back to
// zero), log a clear user-visible diagnostic. We cannot inspect hub
// response bodies from outside the obfuscated module -- getHeartbeatStats()
// exposes only {running, uptimeMs, totalSent, totalFailed,
// consecutiveFailures} and no error/response surface -- so we cannot
// detect terminal hub states (status:"suspended", status:"unknown_node",
// survival_status:"dead", or HTTP 403 error:"node_secret_invalid")
// automatically. Instead we surface "the supervisor has restarted N times
// and it isn't helping" so the user knows to check the dashboard at
// https://evomap.ai/account, which is the recovery path the hub itself
// directs users to (see evomap-hub _middleware.js recovery_action url).
// Without this signal a permanently-disabled node would loop forever in
// 15-min restart cycles with no indication to the operator that the
// problem is terminal from the client's perspective.
const TERMINAL_DIAGNOSTIC_RESTART_THRESHOLD = 3;
const POKE_THROTTLE_MS = 60_000;
// Cap on how long we wait for the obfuscated module's sendHeartbeat to
// resolve from inside poke(). Without this, a never-resolving promise
// (TLS hang, custom transport ignoring abort, etc.) latches _pokeInFlight
// forever and every subsequent poke() early-returns. The drift and
// liveness ticks would still recover via _hardRestart, but the
// user-activity path becomes dead weight in the interim.
const SEND_TIMEOUT_MS = 15_000;
// H1 safety net: if getHeartbeatStats() returns null for this many
// consecutive _livenessTick fires, force a _hardRestart. Without this,
// _livenessTick early-returns silently on null stats and the supervisor
// has no recovery path for a permanently-broken getHeartbeatStats — the
// exact "stays dead forever" failure mode the user reported.
//
// At LIVENESS_CHECK_MS=60s, threshold=5 means we tolerate up to ~5 min
// of dead stats before forcing a restart. This is a conservative balance:
// long enough that a transient blip during startup doesn't cause
// thrashing, short enough that the user's "I came back and it's still
// dead" window is bounded.
const NULL_STATS_RESTART_THRESHOLD = 5;
// E6 / E7 watchdog thresholds. Both single-flight latches
// (_hardRestartInFlight and _pokeInFlight) record an acquire timestamp;
// _livenessTick force-clears either latch if it has been held longer
// than these thresholds. The watchdog clears the LATCH only -- the
// underlying sync call (_safeStop/_safeStart) or pending sendHeartbeat
// promise keeps doing whatever it's doing. The point is to free the
// supervisor's state machine so the next attempt can proceed.
//
// HARDRESTART: _safeStop()/_safeStart() are synchronous calls into the
// obfuscated module and cannot be timed out from JS. If either blocks
// (sync I/O on a wedged transport, blocked main thread, etc.), the
// finally never runs and every subsequent _driftTick / _livenessTick
// that wants to restart bails -- the supervisor's primary recovery
// primitive is dead. 30s is generous; a hardRestart should normally
// complete in <1s.
//
// POKE: even with SEND_TIMEOUT_MS=15s, a sendHeartbeat promise can
// stall in a way the timeout doesn't always cover (e.g. unhandled
// rejection chain that never reaches the finally clearing _pokeInFlight).
// Every subsequent poke() then early-returns at the in-flight check.
// _hardRestart already clears this latch (see _pokeInFlight = null in
// _hardRestart), but only if _hardRestart itself isn't latched. 30s is
// 2x past the natural SEND_TIMEOUT_MS deadline.
const HARDRESTART_HUNG_THRESHOLD_MS = 30_000;
const POKE_HUNG_THRESHOLD_MS = 30_000;

let _a2a = null;
let _driftInterval = null;
let _livenessInterval = null;
let _lastDriftSampleAt = 0;
// Freshness signal: tracks the last time totalSent (send attempts that
// completed an HTTP round-trip, see WEDGE_THRESHOLD_MS comment) advanced.
// We key off totalSent alone rather than totalSent+totalFailed: the two
// are not orthogonal in the production module (totalFailed only moves on
// network-level failures, not HTTP errors), and using totalSent alone
// gives a single, unambiguous "loop is making forward progress" signal.
let _lastObservedSent = -1;
let _lastSuccessfulSendAt = 0;
let _lastPokeAt = 0;
let _pokeInFlight = null;
let _started = false;
let _consecutiveNullStats = 0;
// Per-supervisor wedge threshold, settable via start() opts so tests can
// drive the wedge path without waiting 15 minutes. Defaults to the
// module-level constant in production.
let _wedgeThresholdMs = WEDGE_THRESHOLD_MS;
let _consecutiveFailureRestartThreshold = CONSECUTIVE_FAILURE_RESTART_THRESHOLD;
// Wall-clock of the last _hardRestart. Used to throttle the consecutive-
// failure gate: a hard restart that didn't fix the underlying problem
// must not produce a tight stop+start loop. Initialised to 0 so the gate
// can fire on first qualifying observation.
let _lastHardRestartAt = 0;
// Single-flight gate for _hardRestart. Drift and liveness ticks can fire
// concurrently right after host resume (both intervals are queued by
// libuv and run on the next event-loop turn). Without this gate both
// would call _safeStop()+_safeStart() in sequence, interleaving with each
// other on the obfuscated module's internal state -- depending on what
// the module does inside its own stop/start, this could leave it half-
// initialised. Coarse-grained: a hard-restart in flight blocks every
// other _hardRestart attempt until the synchronous stop+start completes.
let _hardRestartInFlight = false;
// Acquire timestamps for the two single-flight latches (E6 / E7
// watchdog). Set to Date.now() immediately after the latch flips true;
// cleared back to 0 in the same finally that releases the latch. The
// watchdog in _livenessTick force-clears either latch if it has been
// held longer than the threshold, freeing the supervisor's state
// machine for the next attempt.
let _hardRestartStartedAt = 0;
let _pokeStartedAt = 0;
// Restart-recovery accounting. _consecutiveHardRestarts counts how many
// times _hardRestart has fired without seeing the underlying loop
// recover in between (recovery == totalSent advances AND consecutive
// Failures drops back to zero). Resets to 0 on observed recovery.
// _terminalDiagnosticLogged ensures we emit the user-visible diagnostic
// at most once per stuck-state episode -- a permanently disabled node
// would otherwise spam the same warning every wedge-threshold cycle.
let _consecutiveHardRestarts = 0;
let _terminalDiagnosticLogged = false;

function _now(opts) {
  return opts && typeof opts.nowFn === 'function' ? opts.nowFn() : Date.now();
}

function _safeStats() {
  try {
    const s = _a2a && typeof _a2a.getHeartbeatStats === 'function' ? _a2a.getHeartbeatStats() : null;
    if (!s || typeof s !== 'object') return null;
    return s;
  } catch (_e) {
    return null;
  }
}

function _sentOf(stats) {
  if (!stats) return -1;
  return typeof stats.totalSent === 'number' ? stats.totalSent : 0;
}

function _safeStart() {
  try {
    if (_a2a && typeof _a2a.startHeartbeat === 'function') _a2a.startHeartbeat();
    return true;
  } catch (e) {
    console.warn('[Heartbeat] supervisor startHeartbeat failed: ' + (e && e.message || e));
    return false;
  }
}

function _safeStop() {
  try {
    if (_a2a && typeof _a2a.stopHeartbeat === 'function') _a2a.stopHeartbeat();
  } catch (e) {
    console.warn('[Heartbeat] supervisor stopHeartbeat failed: ' + (e && e.message || e));
  }
}

function _hardRestart(now) {
  if (_hardRestartInFlight) return false;
  _hardRestartInFlight = true;
  _hardRestartStartedAt = Date.now();
  try {
    _safeStop();
    _safeStart();
    // Clear any latched single-flight poke. If a poke()'s sendHeartbeat
    // never resolves (TLS hang, transport ignoring abort), _withTimeout
    // frees the caller's await but the underlying promise's .finally
    // chain can stall, leaving _pokeInFlight non-null forever. Every
    // subsequent poke() then early-returns at the in-flight check and
    // the user-activity recovery path goes silently dead. The internal
    // loop still recovers via drift / liveness, but pokes never fire
    // again. Resetting here is safe: stop+start has just reinitialised
    // the underlying loop, so any pending sendHeartbeat from before the
    // restart targets stale state and we no longer care about its result.
    // Also clear the poke acquire timestamp for symmetry with the E7
    // watchdog (otherwise a stale timestamp would dangle past the latch
    // it tracks).
    _pokeInFlight = null;
    _pokeStartedAt = 0;
    _lastObservedSent = -1;
    _lastSuccessfulSendAt = now;
    _lastHardRestartAt = now;
    _consecutiveHardRestarts += 1;
    // Terminal-state diagnostic: getHeartbeatStats() does not expose
    // response bodies or HTTP status, so we cannot detect the hub's real
    // terminal states (status:"suspended", status:"unknown_node",
    // survival_status:"dead", HTTP 403 error:"node_secret_invalid")
    // automatically from outside the obfuscated module. After N
    // consecutive restarts that didn't restore the loop, log a clear
    // pointer to the hub-suggested recovery path (the dashboard at
    // https://evomap.ai/account, which the hub itself returns as
    // recovery_action.url for node_secret_invalid). Logged at most once
    // per stuck-state episode; reset on the first observed recovery
    // (see _livenessTick).
    if (
      _consecutiveHardRestarts >= TERMINAL_DIAGNOSTIC_RESTART_THRESHOLD
      && !_terminalDiagnosticLogged
    ) {
      _terminalDiagnosticLogged = true;
      console.warn(
        '[Heartbeat] supervisor has restarted ' + _consecutiveHardRestarts +
        ' times without observed recovery. This may indicate the hub ' +
        'considers this node terminal. Check https://evomap.ai/account ' +
        'to see node status. If the dashboard shows the node as ' +
        '"suspended" or reports an invalid node secret ' +
        '(node_secret_invalid), take action there (re-enable, or reset ' +
        'the node secret via the web UI). If the node is shown as ' +
        'offline or unknown, ensure A2A_NODE_SECRET is set correctly ' +
        'and restart evolver (you can also run `evolver ' +
        'reset-local-secret` to clear any stale local secret before ' +
        'restart).',
      );
    }
    return true;
  } finally {
    _hardRestartInFlight = false;
    _hardRestartStartedAt = 0;
  }
}

// Race a promise against a timeout. If the timeout wins, the returned
// promise rejects, and the underlying promise is left to settle on its
// own (we cannot cancel an arbitrary Promise without an AbortController
// we don't own). The point is that the *caller's* state machine is freed,
// not the underlying transport.
function _withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timeout after ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function _driftTick(opts) {
  const now = _now(opts);
  const prev = _lastDriftSampleAt || now;
  const gap = now - prev;
  _lastDriftSampleAt = now;

  // setInterval is suspended during laptop sleep while Date.now() keeps real
  // time, so a > threshold gap means we just woke. We cannot tell from outside
  // whether the internal loop is wedged in backoff or about to fire normally
  // (uptimeMs advances on real time, not on send activity), so unconditionally
  // stop+start to drop any accumulated backoff. A single sendHeartbeat() is
  // not enough: there is no evidence it resets the obfuscated module's
  // internal cadence/backoff state. stop+start is the only API pair known to
  // re-initialise the cadence.
  if (gap > DRIFT_SLEEP_THRESHOLD_MS) {
    _hardRestart(now);
  }
}

function _livenessTick(opts) {
  // E6 / E7 watchdog: force-clear either single-flight latch if it has
  // been held longer than its threshold. This must run BEFORE the rest
  // of the tick body so a freshly-cleared latch can be used by the
  // current tick if needed (e.g. _hardRestartInFlight cleared here lets
  // the cf-gate _hardRestart below actually fire). The watchdog clears
  // the LATCH only -- the underlying sync call / pending promise keeps
  // doing whatever it's doing. We use wall-clock Date.now() (not
  // _now(opts)) because the latch acquire timestamps were stamped with
  // Date.now() at acquire time; mixing clocks here would race tests
  // that drive nowFn forward without advancing real time.
  const wallNow = Date.now();
  if (
    _hardRestartInFlight
    && _hardRestartStartedAt > 0
    && wallNow - _hardRestartStartedAt > HARDRESTART_HUNG_THRESHOLD_MS
  ) {
    console.warn(
      '[heartbeatSupervisor] _hardRestartInFlight held >'
      + (HARDRESTART_HUNG_THRESHOLD_MS / 1000)
      + 's; force-clearing latch. Underlying sync call may still be wedged.',
    );
    _hardRestartInFlight = false;
    _hardRestartStartedAt = 0;
  }
  if (
    _pokeInFlight
    && _pokeStartedAt > 0
    && wallNow - _pokeStartedAt > POKE_HUNG_THRESHOLD_MS
  ) {
    console.warn(
      '[heartbeatSupervisor] _pokeInFlight held >'
      + (POKE_HUNG_THRESHOLD_MS / 1000)
      + 's; force-clearing latch. Underlying send may still be pending.',
    );
    _pokeInFlight = null;
    _pokeStartedAt = 0;
  }

  const now = _now(opts);
  const stats = _safeStats();
  if (!stats) {
    // H1: getHeartbeatStats() permanently returning null/throwing was a
    // silent-death failure mode — _livenessTick would early-return forever
    // and the supervisor never recovered. Count consecutive null returns
    // and force a _hardRestart at the threshold. The restart itself does
    // not depend on getHeartbeatStats: _safeStop()+_safeStart() only call
    // the start/stop functions, so even a broken stats path gets a fresh
    // chance at re-arming the underlying loop.
    _consecutiveNullStats += 1;
    if (_consecutiveNullStats >= NULL_STATS_RESTART_THRESHOLD) {
      _hardRestart(now);
      _consecutiveNullStats = 0;
    }
    return;
  }
  _consecutiveNullStats = 0;

  if (stats.running === false) {
    _safeStart();
    _lastObservedSent = -1;
    _lastSuccessfulSendAt = now;
    return;
  }

  // Freshness keys off totalSent. _wedgeThresholdMs (defaults to
  // WEDGE_THRESHOLD_MS) without an attempt means the internal loop has
  // either stopped attempting (timer dead) or its backoff interval
  // exceeds the threshold -- in both cases the hub has seen no recent
  // heartbeat and we restart to re-arm a fresh cadence. See the
  // WEDGE_THRESHOLD_MS comment for the bounded-recovery analysis against
  // the documented 30-min backoff cap.
  //
  // Important: do NOT early-return when totalSent advances. The cf gate
  // below specifically targets the "totalSent moves but everything fails"
  // case (503-loop blindness), so evaluating it depends on the cf reading
  // even when freshness was just refreshed.
  const sent = _sentOf(stats);
  if (sent !== _lastObservedSent) {
    _lastObservedSent = sent;
    _lastSuccessfulSendAt = now;
    // Recovery signal for the terminal-state diagnostic: a fresh sent
    // observation combined with consecutiveFailures BELOW the cf-restart
    // gate means the loop is making forward progress (not stuck in a
    // 503-storm). Reset the restart counter so the diagnostic can
    // re-arm if the loop later wedges again, and clear the "logged once"
    // latch so a future stuck-state episode can warn the user again.
    //
    // Pre-fix this required `cfNow === 0`. The obfuscated module clears
    // its consecutiveFailures counter only on the next FULLY successful
    // send round-trip; between a hard restart and the first 2xx response
    // there is a window where totalSent advances (proving forward
    // progress) but cf has not yet been zeroed by the module's internal
    // accounting. Holding the recovery latch on `cf === 0` made
    // _consecutiveHardRestarts stay non-zero across multiple healthy
    // restart cycles, which caused TERMINAL_DIAGNOSTIC_RESTART_THRESHOLD
    // to mis-fire and warn the user about a "stuck" supervisor that had
    // in fact recovered. Keying off `cf < cf-restart-gate` instead is
    // a strictly stronger signal: we're not in cf-storm territory AND
    // attempts are landing, so by every observable signal we are
    // healthy enough to drop the stuck-state accounting.
    const cfNow = typeof stats.consecutiveFailures === 'number' ? stats.consecutiveFailures : 0;
    if (cfNow < _consecutiveFailureRestartThreshold && _consecutiveHardRestarts > 0) {
      _consecutiveHardRestarts = 0;
      _terminalDiagnosticLogged = false;
    }
  } else if (_lastSuccessfulSendAt > 0 && now - _lastSuccessfulSendAt > _wedgeThresholdMs) {
    _hardRestart(now);
    return;
  }

  // Companion gate: the totalSent wedge above only fires when ATTEMPTS
  // have stalled. If the underlying loop is attempting on cadence but
  // every attempt is failing (hub returning 503 / 5xx, network down with
  // attempts still resolving as failures, etc.), totalSent keeps moving
  // and the wedge never trips. consecutiveFailures advances in that case,
  // and a stop+start drops accumulated backoff so the next attempt fires
  // immediately rather than after the documented 30-min cap.
  //
  // Cooldown guard: a restart that didn't fix the underlying issue must
  // not produce a tight stop+start loop -- the next cf-gated restart is
  // throttled by _wedgeThresholdMs since the last restart. First fire is
  // unthrottled (_lastHardRestartAt === 0 on a fresh supervisor).
  const cf = typeof stats.consecutiveFailures === 'number' ? stats.consecutiveFailures : 0;
  const restartCooledDown = _lastHardRestartAt === 0
    || (now - _lastHardRestartAt) > _wedgeThresholdMs;
  if (cf >= _consecutiveFailureRestartThreshold && restartCooledDown) {
    _hardRestart(now);
  }
}

function start(a2a, opts) {
  if (_started) stop();
  if (!a2a || typeof a2a !== 'object') {
    throw new Error('heartbeatSupervisor.start: a2a module is required');
  }
  if (typeof a2a.startHeartbeat !== 'function') {
    throw new Error('heartbeatSupervisor.start: a2a.startHeartbeat is required');
  }
  _a2a = a2a;
  const options = opts || {};
  const now = _now(options);
  _lastDriftSampleAt = now;
  _lastSuccessfulSendAt = now;
  _lastObservedSent = -1;
  _lastPokeAt = 0;
  _pokeInFlight = null;
  _pokeStartedAt = 0;
  _consecutiveNullStats = 0;
  _lastHardRestartAt = 0;
  _hardRestartInFlight = false;
  _hardRestartStartedAt = 0;
  _consecutiveHardRestarts = 0;
  _terminalDiagnosticLogged = false;
  _wedgeThresholdMs = typeof options.wedgeThresholdMs === 'number' && options.wedgeThresholdMs > 0
    ? options.wedgeThresholdMs
    : WEDGE_THRESHOLD_MS;
  _consecutiveFailureRestartThreshold = typeof options.consecutiveFailureRestartThreshold === 'number'
      && options.consecutiveFailureRestartThreshold > 0
    ? options.consecutiveFailureRestartThreshold
    : CONSECUTIVE_FAILURE_RESTART_THRESHOLD;
  // Interval cadences are settable so tests can drive the loop with real
  // timers across simulated host suspend (vs. manually invoking the
  // returned tick handles). Production keeps the module-level constants.
  const driftCheckMs = typeof options.driftCheckMs === 'number' && options.driftCheckMs > 0
    ? options.driftCheckMs
    : DRIFT_CHECK_MS;
  const livenessCheckMs = typeof options.livenessCheckMs === 'number' && options.livenessCheckMs > 0
    ? options.livenessCheckMs
    : LIVENESS_CHECK_MS;

  // Install intervals BEFORE attempting the initial startHeartbeat. If that
  // call throws (e.g. transient resource error at process start), we want
  // the supervisor to remain alive so the liveness tick can observe
  // running===false and retry via _safeStart(). Previously a throw here
  // left _started=false and every subsequent poke() / interval no-opped,
  // so the process ran with no heartbeat for the rest of its lifetime.
  //
  // Outer try/catch on the interval callbacks: the tick bodies and their
  // dependencies (logger.warn inside _hardRestart, future hub-side error
  // paths, etc.) can throw. A synchronous throw out of a setInterval
  // callback routes to process.on('uncaughtException'). Many production
  // daemons install a self-killing handler there, so an exception we
  // could have swallowed would take the whole process down. setInterval
  // itself continues to fire after a throw, but we still want to keep
  // any single tick failure local and observable.
  const driftFn = function () {
    try {
      _driftTick(options);
    } catch (e) {
      try { console.warn('[Heartbeat] supervisor driftTick threw: ' + (e && e.message || e)); } catch (_) {}
    }
  };
  const livenessFn = function () {
    try {
      _livenessTick(options);
    } catch (e) {
      try { console.warn('[Heartbeat] supervisor livenessTick threw: ' + (e && e.message || e)); } catch (_) {}
    }
  };
  _driftInterval = setInterval(driftFn, driftCheckMs);
  if (_driftInterval && typeof _driftInterval.unref === 'function') _driftInterval.unref();
  _livenessInterval = setInterval(livenessFn, livenessCheckMs);
  if (_livenessInterval && typeof _livenessInterval.unref === 'function') _livenessInterval.unref();
  _started = true;

  try {
    a2a.startHeartbeat();
  } catch (e) {
    console.warn('[Heartbeat] supervisor initial startHeartbeat failed (liveness will retry): ' + (e && e.message || e));
  }

  return {
    _driftTick: driftFn,
    _livenessTick: livenessFn,
  };
}

function poke(reason, opts) {
  if (!_started || !_a2a) return false;

  // Two distinct effects, separately gated -- mirrors the structure of
  // LifecycleManager.pokeHeartbeat for proxy mode:
  //
  //   1. Cheap recovery (running===false -> startHeartbeat()): the
  //      obfuscated module's heartbeat timer is dead. Re-arming it has no
  //      hub cost (it just schedules an in-process timer; the next actual
  //      hub send is owned by the module itself, throttled by its own
  //      cadence). This MUST run regardless of POKE_THROTTLE_MS or
  //      _pokeInFlight -- otherwise a poke arriving 30s after another
  //      poke leaves the internal loop dead until the next 60s drift
  //      sample, which is precisely the "I keep clicking and it stays
  //      dead" symptom this module exists to fix.
  //
  //   2. Expensive send (sendHeartbeat()): this DOES hit the hub. Bound
  //      by POKE_THROTTLE_MS and the single-flight _pokeInFlight gate so
  //      a polling activity source can't fan out into 4+ sends/sec during
  //      failure streaks (the previous code already had this; the only
  //      change is that the cheap path no longer shares the gate).

  const now = _now(opts);
  const stats = _safeStats();
  const needsStart = stats && stats.running === false;

  // Unconditional cheap recovery: re-arm a dead timer regardless of
  // throttle. Pre-fix this lived inside the throttled IIFE, so a user
  // who pokes twice in quick succession (e.g. proxy HTTP request + sync
  // engine onLiveness firing within a few seconds of each other) would
  // skip the startHeartbeat on the second poke even though the first
  // was still throttled out. Synchronous so the next event-loop turn
  // sees the timer alive.
  if (needsStart) {
    try {
      if (typeof _a2a.startHeartbeat === 'function') _a2a.startHeartbeat();
    } catch (e) {
      console.warn('[Heartbeat] supervisor poke startHeartbeat failed: ' + (e && e.message || e));
    }
  }

  // Send-path gating: throttle and single-flight only the actual
  // sendHeartbeat() call. Return false but do NOT consider the poke
  // "ignored" -- the cheap recovery above may already have re-armed the
  // loop, which is the whole point of an activity poke from the user.
  if (_pokeInFlight) return needsStart || false;
  if (_lastPokeAt && now - _lastPokeAt < POKE_THROTTLE_MS) return needsStart || false;

  _lastPokeAt = now;

  _pokeInFlight = (async function () {
    try {
      try {
        if (typeof _a2a.sendHeartbeat === 'function') {
          // Race the send against SEND_TIMEOUT_MS so a never-resolving
          // promise can never latch _pokeInFlight indefinitely. The
          // underlying transport may still hold its socket -- we cannot
          // cancel a promise we don't own -- but the supervisor's
          // single-flight gate releases for the next poke.
          await _withTimeout(
            _a2a.sendHeartbeat(),
            SEND_TIMEOUT_MS,
            'supervisor sendHeartbeat',
          );
        }
      } catch (e) {
        console.warn('[Heartbeat] supervisor poke sendHeartbeat failed (' + (reason || 'unknown') + '): ' + (e && e.message || e));
      }
    } finally {
      _pokeInFlight = null;
      _pokeStartedAt = 0;
    }
  })();
  // Stamp the acquire timestamp AFTER assigning the IIFE so the E7
  // watchdog has both signals (_pokeInFlight non-null AND timestamp >0)
  // for the held-too-long check. Use wall-clock Date.now() to match the
  // wallNow reference in _livenessTick (see comment there).
  _pokeStartedAt = Date.now();

  return true;
}

function stop() {
  if (!_started) return;
  if (_driftInterval) { try { clearInterval(_driftInterval); } catch (_e) { /* noop */ } _driftInterval = null; }
  if (_livenessInterval) { try { clearInterval(_livenessInterval); } catch (_e) { /* noop */ } _livenessInterval = null; }
  if (_a2a && typeof _a2a.stopHeartbeat === 'function') {
    try { _a2a.stopHeartbeat(); } catch (_e) { /* noop */ }
  }
  _started = false;
  _pokeInFlight = null;
  _pokeStartedAt = 0;
  _consecutiveNullStats = 0;
  _wedgeThresholdMs = WEDGE_THRESHOLD_MS;
  _consecutiveFailureRestartThreshold = CONSECUTIVE_FAILURE_RESTART_THRESHOLD;
  _lastHardRestartAt = 0;
  _hardRestartInFlight = false;
  _hardRestartStartedAt = 0;
  _consecutiveHardRestarts = 0;
  _terminalDiagnosticLogged = false;
}

function _resetForTesting() {
  if (_driftInterval) { try { clearInterval(_driftInterval); } catch (_e) { /* noop */ } }
  if (_livenessInterval) { try { clearInterval(_livenessInterval); } catch (_e) { /* noop */ } }
  _a2a = null;
  _driftInterval = null;
  _livenessInterval = null;
  _lastDriftSampleAt = 0;
  _lastObservedSent = -1;
  _lastSuccessfulSendAt = 0;
  _lastPokeAt = 0;
  _pokeInFlight = null;
  _pokeStartedAt = 0;
  _started = false;
  _consecutiveNullStats = 0;
  _wedgeThresholdMs = WEDGE_THRESHOLD_MS;
  _consecutiveFailureRestartThreshold = CONSECUTIVE_FAILURE_RESTART_THRESHOLD;
  _lastHardRestartAt = 0;
  _hardRestartInFlight = false;
  _hardRestartStartedAt = 0;
  _consecutiveHardRestarts = 0;
  _terminalDiagnosticLogged = false;
}

// Testing helpers for the E6 / E7 watchdog. The latches and their
// acquire timestamps are module-level `let` bindings, so external tests
// cannot read or write them via property access on the exported object.
// These helpers exist solely to let the watchdog tests stage a "latch
// held for N seconds" precondition without sleeping or coupling to the
// real acquire paths.
function _setLatchForTesting(name, value) {
  if (name === '_hardRestartInFlight') { _hardRestartInFlight = value; return; }
  if (name === '_hardRestartStartedAt') { _hardRestartStartedAt = value; return; }
  if (name === '_pokeInFlight') { _pokeInFlight = value; return; }
  if (name === '_pokeStartedAt') { _pokeStartedAt = value; return; }
  throw new Error('_setLatchForTesting: unknown latch ' + name);
}
function _getLatchForTesting(name) {
  if (name === '_hardRestartInFlight') return _hardRestartInFlight;
  if (name === '_hardRestartStartedAt') return _hardRestartStartedAt;
  if (name === '_pokeInFlight') return _pokeInFlight;
  if (name === '_pokeStartedAt') return _pokeStartedAt;
  throw new Error('_getLatchForTesting: unknown latch ' + name);
}

module.exports = {
  start,
  poke,
  stop,
  _resetForTesting,
  _setLatchForTesting,
  _getLatchForTesting,
  _hardRestart,
  DRIFT_CHECK_MS,
  DRIFT_SLEEP_THRESHOLD_MS,
  LIVENESS_CHECK_MS,
  WEDGE_THRESHOLD_MS,
  POKE_THROTTLE_MS,
  SEND_TIMEOUT_MS,
  NULL_STATS_RESTART_THRESHOLD,
  CONSECUTIVE_FAILURE_RESTART_THRESHOLD,
  TERMINAL_DIAGNOSTIC_RESTART_THRESHOLD,
  HARDRESTART_HUNG_THRESHOLD_MS,
  POKE_HUNG_THRESHOLD_MS,
};
