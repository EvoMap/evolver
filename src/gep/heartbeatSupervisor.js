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
  _safeStop();
  _safeStart();
  _lastObservedSent = -1;
  _lastSuccessfulSendAt = now;
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
  const sent = _sentOf(stats);
  if (sent !== _lastObservedSent) {
    _lastObservedSent = sent;
    _lastSuccessfulSendAt = now;
    return;
  }

  if (_lastSuccessfulSendAt > 0 && now - _lastSuccessfulSendAt > _wedgeThresholdMs) {
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
  _consecutiveNullStats = 0;
  _wedgeThresholdMs = typeof options.wedgeThresholdMs === 'number' && options.wedgeThresholdMs > 0
    ? options.wedgeThresholdMs
    : WEDGE_THRESHOLD_MS;

  // Install intervals BEFORE attempting the initial startHeartbeat. If that
  // call throws (e.g. transient resource error at process start), we want
  // the supervisor to remain alive so the liveness tick can observe
  // running===false and retry via _safeStart(). Previously a throw here
  // left _started=false and every subsequent poke() / interval no-opped,
  // so the process ran with no heartbeat for the rest of its lifetime.
  const driftFn = function () { _driftTick(options); };
  const livenessFn = function () { _livenessTick(options); };
  _driftInterval = setInterval(driftFn, DRIFT_CHECK_MS);
  if (_driftInterval && typeof _driftInterval.unref === 'function') _driftInterval.unref();
  _livenessInterval = setInterval(livenessFn, LIVENESS_CHECK_MS);
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
  if (_pokeInFlight) return false;

  // Throttle applies uniformly. The previous "failing nodes bypass throttle"
  // shortcut let a high-frequency activity source (e.g. an IDE polling
  // /mailbox/poll) fan out into 4+ sends/sec during failure streaks once
  // each tick completed fast (immediate 401), which then hit the hub's
  // 6/300s per-sender rate limit and made recovery harder, not easier.
  // Recovery within ~60s is sufficient -- the drift and liveness ticks
  // already provide the fallback path.
  const now = _now(opts);
  if (_lastPokeAt && now - _lastPokeAt < POKE_THROTTLE_MS) return false;

  _lastPokeAt = now;
  const stats = _safeStats();
  const needsStart = stats && stats.running === false;

  _pokeInFlight = (async function () {
    try {
      if (needsStart) {
        try {
          if (typeof _a2a.startHeartbeat === 'function') _a2a.startHeartbeat();
        } catch (e) {
          console.warn('[Heartbeat] supervisor poke startHeartbeat failed: ' + (e && e.message || e));
        }
      }
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
    }
  })();

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
  _consecutiveNullStats = 0;
  _wedgeThresholdMs = WEDGE_THRESHOLD_MS;
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
  _started = false;
  _consecutiveNullStats = 0;
  _wedgeThresholdMs = WEDGE_THRESHOLD_MS;
}

module.exports = {
  start,
  poke,
  stop,
  _resetForTesting,
  DRIFT_CHECK_MS,
  DRIFT_SLEEP_THRESHOLD_MS,
  LIVENESS_CHECK_MS,
  WEDGE_THRESHOLD_MS,
  POKE_THROTTLE_MS,
  SEND_TIMEOUT_MS,
  NULL_STATS_RESTART_THRESHOLD,
};
