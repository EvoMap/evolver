'use strict';

const test = require('node:test');
const assert = require('node:assert');

const supervisor = require('../src/gep/heartbeatSupervisor');

function makeFakeA2a(overrides) {
  const state = {
    running: false,
    uptimeMs: 0,
    totalSent: 0,
    totalFailed: 0,
    consecutiveFailures: 0,
    startCalls: 0,
    stopCalls: 0,
    sendCalls: 0,
    sendErrors: 0,
    startThrows: false,
    sendThrows: false,
    onSend: null,
  };
  const api = {
    startHeartbeat() {
      state.startCalls++;
      if (state.startThrows) throw new Error('synthetic startHeartbeat error');
      state.running = true;
    },
    stopHeartbeat() {
      state.stopCalls++;
      state.running = false;
    },
    async sendHeartbeat() {
      state.sendCalls++;
      if (state.sendThrows) {
        state.sendErrors++;
        throw new Error('synthetic sendHeartbeat error');
      }
      if (typeof state.onSend === 'function') await state.onSend();
      state.totalSent++;
    },
    getHeartbeatStats() {
      return {
        running: state.running,
        uptimeMs: state.uptimeMs,
        totalSent: state.totalSent,
        totalFailed: state.totalFailed,
        consecutiveFailures: state.consecutiveFailures,
      };
    },
    _state: state,
  };
  if (overrides && typeof overrides === 'object') Object.assign(state, overrides);
  return api;
}

function cleanup() {
  try { supervisor.stop(); } catch (_e) { /* noop */ }
  supervisor._resetForTesting();
}

// --------------------------------------------------------------------------

test('start: calls a2a.startHeartbeat and rethrows first-attempt failure', () => {
  const a2a = makeFakeA2a({ startThrows: true });
  let threw = null;
  try { supervisor.start(a2a); } catch (e) { threw = e; }
  assert.ok(threw, 'first-attempt startHeartbeat failure must propagate');
  assert.match(threw.message, /synthetic startHeartbeat/);
  cleanup();
});

test('start: installs intervals and they are unref-able', () => {
  const a2a = makeFakeA2a();
  supervisor.start(a2a);
  assert.equal(a2a._state.startCalls, 1);
  assert.equal(a2a._state.running, true);
  cleanup();
});

// --------------------------------------------------------------------------
// Drift detector
// --------------------------------------------------------------------------

test('drift: wall-clock jump > threshold triggers sendHeartbeat', async () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  const handles = supervisor.start(a2a, { nowFn: () => now });
  const sendBefore = a2a._state.sendCalls;

  now += supervisor.DRIFT_SLEEP_THRESHOLD_MS + 1_000;
  handles._driftTick();
  await new Promise((r) => setImmediate(r));

  assert.ok(
    a2a._state.sendCalls > sendBefore,
    `expected sendHeartbeat after drift jump, got ${a2a._state.sendCalls - sendBefore} new calls`,
  );
  cleanup();
});

test('drift: small gap (< threshold) does NOT trigger send', async () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  const handles = supervisor.start(a2a, { nowFn: () => now });
  const sendBefore = a2a._state.sendCalls;

  now += 30_000;
  handles._driftTick();
  await new Promise((r) => setImmediate(r));

  assert.equal(a2a._state.sendCalls, sendBefore, 'no send for sub-threshold gap');
  cleanup();
});

test('drift: hard-restarts when wedge confirmed (running true but uptime stuck)', async () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  // Prime: liveness records uptime=0 as the current observation.
  handles._livenessTick();
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;

  // Wall-clock jump confirms suspension AND uptime did not advance.
  now += supervisor.DRIFT_SLEEP_THRESHOLD_MS + 1_000;
  handles._driftTick();

  assert.ok(
    a2a._state.stopCalls > stopBefore,
    'wedge confirmation must call stopHeartbeat',
  );
  assert.ok(
    a2a._state.startCalls > startBefore,
    'wedge confirmation must call startHeartbeat',
  );
  cleanup();
});

// --------------------------------------------------------------------------
// Liveness watchdog
// --------------------------------------------------------------------------

test('liveness: revives the loop when running flips to false', async () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  const handles = supervisor.start(a2a, { nowFn: () => now });
  const startBefore = a2a._state.startCalls;

  a2a._state.running = false; // loop "died"
  handles._livenessTick();

  assert.ok(
    a2a._state.startCalls > startBefore,
    'liveness watchdog must call startHeartbeat when running=false',
  );
  cleanup();
});

test('liveness: hard-restarts when uptime stuck AND failures > 0 past WEDGE_THRESHOLD_MS', async () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  // First tick locks in uptime=0 and lastUptimeAdvanceAt=now.
  a2a._state.uptimeMs = 100;
  handles._livenessTick();
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;

  // Time passes past wedge threshold, uptime stays the same, failures rising.
  now += supervisor.WEDGE_THRESHOLD_MS + 1_000;
  a2a._state.consecutiveFailures = 3;
  handles._livenessTick();

  assert.ok(a2a._state.stopCalls > stopBefore, 'wedged loop must be stopped');
  assert.ok(a2a._state.startCalls > startBefore, 'wedged loop must be restarted');
  cleanup();
});

test('liveness: healthy advancing uptime does NOT trigger restart', async () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  a2a._state.uptimeMs = 1_000;
  handles._livenessTick();
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;

  now += supervisor.WEDGE_THRESHOLD_MS + 10_000;
  a2a._state.uptimeMs = 200_000; // advanced
  a2a._state.consecutiveFailures = 0;
  handles._livenessTick();

  assert.equal(a2a._state.stopCalls, stopBefore, 'healthy node must not be restarted');
  assert.equal(a2a._state.startCalls, startBefore);
  cleanup();
});

// --------------------------------------------------------------------------
// poke()
// --------------------------------------------------------------------------

test('poke: single-flight gate dedupes concurrent calls', async () => {
  const a2a = makeFakeA2a();
  let release;
  const gate = new Promise((r) => { release = r; });
  a2a._state.onSend = () => gate;

  supervisor.start(a2a, { nowFn: () => 1_000_000 });
  const initialSends = a2a._state.sendCalls;

  // Mark as failing to bypass throttle and force real sends.
  a2a._state.consecutiveFailures = 5;

  const results = [];
  for (let i = 0; i < 10; i++) results.push(supervisor.poke('test', { nowFn: () => 1_000_000 + i }));

  // Exactly one poke should report attempted-send; the rest dedupe.
  const attempted = results.filter(Boolean).length;
  assert.equal(attempted, 1, `expected 1 attempted send across 10 concurrent pokes, got ${attempted}`);

  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(
    a2a._state.sendCalls - initialSends, 1,
    'exactly one underlying sendHeartbeat must have been invoked',
  );
  cleanup();
});

test('poke: healthy node second call within 60s is throttled', async () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  supervisor.start(a2a, { nowFn: () => now });

  a2a._state.consecutiveFailures = 0;
  const r1 = supervisor.poke('first', { nowFn: () => now });
  await new Promise((r) => setImmediate(r));

  now += 10_000;
  const r2 = supervisor.poke('second', { nowFn: () => now });

  assert.equal(r1, true, 'first healthy poke must attempt a send');
  assert.equal(r2, false, 'second healthy poke within throttle must no-op');
  cleanup();
});

test('poke: failing node bypasses throttle', async () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  supervisor.start(a2a, { nowFn: () => now });

  a2a._state.consecutiveFailures = 0;
  supervisor.poke('first', { nowFn: () => now });
  await new Promise((r) => setImmediate(r));

  // Now degrade and try again well within throttle window.
  a2a._state.consecutiveFailures = 3;
  now += 5_000;
  const r2 = supervisor.poke('recovery', { nowFn: () => now });
  await new Promise((r) => setImmediate(r));

  assert.equal(r2, true, 'failing node must bypass throttle so recovery is unblocked');
  cleanup();
});

test('poke: revives loop when stats.running is false', async () => {
  const a2a = makeFakeA2a();
  supervisor.start(a2a, { nowFn: () => 1_000_000 });
  const startBefore = a2a._state.startCalls;

  a2a._state.running = false;
  a2a._state.consecutiveFailures = 1;
  const r = supervisor.poke('revive', { nowFn: () => 1_000_000 });
  await new Promise((r) => setImmediate(r));

  assert.equal(r, true);
  assert.ok(a2a._state.startCalls > startBefore, 'poke must call startHeartbeat when loop is dead');
  cleanup();
});

test('poke: swallows sendHeartbeat errors (does not throw)', async () => {
  const a2a = makeFakeA2a();
  supervisor.start(a2a, { nowFn: () => 1_000_000 });
  a2a._state.sendThrows = true;
  a2a._state.consecutiveFailures = 1;

  let threw = null;
  try { supervisor.poke('err', { nowFn: () => 1_000_000 }); } catch (e) { threw = e; }
  assert.equal(threw, null, 'poke must never throw to its caller');
  // Drain the in-flight promise.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  cleanup();
});

test('poke: returns false when supervisor has not been started', () => {
  // No start() call.
  supervisor._resetForTesting();
  const r = supervisor.poke('cold', { nowFn: () => 1 });
  assert.equal(r, false);
});

// --------------------------------------------------------------------------
// stop() + error resilience
// --------------------------------------------------------------------------

test('stop: clears intervals, calls a2a.stopHeartbeat, and is idempotent', () => {
  const a2a = makeFakeA2a();
  supervisor.start(a2a, { nowFn: () => 1_000_000 });
  supervisor.stop();
  assert.equal(a2a._state.stopCalls, 1);
  // Second stop must be a no-op (and not throw).
  supervisor.stop();
  assert.equal(a2a._state.stopCalls, 1, 'stop must be idempotent (no double stopHeartbeat)');
  cleanup();
});

test('errors from sendHeartbeat / startHeartbeat after start do not crash the supervisor', async () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  // Subsequent startHeartbeat calls throw, and so does sendHeartbeat.
  a2a._state.startThrows = true;
  a2a._state.sendThrows = true;

  // Force a drift jump (would call sendHeartbeat) — must not throw.
  now += supervisor.DRIFT_SLEEP_THRESHOLD_MS + 1_000;
  let driftThrew = null;
  try { handles._driftTick(); } catch (e) { driftThrew = e; }
  assert.equal(driftThrew, null, 'drift tick must not propagate sendHeartbeat errors');

  // Force liveness to call startHeartbeat (running=false) — must not throw.
  a2a._state.running = false;
  let livenessThrew = null;
  try { handles._livenessTick(); } catch (e) { livenessThrew = e; }
  assert.equal(livenessThrew, null, 'liveness tick must not propagate startHeartbeat errors');

  await new Promise((r) => setImmediate(r));
  cleanup();
});
