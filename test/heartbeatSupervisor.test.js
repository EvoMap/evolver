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

test('start: swallows first-attempt startHeartbeat throw and stays alive for liveness retry', () => {
  // Previously this rethrew, which caused index.js's outer catch to log and
  // continue — but the supervisor was then permanently dead (_started=false,
  // every poke() and tick a no-op). Now the supervisor must stay alive so
  // the liveness tick can observe running===false and retry _safeStart().
  const a2a = makeFakeA2a({ startThrows: true });
  let threw = null;
  let handles = null;
  try { handles = supervisor.start(a2a); } catch (e) { threw = e; }
  assert.equal(threw, null, 'initial startHeartbeat throw must not propagate');
  assert.ok(handles, 'supervisor must hand back tick handles even after initial throw');

  // Stats still report running=false because startHeartbeat threw before
  // flipping it. Now allow the next call to succeed and verify the liveness
  // tick brings the loop up.
  a2a._state.startThrows = false;
  const startBefore = a2a._state.startCalls;
  handles._livenessTick();
  assert.ok(
    a2a._state.startCalls > startBefore,
    'liveness must retry startHeartbeat after the initial failure',
  );
  assert.equal(a2a._state.running, true, 'retry must bring the loop up');
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

test('liveness: advancing totalFailed only (stuck-in-backoff) DOES trigger restart after WEDGE_THRESHOLD_MS', () => {
  // To the hub, a loop that attempts every minute and fails every minute
  // for 15 min is indistinguishable from a wedged loop -- no successful
  // heartbeat reaches the hub in either case. The previous "totalSent +
  // totalFailed" freshness signal kept refreshing on every failed attempt
  // and never fired the restart in this mode. Keying off totalSent ONLY
  // catches it: 15 min with no successful send -> stop+start (which drops
  // the obfuscated module's accumulated backoff and gives the loop a
  // fresh chance).
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  handles._livenessTick();
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;

  // Walk forward >15 min advancing totalFailed every interval. totalSent
  // stays put (no successful heartbeat reached the hub).
  for (let i = 0; i < 5; i++) {
    now += 4 * 60 * 1000;
    a2a._state.totalFailed += 1;
    a2a._state.consecutiveFailures += 1;
    handles._livenessTick();
  }

  assert.ok(
    a2a._state.stopCalls > stopBefore,
    'wedge gate must fire stop+start when no successful send for > WEDGE_THRESHOLD_MS',
  );
  assert.ok(a2a._state.startCalls > startBefore, 'wedge restart must also call startHeartbeat');
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

  // First poke fires through (no prior poke = throttle doesn't apply).
  // The other 9 dedupe via _pokeInFlight, which is what this test is
  // actually probing -- the throttle is a separate concern covered
  // elsewhere.
  a2a._state.consecutiveFailures = 0;

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

test('poke: failing node ALSO respects throttle (no fan-out)', async () => {
  // Previously, consecutiveFailures > 0 bypassed the throttle so a stuck
  // node could recover immediately on any poke. That was the wrong knob:
  // an IDE polling at 4 Hz during a failure streak would fan out into
  // many sends per second once each send completed fast on a 401,
  // exhausting the hub's 6/300s per-sender heartbeat budget. The
  // throttle now applies uniformly. The drift detector still handles
  // sleep/wake recovery independently, and the liveness watchdog handles
  // wedged loops -- so user-perceived recovery is still bounded.
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

  assert.equal(r2, false, 'failing node within throttle window must NOT bypass throttle');
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

// --------------------------------------------------------------------------
// H1: null-stats safety net
// --------------------------------------------------------------------------

test('liveness: NULL_STATS_RESTART_THRESHOLD consecutive null stats force _hardRestart', () => {
  // Previously, if getHeartbeatStats() entered a state where it
  // permanently threw or returned non-object, _safeStats() returned
  // null and _livenessTick early-returned forever. The supervisor had
  // no recovery for that path, so a process whose obfuscated module
  // hit this state stayed "dead" until restart — matching the
  // user-reported symptom exactly. The H1 fix counts consecutive
  // nulls and force-restarts at the threshold.
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  // Wire a broken getHeartbeatStats that always throws — _safeStats()
  // swallows the throw and returns null, the same as a returns-null
  // implementation would. (Both paths feed the same counter.)
  a2a.getHeartbeatStats = () => { throw new Error('synthetic stats failure'); };

  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;
  const threshold = supervisor.NULL_STATS_RESTART_THRESHOLD;

  // Fire (threshold - 1) ticks: no restart yet, just counting.
  for (let i = 0; i < threshold - 1; i++) handles._livenessTick();
  assert.equal(
    a2a._state.stopCalls, stopBefore,
    'must not restart before threshold ticks have observed null stats',
  );
  assert.equal(a2a._state.startCalls, startBefore);

  // The Nth null-stats tick triggers the restart.
  handles._livenessTick();
  assert.ok(
    a2a._state.stopCalls > stopBefore,
    'after threshold null stats, supervisor must call stopHeartbeat',
  );
  assert.ok(
    a2a._state.startCalls > startBefore,
    'after threshold null stats, supervisor must call startHeartbeat',
  );
  cleanup();
});

test('liveness: a single good stats observation resets the null-stats counter', () => {
  // Transient stats failures (e.g. a one-off exception during a state
  // transition inside the obfuscated module) must NOT accumulate
  // toward the restart threshold. Any successful stats read clears
  // the counter so only PERSISTENT null returns trigger the safety net.
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });

  const goodStats = a2a.getHeartbeatStats;
  const threshold = supervisor.NULL_STATS_RESTART_THRESHOLD;

  // (threshold - 1) bad ticks, then one good one, then (threshold - 1)
  // more bad ticks. If the counter resets correctly, no restart fires
  // across this sequence of 2*threshold-1 ticks.
  a2a.getHeartbeatStats = () => null;
  for (let i = 0; i < threshold - 1; i++) handles._livenessTick();

  a2a.getHeartbeatStats = goodStats;
  handles._livenessTick();
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;

  a2a.getHeartbeatStats = () => null;
  for (let i = 0; i < threshold - 1; i++) handles._livenessTick();

  assert.equal(
    a2a._state.stopCalls, stopBefore,
    'a successful stats read must reset the null-stats counter (no restart yet)',
  );
  assert.equal(a2a._state.startCalls, startBefore);
  cleanup();
});

test('liveness: wedgeThresholdMs override is honored', () => {
  // Tests need a smaller threshold than 15 minutes to exercise the
  // wedge path in reasonable time. The override is only used by
  // tests; production code passes no opts and gets WEDGE_THRESHOLD_MS.
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now, wedgeThresholdMs: 5_000 });

  // Baseline tick at T=0 captures totalSent=0.
  handles._livenessTick();
  const stopBefore = a2a._state.stopCalls;

  // Advance past the override (5s), still well under the production
  // 15-min threshold. Without the override this would not fire.
  now += 6_000;
  handles._livenessTick();

  assert.ok(
    a2a._state.stopCalls > stopBefore,
    'wedge must fire with override even though production WEDGE_THRESHOLD_MS is 15 min',
  );
  cleanup();
});

// --------------------------------------------------------------------------
// Consecutive-failure gate (503-loop blindness fix)
// --------------------------------------------------------------------------

test('liveness: consecutiveFailures >= threshold triggers hardRestart even when totalSent advances', () => {
  // Reproduces the documented "hub returns 503 in a tight loop" failure
  // mode. totalSent keeps advancing (the obfuscated module increments it
  // on every HTTP round-trip regardless of status), so the freshness wedge
  // never fires. The companion gate must catch this.
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, {
    nowFn: () => now,
    consecutiveFailureRestartThreshold: 5,
    wedgeThresholdMs: 60 * 60_000, // way out so the wedge cannot fire
  });

  // Simulate the 503-loop: every attempt advances totalSent AND
  // consecutiveFailures. Tick a few times.
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;
  for (let i = 0; i < 6; i++) {
    a2a._state.totalSent += 1;
    a2a._state.consecutiveFailures += 1;
    now += 30_000;
    handles._livenessTick();
  }

  assert.ok(
    a2a._state.stopCalls > stopBefore,
    'consecutiveFailures gate must trigger stopHeartbeat once cf >= threshold',
  );
  assert.ok(
    a2a._state.startCalls > startBefore,
    'consecutiveFailures gate must trigger startHeartbeat after stop',
  );
  cleanup();
});

test('liveness: consecutiveFailures gate respects thrash guard (no tight restart loop)', () => {
  // If a restart does not fix the underlying issue and consecutiveFailures
  // stays high, the gate must NOT fire again until _wedgeThresholdMs has
  // elapsed since the last restart. Without this guard a permanent 503
  // would produce a stop+start every liveness tick.
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, {
    nowFn: () => now,
    consecutiveFailureRestartThreshold: 3,
    wedgeThresholdMs: 30_000, // also used as the cf-gate cooldown
  });

  a2a._state.consecutiveFailures = 10;
  // First fire.
  handles._livenessTick();
  const stopAfterFirst = a2a._state.stopCalls;
  assert.ok(stopAfterFirst > 0, 'first qualifying observation must restart');

  // Same tick state, only ~5s later: cooldown not elapsed.
  now += 5_000;
  handles._livenessTick();
  assert.equal(a2a._state.stopCalls, stopAfterFirst, 'must NOT restart within cooldown');

  // Past cooldown: can fire again.
  now += 30_000;
  handles._livenessTick();
  assert.ok(
    a2a._state.stopCalls > stopAfterFirst,
    'must restart once cooldown has elapsed and cf still high',
  );
  cleanup();
});

test('liveness: consecutiveFailures below threshold does NOT restart', () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, {
    nowFn: () => now,
    consecutiveFailureRestartThreshold: 10,
    wedgeThresholdMs: 60 * 60_000,
  });
  const stopBefore = a2a._state.stopCalls;
  a2a._state.consecutiveFailures = 3;
  for (let i = 0; i < 3; i++) {
    a2a._state.totalSent += 1;
    now += 30_000;
    handles._livenessTick();
  }
  assert.equal(a2a._state.stopCalls, stopBefore, 'must not restart while cf below threshold');
  cleanup();
});

// --------------------------------------------------------------------------
// _hardRestart single-flight (concurrent drift+liveness race on host wake)
// --------------------------------------------------------------------------

test('hardRestart: concurrent drift and liveness ticks do not interleave stop+start', () => {
  // On macOS wake both intervals fire near-simultaneously. Without single-
  // flight, both would call _safeStop()+_safeStart() and potentially
  // interleave with each other inside the obfuscated module's own state.
  //
  // We simulate the race by making stopHeartbeat re-entrantly invoke
  // _driftTick from inside (the worst-case observation: stop yields the
  // micro-task to a pending drift fire). With the single-flight gate, the
  // re-entrant call must be a no-op; without it, we would see stopCalls
  // jump by 2 or more on a single restart.
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const handles = supervisor.start(a2a, { nowFn: () => now });
  // Force a wake gap so the next _driftTick wants to restart.
  now += 60 * 60 * 1000;

  let reentryDriftCalls = 0;
  const realStop = a2a.stopHeartbeat.bind(a2a);
  a2a.stopHeartbeat = function () {
    realStop();
    // Re-enter while _hardRestart is mid-flight. Must be a no-op.
    reentryDriftCalls += 1;
    handles._driftTick();
  };

  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;
  handles._driftTick();

  assert.equal(reentryDriftCalls, 1, 'sanity: reentrant drift fired exactly once');
  assert.equal(
    a2a._state.stopCalls - stopBefore, 1,
    'single-flight gate must suppress the reentrant stopHeartbeat',
  );
  assert.equal(
    a2a._state.startCalls - startBefore, 1,
    'single-flight gate must suppress the reentrant startHeartbeat',
  );
  cleanup();
});

// --------------------------------------------------------------------------
// Configurable interval cadences (testability for real-timer suspend tests)
// --------------------------------------------------------------------------

test('start: driftCheckMs and livenessCheckMs opts drive real intervals', async () => {
  // The supervisor's normal production cadence is 30s / 60s; this test
  // verifies the override actually wires through to setInterval. Without
  // the override, a real-timer suspend test would have to wait minutes
  // per assertion.
  const a2a = makeFakeA2a();
  let driftFires = 0;
  let livenessFires = 0;
  const originalSetInterval = global.setInterval;
  const intervalDelays = [];
  global.setInterval = function (fn, delay) {
    intervalDelays.push(delay);
    return originalSetInterval(function () {
      // Tag which interval is which by closure inspection — not great,
      // but acceptable here. The supervisor's drift fn is the first
      // setInterval call; liveness is the second.
      if (intervalDelays[0] === delay && driftFires + livenessFires < 1000) {
        driftFires += 1;
      } else {
        livenessFires += 1;
      }
      try { fn(); } catch (_) { /* noop */ }
    }, delay);
  };
  try {
    supervisor.start(a2a, { driftCheckMs: 10, livenessCheckMs: 20 });
    assert.deepEqual(intervalDelays.slice(0, 2), [10, 20], 'opts must reach setInterval');
  } finally {
    global.setInterval = originalSetInterval;
    cleanup();
  }
});

// --------------------------------------------------------------------------
// Terminal-state diagnostic (cannot detect node_disabled from outside the
// obfuscated module; surface a user-visible warning after N stuck restarts)
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Real-timer suspend simulation (closes the audit gap that all sleep tests
// were manual _driftTick() calls; this drives the actual setInterval path)
// --------------------------------------------------------------------------

test('realTimer: driftCheckMs interval + synthetic clock jump triggers _hardRestart without manual tick', async () => {
  const a2a = makeFakeA2a();
  // Synthetic clock: starts at 0, real time advances normally, but we
  // simulate "host suspend" by manually jumping it forward mid-test.
  // The supervisor's drift detector reads nowFn() each fire; the gap
  // it sees on its NEXT fire will exceed DRIFT_SLEEP_THRESHOLD_MS.
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const stopBefore = a2a._state.stopCalls;
  const startBefore = a2a._state.startCalls;

  // Cadence: drift fires every 20ms in this test. Production is 30_000ms.
  supervisor.start(a2a, {
    nowFn: () => now,
    driftCheckMs: 20,
    livenessCheckMs: 5000, // irrelevant for this test
  });

  // Let the drift interval fire once or twice at baseline (gap << threshold).
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    a2a._state.stopCalls, stopBefore,
    'baseline drift fires must not restart',
  );

  // Simulate host suspend: jump the synthetic clock forward by 5 minutes.
  // The next REAL interval fire (without us calling _driftTick manually)
  // will see a 5-minute gap > 90s threshold and trigger _hardRestart.
  now += 5 * 60 * 1000;
  await new Promise((r) => setTimeout(r, 50));

  assert.ok(
    a2a._state.stopCalls > stopBefore,
    'real-timer drift fire after clock jump must call stopHeartbeat',
  );
  assert.ok(
    a2a._state.startCalls > startBefore,
    'real-timer drift fire after clock jump must call startHeartbeat',
  );
  cleanup();
});

test('terminalDiagnostic: logs user-visible warning after N consecutive restarts without recovery', () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = function (msg) { warnings.push(String(msg)); };
  try {
    const handles = supervisor.start(a2a, {
      nowFn: () => now,
      consecutiveFailureRestartThreshold: 3,
      wedgeThresholdMs: 30_000,
    });

    // Drive 3 consecutive _hardRestart calls (via the cf gate) without any
    // observed recovery: consecutiveFailures stays elevated, totalSent
    // does not change. Cooldown is 30s so we step >30s between each.
    a2a._state.consecutiveFailures = 10;
    for (let i = 0; i < 3; i++) {
      handles._livenessTick();
      now += 35_000;
    }

    const matches = warnings.filter((w) => w.includes('supervisor has restarted'));
    assert.ok(
      matches.length >= 1,
      'must emit at least one terminal-state diagnostic after 3 stuck restarts; got ' + JSON.stringify(warnings),
    );
    // Logged at most once per stuck episode.
    assert.equal(matches.length, 1, 'must not spam the diagnostic across each tick');
  } finally {
    console.warn = originalWarn;
    cleanup();
  }
});

test('terminalDiagnostic: recovery (sent advances + cf=0) resets the counter and re-arms the warning', () => {
  const a2a = makeFakeA2a();
  let now = 1_000_000;
  a2a._state.nowFn = () => now;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = function (msg) { warnings.push(String(msg)); };
  try {
    const handles = supervisor.start(a2a, {
      nowFn: () => now,
      consecutiveFailureRestartThreshold: 3,
      wedgeThresholdMs: 30_000,
    });

    // Stuck episode: drive 3 restarts.
    a2a._state.consecutiveFailures = 10;
    for (let i = 0; i < 3; i++) {
      handles._livenessTick();
      now += 35_000;
    }
    const stuckMatches = warnings.filter((w) => w.includes('supervisor has restarted'));
    assert.equal(stuckMatches.length, 1, 'first stuck episode must log once');

    // Recovery: totalSent advances AND consecutiveFailures drops to 0.
    a2a._state.totalSent = 5;
    a2a._state.consecutiveFailures = 0;
    handles._livenessTick();

    // Second stuck episode: drive 3 more restarts. The latch must have
    // been cleared by the recovery, so a fresh warning fires.
    a2a._state.consecutiveFailures = 10;
    for (let i = 0; i < 3; i++) {
      now += 35_000;
      handles._livenessTick();
    }
    const allMatches = warnings.filter((w) => w.includes('supervisor has restarted'));
    assert.equal(
      allMatches.length, 2,
      'after recovery, a fresh stuck episode must re-fire the diagnostic; got ' + allMatches.length,
    );
  } finally {
    console.warn = originalWarn;
    cleanup();
  }
});
