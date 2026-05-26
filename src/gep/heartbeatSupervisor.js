'use strict';

const DRIFT_CHECK_MS = 30_000;
const DRIFT_SLEEP_THRESHOLD_MS = 90_000;
const LIVENESS_CHECK_MS = 60_000;
const WEDGE_THRESHOLD_MS = 180_000;
const POKE_THROTTLE_MS = 60_000;

let _a2a = null;
let _driftInterval = null;
let _livenessInterval = null;
let _lastDriftSampleAt = 0;
let _lastObservedUptimeMs = -1;
let _lastUptimeAdvanceAt = 0;
let _lastObservedFailures = 0;
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

async function _safeSend() {
  try {
    if (_a2a && typeof _a2a.sendHeartbeat === 'function') {
      await _a2a.sendHeartbeat();
    }
  } catch (e) {
    console.warn('[Heartbeat] supervisor sendHeartbeat failed: ' + (e && e.message || e));
  }
}

function _driftTick(opts) {
  const now = _now(opts);
  const prev = _lastDriftSampleAt || now;
  const gap = now - prev;
  _lastDriftSampleAt = now;

  // Wall-clock not monotonic: laptop sleep suspends setInterval but Date.now()
  // reflects real time, so a > threshold gap means we just woke.
  if (gap > DRIFT_SLEEP_THRESHOLD_MS) {
    const stats = _safeStats();
    const wedged = stats && stats.running === true
      && _lastObservedUptimeMs >= 0
      && stats.uptimeMs === _lastObservedUptimeMs;
    if (wedged) {
      _safeStop();
      _safeStart();
      _lastObservedUptimeMs = -1;
      _lastUptimeAdvanceAt = now;
      return;
    }
    _safeSend();
  }
}

function _livenessTick(opts) {
  const now = _now(opts);
  const stats = _safeStats();
  if (!stats) return;

  if (stats.running === false) {
    _safeStart();
    _lastObservedUptimeMs = -1;
    _lastUptimeAdvanceAt = now;
    _lastObservedFailures = 0;
    return;
  }

  const uptimeAdvanced = stats.uptimeMs !== _lastObservedUptimeMs;
  if (uptimeAdvanced) {
    _lastObservedUptimeMs = stats.uptimeMs;
    _lastUptimeAdvanceAt = now;
  } else if (
    stats.consecutiveFailures > 0
    && stats.consecutiveFailures >= _lastObservedFailures
    && _lastUptimeAdvanceAt > 0
    && now - _lastUptimeAdvanceAt > WEDGE_THRESHOLD_MS
  ) {
    _safeStop();
    _safeStart();
    _lastObservedUptimeMs = -1;
    _lastUptimeAdvanceAt = now;
    _lastObservedFailures = 0;
    return;
  }
  _lastObservedFailures = stats.consecutiveFailures || 0;
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
  _lastUptimeAdvanceAt = now;
  _lastObservedUptimeMs = -1;
  _lastObservedFailures = 0;
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
  _lastObservedUptimeMs = -1;
  _lastUptimeAdvanceAt = 0;
  _lastObservedFailures = 0;
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
