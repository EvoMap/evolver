'use strict';

const DRIFT_CHECK_MS = 30_000;
const DRIFT_SLEEP_THRESHOLD_MS = 90_000;
const LIVENESS_CHECK_MS = 60_000;
// 15 min: longer than the default-mode heartbeat interval (~6 min) plus one
// healthy backoff cycle, so we do not false-positive during a normal failure
// retry, but short enough to recover before the obfuscated module's documented
// 30-min worst-case backoff cap.
const WEDGE_THRESHOLD_MS = 15 * 60 * 1000;
const POKE_THROTTLE_MS = 60_000;

let _a2a = null;
let _driftInterval = null;
let _livenessInterval = null;
let _lastDriftSampleAt = 0;
// Freshness signal: totalSent + totalFailed only advances on real send
// attempts. The previously-used `uptimeMs` is wall-clock since
// startHeartbeat(), so it advances even when the internal loop is wedged in
// backoff and never useful as a "loop is doing work" signal.
let _lastObservedAttempts = -1;
let _lastAttemptAdvanceAt = 0;
let _lastPokeAt = 0;
let _pokeInFlight = null;
let _started = false;

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

function _attemptsOf(stats) {
  if (!stats) return -1;
  const sent = typeof stats.totalSent === 'number' ? stats.totalSent : 0;
  const failed = typeof stats.totalFailed === 'number' ? stats.totalFailed : 0;
  return sent + failed;
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
  _lastObservedAttempts = -1;
  _lastAttemptAdvanceAt = now;
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
  if (!stats) return;

  if (stats.running === false) {
    _safeStart();
    _lastObservedAttempts = -1;
    _lastAttemptAdvanceAt = now;
    return;
  }

  // Freshness: totalSent + totalFailed only increments on actual send
  // attempts. If neither has advanced for WEDGE_THRESHOLD_MS the internal
  // loop is doing nothing (regardless of what `running` claims) and needs a
  // stop+start to clear backoff.
  const attempts = _attemptsOf(stats);
  if (attempts !== _lastObservedAttempts) {
    _lastObservedAttempts = attempts;
    _lastAttemptAdvanceAt = now;
    return;
  }

  if (_lastAttemptAdvanceAt > 0 && now - _lastAttemptAdvanceAt > WEDGE_THRESHOLD_MS) {
    _hardRestart(now);
  }
}

function start(a2a, opts) {
  if (_started) stop();
  if (!a2a || typeof a2a !== 'object') {
    throw new Error('heartbeatSupervisor.start: a2a module is required');
  }
  _a2a = a2a;
  const options = opts || {};
  const now = _now(options);
  _lastDriftSampleAt = now;
  _lastAttemptAdvanceAt = now;
  _lastObservedAttempts = -1;
  _lastPokeAt = 0;
  _pokeInFlight = null;

  if (typeof a2a.startHeartbeat !== 'function') {
    throw new Error('heartbeatSupervisor.start: a2a.startHeartbeat is required');
  }
  // Rethrow first-attempt failure: a startup error is worth surfacing.
  a2a.startHeartbeat();

  const driftFn = function () { _driftTick(options); };
  const livenessFn = function () { _livenessTick(options); };

  _driftInterval = setInterval(driftFn, DRIFT_CHECK_MS);
  if (_driftInterval && typeof _driftInterval.unref === 'function') _driftInterval.unref();
  _livenessInterval = setInterval(livenessFn, LIVENESS_CHECK_MS);
  if (_livenessInterval && typeof _livenessInterval.unref === 'function') _livenessInterval.unref();

  _started = true;
  return {
    _driftTick: driftFn,
    _livenessTick: livenessFn,
  };
}

function poke(reason, opts) {
  if (!_started || !_a2a) return false;
  if (_pokeInFlight) return false;

  const stats = _safeStats();
  const failing = stats && (stats.consecutiveFailures || 0) > 0;
  const now = _now(opts);
  if (!failing && _lastPokeAt && now - _lastPokeAt < POKE_THROTTLE_MS) return false;

  _lastPokeAt = now;
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
        if (typeof _a2a.sendHeartbeat === 'function') await _a2a.sendHeartbeat();
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
}

function _resetForTesting() {
  if (_driftInterval) { try { clearInterval(_driftInterval); } catch (_e) { /* noop */ } }
  if (_livenessInterval) { try { clearInterval(_livenessInterval); } catch (_e) { /* noop */ } }
  _a2a = null;
  _driftInterval = null;
  _livenessInterval = null;
  _lastDriftSampleAt = 0;
  _lastObservedAttempts = -1;
  _lastAttemptAdvanceAt = 0;
  _lastPokeAt = 0;
  _pokeInFlight = null;
  _started = false;
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
};
