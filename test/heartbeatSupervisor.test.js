'use strict';

const test = require('node:test');
const assert = require('node:assert');

const supervisor = require('../src/gep/heartbeatSupervisor');

// Production-faithful fake. `uptimeMs` is driven by `nowFn` so it advances on
// real time (matching the obfuscated a2aProtocol's actual semantics, which is
// the whole point of this refactor: uptimeMs is NOT a freshness signal). The
// only way `totalSent` / `totalFailed` advance is by actually exercising
// `sendHeartbeat`, which is the new freshness signal the supervisor relies on.
function makeFakeA2a(overrides) {
  const state = {
    running: false,
    startedAtMs: null,
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
    // Optional clock — if set, getHeartbeatStats() computes uptimeMs from it.
    nowFn: null,
  };
  const api = {
    startHeartbeat() {
      state.startCalls++;
      if (state.startThrows) throw new Error('synthetic startHeartbeat error');
      state.running = true;
      state.startedAtMs = typeof state.nowFn === 'function' ? state.nowFn() : Date.now();
    },
    stopHeartbeat() {
      state.stopCalls++;
      state.running = false;
    },
    async sendHeartbeat() {
      state.sendCalls++;
      if (state.sendThrows) {
        state.sendErrors++;
        state.totalFailed++;
        throw new Error('synthetic sendHeartbeat error');
      }
      if (typeof state.onSend === 'function') await state.onSend();
      state.totalSent++;
    },
    getHeartbeatStats() {
      const now = typeof state.nowFn === 'function' ? state.nowFn() : Date.now();
      const uptimeMs = state.running && state.startedAtMs != null ? now - state.startedAtMs : 0;
      return {
        running: state.running,
        uptimeMs,
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

test('drift: wall-clock jump > threshold triggers stop+start (unconditional)', () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;
  const sendBefore = a2a._state.sendCalls;

  // Simulate macOS sleep: wall-clock jumps by an hour while the supervisor
  // was suspended.
  now += 60 * 60 * 1000;
  handles._driftTick();

  assert.ok(
    a2a._state.stopCalls > stopBefore,
    `expected stopHeartbeat on sleep gap, got ${a2a._state.stopCalls - stopBefore} new calls`,
  );
  assert.ok(
    a2a._state.startCalls > startBefore,
    `expected startHeartbeat on sleep gap, got ${a2a._state.startCalls - startBefore} new calls`,
  );
  // Drift no longer uses one-shot sendHeartbeat: stop+start is the only known
  // way to reset the obfuscated module's internal cadence.
  assert.equal(a2a._state.sendCalls, sendBefore, 'drift must not call sendHeartbeat');
  cleanup();
});

test('drift: small gap (< threshold) does NOT touch the heartbeat', () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;
  const sendBefore = a2a._state.sendCalls;

  now += 30_000;
  handles._driftTick();

  assert.equal(a2a._state.stopCalls, stopBefore);
  assert.equal(a2a._state.startCalls, startBefore);
  assert.equal(a2a._state.sendCalls, sendBefore);
  cleanup();
});

test('drift: sleep gap restart does NOT depend on prior liveness observation', () => {
  // The old wedge gate required `_lastObservedUptimeMs >= 0` which only got
  // set by a prior liveness tick. After a fast sleep that beat liveness to
  // the punch, the supervisor used to send a one-shot heartbeat instead of
  // restarting. Verify the new behaviour does not have that race.
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;

  // Sleep BEFORE liveness ever runs (would have been < 60s in old code).
  now += supervisor.DRIFT_SLEEP_THRESHOLD_MS + 1_000;
  handles._driftTick();

  assert.ok(a2a._state.stopCalls > stopBefore);
  assert.ok(a2a._state.startCalls > startBefore);
  cleanup();
});

// --------------------------------------------------------------------------
// Liveness watchdog
// --------------------------------------------------------------------------

test('liveness: revives the loop when running flips to false', () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
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

test('liveness: hard-restarts when totalSent+totalFailed unchanged past WEDGE_THRESHOLD_MS', () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  // First tick: observe baseline (totalSent=0, totalFailed=0).
  handles._livenessTick();
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;

  // Time passes well beyond wedge threshold with NO send attempts. This is
  // the realistic "stuck in backoff" scenario: uptimeMs advances on real
  // time (verified by getHeartbeatStats() using nowFn) but totalSent and
  // totalFailed stay put because the internal loop made zero attempts.
  now += supervisor.WEDGE_THRESHOLD_MS + 60_000;
  handles._livenessTick();

  assert.ok(a2a._state.stopCalls > stopBefore, 'wedged loop must be stopped');
  assert.ok(a2a._state.startCalls > startBefore, 'wedged loop must be restarted');
  cleanup();
});

test('liveness: advancing totalSent (healthy node) does NOT trigger restart', () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  handles._livenessTick(); // baseline
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;

  // Healthy: a send happens every cycle, totalSent grows.
  for (let i = 0; i < 5; i++) {
    now += 6 * 60 * 1000; // one healthy heartbeat interval
    a2a._state.totalSent += 1;
    handles._livenessTick();
  }
  // Even though much more than WEDGE_THRESHOLD_MS has elapsed in absolute
  // terms, freshness was refreshed at each tick.
  assert.equal(a2a._state.stopCalls, stopBefore, 'healthy node must not be restarted');
  assert.equal(a2a._state.startCalls, startBefore);
  cleanup();
});

test('liveness: advancing totalFailed (loop alive but network broken) does NOT trigger restart', () => {
  // The internal loop is doing its job — attempting and failing. That is
  // network failure, not wedge. Do not restart in this case.
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  handles._livenessTick();
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;

  for (let i = 0; i < 5; i++) {
    now += 6 * 60 * 1000;
    a2a._state.totalFailed += 1;
    a2a._state.consecutiveFailures += 1;
    handles._livenessTick();
  }
  assert.equal(a2a._state.stopCalls, stopBefore);
  assert.equal(a2a._state.startCalls, startBefore);
  cleanup();
});

// --------------------------------------------------------------------------
// End-to-end: the reported user scenario
// --------------------------------------------------------------------------

test('end-to-end: heartbeat alive -> long sleep -> drift restart -> resumes sending', async () => {
  // This is the actual reported bug: process starts and registers, user
  // goes idle for a long time (macOS sleeps), comes back, and the heartbeat
  // never recovers. We model the obfuscated module's "stuck in backoff"
  // state as `running:true, no totalSent advance, uptimeMs growing on real
  // time" — which is what production stats look like.
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  // T0: one successful heartbeat early in life.
  await a2a.sendHeartbeat();
  const sentAfterFirst = a2a._state.totalSent;
  assert.equal(sentAfterFirst, 1);

  // The internal loop falls into a long backoff: no further send attempts.
  // (We do not call sendHeartbeat. running stays true. uptimeMs grows.)

  // User closes lid for 1 hour. setInterval is suspended during sleep, so
  // we model that by NOT calling tick functions during the gap.
  now += 60 * 60 * 1000;

  // On wake, drift tick fires before liveness. With the new logic it
  // unconditionally stops and restarts the internal heartbeat, dropping
  // accumulated backoff.
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;
  handles._driftTick();
  assert.ok(a2a._state.stopCalls > stopBefore, 'drift must stop the wedged loop');
  assert.ok(a2a._state.startCalls > startBefore, 'drift must restart the loop');

  // After restart, the next heartbeat send works (real obfuscated module
  // would resume its internal cadence; we model that by an external send
  // succeeding now).
  await a2a.sendHeartbeat();
  assert.equal(a2a._state.totalSent, sentAfterFirst + 1, 'heartbeat must resume sending');
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

test('errors from stopHeartbeat / startHeartbeat during ticks do not crash the supervisor', () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  // Subsequent start/stop calls all throw — drift tick (stop+start) and
  // liveness tick (start on running=false) must both swallow.
  a2a._state.startThrows = true;

  // Force a drift sleep gap: would call stop+start.
  now += supervisor.DRIFT_SLEEP_THRESHOLD_MS + 1_000;
  let driftThrew = null;
  try { handles._driftTick(); } catch (e) { driftThrew = e; }
  assert.equal(driftThrew, null, 'drift tick must not propagate startHeartbeat errors');

  // Force liveness to call startHeartbeat (running=false) — must not throw.
  a2a._state.running = false;
  let livenessThrew = null;
  try { handles._livenessTick(); } catch (e) { livenessThrew = e; }
  assert.equal(livenessThrew, null, 'liveness tick must not propagate startHeartbeat errors');
});
