'use strict';

// Regression tests for issue #544: the proxy heartbeat loop could be
// permanently killed by a single pre-fetch exception, and once stuck in
// the 30-min backoff cap there was no way to wake it earlier.

const test = require('node:test');
const assert = require('node:assert');

const { LifecycleManager } = require('../src/proxy/lifecycle/manager');

// hubFetch routes through global.fetch when this is set (see existing
// lifecycle tests). Each test file gets its own worker process under
// `node --test`, so this does not leak.
const _origInsecure = process.env.EVOMAP_HUB_ALLOW_INSECURE;
process.env.EVOMAP_HUB_ALLOW_INSECURE = '1';
test.after(() => {
  if (_origInsecure === undefined) delete process.env.EVOMAP_HUB_ALLOW_INSECURE;
  else process.env.EVOMAP_HUB_ALLOW_INSECURE = _origInsecure;
});

function makeStore({ countPending } = {}) {
  const state = { node_id: 'node_aaaaaaaaaaaa', node_secret: 'a'.repeat(64) };
  return {
    getState: (k) => state[k] ?? null,
    setState: (k, v) => { state[k] = v; },
    countPending: countPending || (() => 0),
    writeInbound: () => {},
    writeInboundBatch: () => {},
  };
}

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

function makeManager({ store, fetchImpl, getTaskMeta } = {}) {
  // Swap in our fetch stub for the duration of construction + the test.
  // Each test installs its own and restores on teardown.
  return new LifecycleManager({
    hubUrl: 'https://example.test',
    store: store || makeStore(),
    logger: silentLogger(),
    getTaskMeta: getTaskMeta || (() => ({})),
  });
}

function installFetchStub(impl) {
  const orig = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = orig; };
}

// --------------------------------------------------------------------------

test('heartbeat: store.countPending throwing does NOT escape heartbeat()', async () => {
  // Pre-fix this would throw synchronously out of heartbeat() because the
  // call lived outside the try block.
  const store = makeStore({
    countPending: () => { throw new Error('simulated store corruption'); },
  });
  const restore = installFetchStub(async () => {
    // Should never be reached because pending count throws first, but
    // return a 200 so the failure mode is unambiguous if behavior shifts.
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
  });

  const lc = makeManager({ store });
  let threw = null;
  let result;
  try {
    result = await lc.heartbeat();
  } catch (err) {
    threw = err;
  }
  restore();

  assert.equal(threw, null, 'heartbeat() must not throw -- it must catch and return {ok:false}');
  assert.equal(result.ok, false);
  assert.match(result.error, /simulated store corruption/);
  assert.equal(lc._consecutiveFailures, 1, '_consecutiveFailures must be bumped so backoff kicks in');
});

test('startHeartbeatLoop: explicit _onTickReschedule hook observes every reschedule with reason+delay', async () => {
  // Robust to minification/rename — the existing test sniffs fn.toString()
  // to identify which setTimeout call is the heartbeat reschedule, which
  // silently no-ops if the production code is ever bundled/obfuscated.
  // This test exercises the same loop-survival invariant via the explicit
  // hook that production code emits at every reschedule site.
  const lc = makeManager();
  let heartbeatCalls = 0;
  lc.heartbeat = async () => { heartbeatCalls++; throw new Error('synthetic'); };

  const reschedules = [];
  lc._onTickReschedule = (delayMs, reason) => { reschedules.push({ delayMs, reason }); };

  const realSetTimeout = global.setTimeout;
  const TARGET = 5;
  // Stub setTimeout to chain via the hook signal rather than fn-toString.
  // We chain a setTimeout only when the immediately-preceding hook fired
  // (the engine reschedule path always calls the hook just before
  // setTimeout). Bootstrap call from startHeartbeatLoop's initial
  // this._tick() does NOT go through _scheduleNextTick, so it's not
  // counted -- which matches our intent (we count reschedules, not the
  // initial fire).
  let pendingHook = false;
  const hookProxy = lc._onTickReschedule;
  lc._onTickReschedule = (delayMs, reason) => {
    pendingHook = true;
    hookProxy(delayMs, reason);
  };
  let chained = 0;
  global.setTimeout = function (fn, ms, ...rest) {
    if (pendingHook) {
      pendingHook = false;
      chained++;
      if (chained < TARGET) {
        return realSetTimeout(fn, 0, ...rest);
      }
      return { unref: () => {} };
    }
    return realSetTimeout(fn, ms, ...rest);
  };

  try {
    lc.startHeartbeatLoop(30_000);
    await new Promise((r) => realSetTimeout(r, 100));
    assert.ok(
      heartbeatCalls >= TARGET,
      `expected >= ${TARGET} heartbeat calls across the chain, got ${heartbeatCalls}`,
    );
    assert.ok(
      reschedules.length >= TARGET,
      `expected >= ${TARGET} hook fires, got ${reschedules.length}`,
    );
    // Every reschedule should carry a non-empty reason tag.
    for (const entry of reschedules) {
      assert.equal(typeof entry.delayMs, 'number');
      assert.ok(entry.reason && typeof entry.reason === 'string', 'reason must be set');
    }
  } finally {
    lc.stopHeartbeatLoop();
    global.setTimeout = realSetTimeout;
  }
});

test('startHeartbeatLoop: continuous rejections must reschedule >=5 successive ticks', async () => {
  // The loop-killer bug class is "stops rescheduling at tick N>=2". Asserting
  // a single reschedule (the previous version of this test) would also pass
  // a broken implementation that re-schedules exactly once and then dies.
  // We stub setTimeout to fire the tick closure immediately so the chain
  // runs to completion in microtasks, and assert >=5 successive ticks.
  const lc = makeManager();
  let heartbeatCalls = 0;
  lc.heartbeat = async () => { heartbeatCalls++; throw new Error('synthetic'); };

  const realSetTimeout = global.setTimeout;
  let scheduledChainedTicks = 0;
  const TARGET = 5;
  global.setTimeout = function (fn, ms, ...rest) {
    try {
      const src = fn && fn.toString ? fn.toString() : '';
      if (src.includes('_tickInFlight') || (src.includes('_running') && src.includes('heartbeat'))) {
        scheduledChainedTicks++;
        if (scheduledChainedTicks < TARGET) {
          // Fire the next tick immediately so we observe whether the chain
          // continues. After TARGET, stop chaining to avoid infinite loop.
          return realSetTimeout(fn, 0, ...rest);
        }
        // Stop the chain. Return a fake timer that does nothing.
        return { unref: () => {} };
      }
    } catch { /* noop */ }
    return realSetTimeout(fn, ms, ...rest);
  };

  try {
    lc.startHeartbeatLoop(30_000);
    // Give the chain time to play out.
    await new Promise((r) => realSetTimeout(r, 100));
    assert.ok(
      heartbeatCalls >= TARGET,
      `expected >= ${TARGET} heartbeat calls across the chain, got ${heartbeatCalls}`,
    );
    assert.ok(
      scheduledChainedTicks >= TARGET,
      `expected >= ${TARGET} successive reschedules, got ${scheduledChainedTicks}`,
    );
    assert.ok(lc._consecutiveFailures >= TARGET, 'failure counter must reflect every rejection');
  } finally {
    lc.stopHeartbeatLoop();
    global.setTimeout = realSetTimeout;
  }
});

test('pokeHeartbeat(): resets backoff state and re-enters the loop immediately', async () => {
  const lc = makeManager();
  // Synthesize a "stuck in 30-min backoff" state without actually waiting.
  lc.startHeartbeatLoop(30_000);
  // Let the very first tick settle so _tick is bound and timer is set.
  await new Promise((r) => setTimeout(r, 50));

  // Force the manager into the worst-case stuck state.
  lc._consecutiveFailures = 8;
  lc._reauthBackoffUntil = Date.now() + 4 * 60 * 60_000; // 4h in the future
  // Push _lastTickAttemptAt past the throttle window so we exercise the
  // "immediate fire" branch of pokeHeartbeat. Tests for the throttled
  // branch (state-clear without immediate fire) live separately.
  lc._lastTickAttemptAt = 0;
  const timerBeforePoke = lc._heartbeatTimer;

  // Replace heartbeat with a sentinel so we can detect the poke firing it.
  let pokedCallCount = 0;
  lc.heartbeat = async () => { pokedCallCount++; return { ok: true }; };

  const ok = lc.pokeHeartbeat();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(ok, true, 'pokeHeartbeat must return true when loop is running');
  assert.equal(lc._consecutiveFailures, 0, 'consecutive failures must be cleared');
  assert.equal(lc._reauthBackoffUntil, 0, 'reauth backoff window must be cleared');
  assert.notStrictEqual(lc._heartbeatTimer, timerBeforePoke, 'old timer must be replaced');
  assert.ok(pokedCallCount >= 1, `heartbeat must fire at least once after poke (got ${pokedCallCount})`);

  lc.stopHeartbeatLoop();
});

test('pokeHeartbeat(): under throttle still clears state and pulls the pending timer in', async () => {
  // Recovery path when user activity hits within POKE_THROTTLE_MS of the
  // last tick attempt: the throttle blocks an immediate hub call, but
  // state clearing happens anyway and the pending timer is pulled in to
  // fire when the throttle window opens (rather than at the long backoff
  // the failing tick had originally scheduled). Bounds user-perceived
  // recovery to ~60s instead of up to 30 min.
  const lc = makeManager();
  lc.startHeartbeatLoop(30_000);
  await new Promise((r) => setTimeout(r, 30));

  // Failing state with a recent tick attempt (throttle will block).
  lc._consecutiveFailures = 5;
  lc._reauthBackoffUntil = Date.now() + 30 * 60_000;
  lc._consecutiveReauthFailures = 1; // shallow -- backoff is wipeable
  lc._lastTickAttemptAt = Date.now() - 10; // very recent

  const ok = lc.pokeHeartbeat();

  assert.equal(ok, false, 'throttled poke must return false');
  assert.equal(lc._consecutiveFailures, 0, 'state clear happens regardless of throttle');
  assert.equal(lc._reauthBackoffUntil, 0, 'shallow-reauth-failure backoff cleared regardless of throttle');
  assert.ok(lc._heartbeatTimer, 'pending timer must remain so the loop survives');

  lc.stopHeartbeatLoop();
});

test('pokeHeartbeat(): noop when loop has not been started', () => {
  const lc = makeManager();
  assert.equal(lc.pokeHeartbeat(), false);
  assert.equal(lc._heartbeatTimer, null);
});

test('reAuthenticate: success path clears _reauthBackoffUntil', async () => {
  // Drive reAuthenticate end-to-end: hub returns 200 + a rotated secret on
  // /a2a/hello, then heartbeat verification returns 200. Pre-fix, a stale
  // _reauthBackoffUntil from an earlier incident would survive this success.
  const newSecret = 'b'.repeat(64);
  const restore = installFetchStub(async (url, _opts) => {
    const u = String(url);
    if (u.endsWith('/a2a/hello')) {
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({ payload: { node_secret: newSecret } }),
        text: async () => '',
      };
    }
    if (u.endsWith('/a2a/heartbeat')) {
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => '',
      };
    }
    throw new Error('unexpected URL: ' + u);
  });

  const lc = makeManager();
  // Set _reauthBackoffUntil to an EXPIRED but non-zero timestamp. The check
  // at reAuthenticate L290 is `> Date.now()`, so an expired value does NOT
  // short-circuit reAuth -- the success path runs and must clear the field.
  // Previously this test set the value to 0 right before calling reAuth,
  // which made the final "is it 0?" assertion meaningless: it would have
  // passed even if reAuth was a no-op.
  const expiredBackoff = Date.now() - 1000;
  lc._reauthBackoffUntil = expiredBackoff;
  lc._consecutiveReauthFailures = 2;

  const recovered = await lc.reAuthenticate();
  restore();

  assert.equal(recovered, true);
  assert.equal(lc._consecutiveReauthFailures, 0);
  assert.notStrictEqual(
    lc._reauthBackoffUntil, expiredBackoff,
    'success path must MUTATE _reauthBackoffUntil away from the pre-call value',
  );
  assert.equal(lc._reauthBackoffUntil, 0, 'success path must clear the backoff window to 0');
});

test('heartbeat: nodeId getter throwing does NOT escape heartbeat()', async () => {
  // The patch's expanded try block must cover the nodeId getter too.
  // countPending was already covered; this test locks down the second
  // pre-fetch synchronous call site that used to escape the loop.
  const store = makeStore();
  const realGetState = store.getState;
  store.getState = (k) => {
    if (k === 'node_id') throw new Error('store corrupted on node_id read');
    return realGetState(k);
  };
  const restore = installFetchStub(async () => ({
    ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '',
  }));

  const lc = makeManager({ store });
  let threw = null;
  let result;
  try { result = await lc.heartbeat(); } catch (err) { threw = err; }
  restore();

  assert.equal(threw, null, 'heartbeat() must catch nodeId getter throw');
  assert.equal(result.ok, false);
  assert.match(result.error, /store corrupted/);
  assert.equal(lc._consecutiveFailures, 1);
});

test('pokeHeartbeat(): rapid calls cannot pile up parallel ticks (in-flight gate)', async () => {
  // Regression for the race that an earlier draft of this patch had:
  // poke while tick was mid-await -> _heartbeatTimer still null -> poke
  // fires a parallel tick -> two ticks finish, each schedules a timer,
  // earlier reference leaks. With the _tickInFlight gate, all pokes
  // arriving during the in-flight window must observe at most ONE
  // concurrent heartbeat.
  const lc = makeManager();
  let inFlight = 0;
  let inFlightPeak = 0;
  lc.heartbeat = async () => {
    inFlight++;
    if (inFlight > inFlightPeak) inFlightPeak = inFlight;
    await new Promise((r) => setTimeout(r, 40)); // simulate slow hub fetch
    inFlight--;
    return { ok: true };
  };

  lc.startHeartbeatLoop(30_000);
  // Wait a microtask so the first tick has entered its await.
  await new Promise((r) => setTimeout(r, 5));
  // The first auto-tick is mid-await, so pokes will hit the in-flight
  // gate (this test's actual subject) rather than the throttle. We do
  // not need the old wasFailing bypass for the test to work.
  lc._consecutiveFailures = 5;

  // Fire many pokes during the in-flight window.
  for (let i = 0; i < 10; i++) lc.pokeHeartbeat();
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(inFlightPeak, 1, `expected max 1 concurrent heartbeat, got ${inFlightPeak}`);
  assert.ok(lc._heartbeatTimer, 'exactly one pending timer must remain (no leak)');

  lc.stopHeartbeatLoop();
});

test('pokeHeartbeat(): healthy node debounces to one tick per POKE_THROTTLE_MS', async () => {
  // Hub enforces 6 heartbeats / 300s per sender. If pokes are wired to
  // user activity (e.g. every inbound HTTP request), an un-throttled poke
  // would 429 the hub. Healthy nodes that have just ticked must observe
  // the debounce.
  const lc = makeManager();
  let heartbeatCalls = 0;
  lc.heartbeat = async () => { heartbeatCalls++; return { ok: true }; };

  lc.startHeartbeatLoop(30_000);
  await new Promise((r) => setTimeout(r, 30)); // first auto-tick runs
  assert.equal(heartbeatCalls, 1, 'sanity: first auto-tick fired');

  // Healthy node (no failures), recent tick -> poke must be debounced.
  const r = lc.pokeHeartbeat();
  await new Promise((r2) => setTimeout(r2, 30));

  assert.equal(r, false, 'healthy + recent tick -> poke must return false (throttled)');
  assert.equal(heartbeatCalls, 1, 'no new heartbeat must fire while throttled');

  lc.stopHeartbeatLoop();
});

test('pokeHeartbeat(): failing node ALSO respects the throttle (no fan-out)', async () => {
  // Previously, _consecutiveFailures > 0 bypassed the throttle so a
  // "stuck" node could recover immediately on any poke. That was the
  // wrong knob: IDE pollers hitting /mailbox/poll 4x/sec during a
  // failure streak would fan out into many ticks per second once each
  // tick completed fast on a 401 -- exhausting the hub's 6/300s
  // per-sender heartbeat budget and making recovery harder, not
  // easier. The throttle now applies uniformly. Recovery is still
  // bounded to ~60s via the timer-pull-in branch (tested separately).
  const lc = makeManager();
  let heartbeatCalls = 0;
  lc.heartbeat = async () => { heartbeatCalls++; return { ok: true }; };

  lc.startHeartbeatLoop(30_000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(heartbeatCalls, 1);

  lc._consecutiveFailures = 3; // simulate degraded state

  const r = lc.pokeHeartbeat();
  await new Promise((r2) => setTimeout(r2, 30));

  assert.equal(r, false, 'failing node must NOT bypass throttle (return false)');
  assert.equal(heartbeatCalls, 1, 'no extra heartbeat must fire under throttle');
  assert.equal(lc._consecutiveFailures, 0, 'state clear still happens regardless of throttle');

  lc.stopHeartbeatLoop();
});

// --------------------------------------------------------------------------
// Wall-clock drift detector (sleep/wake recovery, task #11)
// --------------------------------------------------------------------------

test('drift detector: wall-clock jump > threshold pokes heartbeat', async () => {
  // Simulates macOS sleep/wake: Date.now() advances by minutes while the
  // libuv-driven setInterval (which we fire manually here) sees only a
  // single tick. The detector must infer suspension and call pokeHeartbeat.
  const lc = makeManager();
  // Stub heartbeat so startHeartbeatLoop's initial tick is a no-op and we
  // can observe pokeHeartbeat() side effects without HTTP.
  lc.heartbeat = async () => ({ ok: true });

  // Capture the interval callback before starting so we can fire it on demand
  // with a controlled Date.now() value, instead of waiting 30s for real.
  const realSetInterval = global.setInterval;
  let driftCallback = null;
  global.setInterval = function (fn, ms, ...rest) {
    if (ms === 30_000) {
      driftCallback = fn;
      return { unref: () => {}, _captured: true };
    }
    return realSetInterval(fn, ms, ...rest);
  };

  try {
    lc.startHeartbeatLoop(30_000);
    assert.ok(driftCallback, 'drift interval must be registered with 30s period');

    // Spy on pokeHeartbeat -- we don't care about its side effects here,
    // only that the detector invokes it.
    let pokeCount = 0;
    const origPoke = lc.pokeHeartbeat.bind(lc);
    lc.pokeHeartbeat = () => { pokeCount++; return origPoke(); };

    // Simulate a 5-minute wall-clock jump (well above the 90s threshold).
    const realNow = Date.now;
    const baseline = realNow();
    lc._lastDriftCheckAt = baseline;
    Date.now = () => baseline + 5 * 60_000;
    try {
      driftCallback();
    } finally {
      Date.now = realNow;
    }

    assert.equal(pokeCount, 1, 'a >90s jump must trigger exactly one pokeHeartbeat call');
    // _lastDriftCheckAt must advance so a single jump doesn't keep poking.
    assert.ok(
      lc._lastDriftCheckAt >= baseline + 5 * 60_000,
      '_lastDriftCheckAt must be updated to the observed now',
    );
  } finally {
    lc.stopHeartbeatLoop();
    global.setInterval = realSetInterval;
  }
});

test('drift detector: small gap (<threshold) does NOT poke', async () => {
  // Sanity check: a normal 30-60s scheduling gap must not be mistaken for
  // a sleep/wake event. Otherwise the detector would fire continuously and
  // defeat POKE_THROTTLE_MS / the hub rate limit.
  const lc = makeManager();
  lc.heartbeat = async () => ({ ok: true });

  const realSetInterval = global.setInterval;
  let driftCallback = null;
  global.setInterval = function (fn, ms, ...rest) {
    if (ms === 30_000) {
      driftCallback = fn;
      return { unref: () => {}, _captured: true };
    }
    return realSetInterval(fn, ms, ...rest);
  };

  try {
    lc.startHeartbeatLoop(30_000);
    assert.ok(driftCallback);

    let pokeCount = 0;
    lc.pokeHeartbeat = () => { pokeCount++; return true; };

    // Simulate a 45s gap -- the realistic max for a normal interval tick
    // under heavy load. Must NOT trigger.
    const realNow = Date.now;
    const baseline = realNow();
    lc._lastDriftCheckAt = baseline;
    Date.now = () => baseline + 45_000;
    try {
      driftCallback();
    } finally {
      Date.now = realNow;
    }

    assert.equal(pokeCount, 0, 'a <90s gap must NOT trigger pokeHeartbeat');
  } finally {
    lc.stopHeartbeatLoop();
    global.setInterval = realSetInterval;
  }
});

test('drift detector: stopHeartbeatLoop clears the interval', () => {
  // Without cleanup, a worker that stops and restarts the loop would
  // accumulate drift intervals. The unref() also makes leaks invisible
  // (event loop still exits), so this assertion is the only guard.
  const lc = makeManager();
  lc.heartbeat = async () => ({ ok: true });

  lc.startHeartbeatLoop(30_000);
  assert.ok(lc._driftInterval, 'startHeartbeatLoop must register a drift interval');

  lc.stopHeartbeatLoop();
  assert.equal(lc._driftInterval, null, 'stopHeartbeatLoop must null out the drift interval');
});

// --------------------------------------------------------------------------
// Drift detector re-poke on persistent failures (task #14 race fix)
// --------------------------------------------------------------------------

test('drift detector: re-pokes when _consecutiveFailures>0 even with small wall-clock gap', async () => {
  // Regression for the macOS-wake race described in task #14:
  //   1. host wakes -> both setInterval (drift) and setTimeout (heartbeat
  //      tick) fire near-simultaneously
  //   2. heartbeat tick enters first, _tickInFlight=true, awaits the fetch
  //   3. drift detector's poke is a no-op (in-flight gate)
  //   4. post-wake tick fails because WiFi/DNS isn't up yet ->
  //      _consecutiveFailures=1, next tick pushed out by minutes
  //   5. next drift check 30s later sees only a 30s wall-clock gap (we've
  //      been awake the whole time) -> < 90s threshold -> no poke
  //   6. user is stuck in long backoff with network fully up
  //
  // Fix: drift detector also pokes when _consecutiveFailures > 0 and the
  // last tick was longer ago than 2 * interval. Asserts that with a small
  // wall-clock gap (<90s) the detector still pokes once we are in a
  // failing state.
  const lc = makeManager();
  lc.heartbeat = async () => ({ ok: true });

  const realSetInterval = global.setInterval;
  let driftCallback = null;
  global.setInterval = function (fn, ms, ...rest) {
    if (ms === 30_000) {
      driftCallback = fn;
      return { unref: () => {}, _captured: true };
    }
    return realSetInterval(fn, ms, ...rest);
  };

  try {
    const interval = 30_000;
    lc.startHeartbeatLoop(interval);
    assert.ok(driftCallback, 'drift interval must be registered');

    // Simulate state immediately after the post-wake tick failure:
    //   - one consecutive failure
    //   - _lastTickSuccessAt is well in the past (longer than 90s) but
    //     wall-clock gap on the drift sample itself is small (<90s).
    //   - _lastTickAttemptAt is fresh (the failing tick just ran) -- the
    //     recovery branch must not key off attempt time or it would never
    //     fire on a fast-failing node.
    const realNow = Date.now;
    const baseline = realNow();
    lc._consecutiveFailures = 1;
    lc._lastDriftCheckAt = baseline;
    lc._lastTickAttemptAt = baseline; // fresh failing attempt
    lc._lastTickSuccessAt = baseline - 5 * interval; // 150s since last success

    let pokeCount = 0;
    lc.pokeHeartbeat = () => { pokeCount++; return true; };

    // Small wall-clock jump (15s) -- below the 90s sleep threshold so the
    // existing branch must NOT fire. The new persistent-failure branch
    // must fire instead.
    Date.now = () => baseline + 15_000;
    try {
      driftCallback();
    } finally {
      Date.now = realNow;
    }

    assert.equal(
      pokeCount, 1,
      'drift detector must re-poke when failures>0 and tick is stale, even with sub-threshold wall-clock gap',
    );
  } finally {
    lc.stopHeartbeatLoop();
    global.setInterval = realSetInterval;
  }
});

test('drift detector: re-pokes when last success is stale under default 6min heartbeat interval (Bug 2 fix)', async () => {
  // Bug 2 regression: the staleness gate used `2 * interval` where
  // `interval` was the heartbeat interval (defaults to 360_000 = 6 min),
  // so the effective gate was ~12 min -- not the "~30s recovery" the
  // comment claimed. With the fix, the gate is keyed to
  // TICK_SUCCESS_STALE_MS (~90s) against _lastTickSuccessAt, independent
  // of the configured heartbeat interval.
  //
  // This test exercises the realistic production config: default 6 min
  // heartbeat interval, _lastTickSuccessAt >90s in the past. Under the
  // OLD code the staleness gate would be 12 min and the branch would NOT
  // fire. Under the NEW code the 90s gate is exceeded and the branch
  // must fire.
  const lc = makeManager();
  lc.heartbeat = async () => ({ ok: true });

  const realSetInterval = global.setInterval;
  let driftCallback = null;
  global.setInterval = function (fn, ms, ...rest) {
    if (ms === 30_000) {
      driftCallback = fn;
      return { unref: () => {}, _captured: true };
    }
    return realSetInterval(fn, ms, ...rest);
  };

  try {
    // Use the DEFAULT heartbeat interval (6 min) -- the exact config
    // where the old `2 * interval` math produced the ~12 min dead window.
    lc.startHeartbeatLoop(360_000);
    assert.ok(driftCallback, 'drift interval must be registered');

    const realNow = Date.now;
    const baseline = realNow();
    lc._consecutiveFailures = 1;
    lc._lastDriftCheckAt = baseline;
    lc._lastTickAttemptAt = baseline; // fresh failing attempt
    lc._lastTickSuccessAt = baseline - 120_000; // 120s since last success: above 90s

    let pokeCount = 0;
    lc.pokeHeartbeat = () => { pokeCount++; return true; };

    // Small wall-clock jump (15s) so the sleep/wake branch does NOT fire.
    // Only the new persistent-failure branch should trigger the poke.
    Date.now = () => baseline + 15_000;
    try {
      driftCallback();
    } finally {
      Date.now = realNow;
    }

    assert.equal(
      pokeCount, 1,
      'drift detector must re-poke at 90s staleness under the default 6min heartbeat interval',
    );
  } finally {
    lc.stopHeartbeatLoop();
    global.setInterval = realSetInterval;
  }
});

test('drift detector: healthy node with small gap does NOT poke (no false positive)', async () => {
  // Counterpart to the regression above: confirm Approach B does not turn
  // the drift detector into a constant poke source on a healthy node.
  // With _consecutiveFailures === 0 and a small wall-clock gap, neither
  // the wall-clock branch nor the persistent-failure branch must fire.
  const lc = makeManager();
  lc.heartbeat = async () => ({ ok: true });

  const realSetInterval = global.setInterval;
  let driftCallback = null;
  global.setInterval = function (fn, ms, ...rest) {
    if (ms === 30_000) {
      driftCallback = fn;
      return { unref: () => {}, _captured: true };
    }
    return realSetInterval(fn, ms, ...rest);
  };

  try {
    const interval = 30_000;
    lc.startHeartbeatLoop(interval);
    assert.ok(driftCallback);

    const realNow = Date.now;
    const baseline = realNow();
    // Healthy node: no failures. Even if _lastTickSuccessAt is "stale",
    // the consecutiveFailures===0 guard must prevent any poke -- this is
    // the only thing keeping the drift detector quiet on healthy systems.
    lc._consecutiveFailures = 0;
    lc._lastDriftCheckAt = baseline;
    lc._lastTickAttemptAt = baseline - 5 * interval;
    lc._lastTickSuccessAt = baseline - 5 * interval;

    let pokeCount = 0;
    lc.pokeHeartbeat = () => { pokeCount++; return true; };

    Date.now = () => baseline + 15_000; // small gap, well under 90s
    try {
      driftCallback();
    } finally {
      Date.now = realNow;
    }

    assert.equal(pokeCount, 0, 'healthy node + sub-threshold gap must NOT trigger pokeHeartbeat');
  } finally {
    lc.stopHeartbeatLoop();
    global.setInterval = realSetInterval;
  }
});

// --------------------------------------------------------------------------
// Reauth-backoff hot-loop protection (task #15)
//
// HTTP middleware pokes lifecycle on every authenticated request. If the
// hub has genuinely invalidated the secret (operator "Reset Secret"),
// poke must NOT keep wiping _reauthBackoffUntil -- otherwise every user
// keystroke triggers a reAuth attempt and the hub's per-IP 60/h hello
// rate limit gets exhausted in <30 minutes of typing.
// --------------------------------------------------------------------------

test('pokeHeartbeat(): respects reauth backoff after 2+ consecutive reauth failures', async () => {
  // Deep-failure state: the hub has rejected us multiple reauth attempts
  // in a row. _reauthBackoffUntil was set deliberately by reAuthenticate.
  // pokeHeartbeat must NOT wipe it -- the backoff is the only thing
  // preventing a hot loop against a genuinely-rejecting hub.
  const lc = makeManager();
  lc.heartbeat = async () => ({ ok: true });
  lc.startHeartbeatLoop(30_000);
  await new Promise((r) => setTimeout(r, 30));

  const backoffUntil = Date.now() + 30 * 60_000;
  lc._consecutiveReauthFailures = 2;
  lc._reauthBackoffUntil = backoffUntil;

  lc.pokeHeartbeat();

  assert.equal(
    lc._reauthBackoffUntil, backoffUntil,
    'reauth backoff must NOT be wiped when _consecutiveReauthFailures >= 2',
  );
  assert.equal(lc._consecutiveReauthFailures, 2, 'failure counter must be preserved');

  lc.stopHeartbeatLoop();
});

test('pokeHeartbeat(): clears reauth backoff after only 1 reauth failure', async () => {
  // Single reauth failure could be a transient hub blip. We still want
  // user activity to drive a retry, so the clear-on-poke behavior is
  // preserved for shallow failure streaks.
  const lc = makeManager();
  lc.heartbeat = async () => ({ ok: true });
  lc.startHeartbeatLoop(30_000);
  await new Promise((r) => setTimeout(r, 30));

  lc._consecutiveReauthFailures = 1;
  lc._reauthBackoffUntil = Date.now() + 30 * 60_000;

  lc.pokeHeartbeat();

  assert.equal(
    lc._reauthBackoffUntil, 0,
    'reauth backoff must be cleared on 1st failure (transient-blip retry path)',
  );

  lc.stopHeartbeatLoop();
});

test('pokeHeartbeat(): rapid pokes in deep-failure state do NOT spam reAuthenticate', async () => {
  // Hot-loop regression: pre-fix, 10 user actions in Cursor would each
  // wipe _reauthBackoffUntil, and the next tick would re-enter reAuth.
  // With the gate, the backoff stays installed, so the tick path that
  // would normally call reAuthenticate must observe the backoff and
  // short-circuit.
  const lc = makeManager();
  let reauthCalls = 0;
  lc.reAuthenticate = async () => { reauthCalls++; return false; };
  // Make heartbeat always 401 so the tick would normally call reAuth.
  // We don't actually wire that path here; we test the invariant that
  // poke can't push reAuthenticate into a hot loop by inspecting how
  // many ticks made it past the backoff gate.
  let heartbeatCalls = 0;
  lc.heartbeat = async () => {
    heartbeatCalls++;
    // Simulate a tick that would have triggered reAuth: respect the
    // installed backoff (same gate reAuthenticate uses at L312).
    if (lc._reauthBackoffUntil > Date.now()) return { ok: false, error: 'backoff_active' };
    await lc.reAuthenticate();
    return { ok: false, error: '401' };
  };

  lc.startHeartbeatLoop(30_000);
  // Wait for the first auto-tick to settle so _tick is bound.
  await new Promise((r) => setTimeout(r, 30));

  // Install deep-failure state with a fresh 30-min backoff.
  lc._consecutiveReauthFailures = 5;
  lc._reauthBackoffUntil = Date.now() + 30 * 60_000;
  const heartbeatCallsBefore = heartbeatCalls;
  const reauthCallsBefore = reauthCalls;

  // Fire 10 rapid pokes (simulating 10 user actions in Cursor).
  for (let i = 0; i < 10; i++) lc.pokeHeartbeat();
  // Drain the microtask queue + any timer the pokes might have scheduled.
  await new Promise((r) => setTimeout(r, 80));

  const newHeartbeats = heartbeatCalls - heartbeatCallsBefore;
  const newReauths = reauthCalls - reauthCallsBefore;

  // Backoff must still be intact.
  assert.ok(
    lc._reauthBackoffUntil > Date.now() + 25 * 60_000,
    `_reauthBackoffUntil must still be ~30min out, got ${lc._reauthBackoffUntil - Date.now()}ms`,
  );
  // reAuthenticate must NOT have been called 10 times. The point of the
  // fix is that the hub's per-IP hello rate limit is not exhausted by
  // user activity. 0 or 1 calls are acceptable; >= 2 would indicate the
  // fix isn't working.
  assert.ok(
    newReauths <= 1,
    `reAuthenticate must NOT be called per-poke (got ${newReauths} for 10 pokes)`,
  );
  // Heartbeat ticks themselves are bounded by the in-flight gate; we
  // assert <= 2 (one in-flight, at most one queued) as a regression on
  // the tick-storm aspect.
  assert.ok(
    newHeartbeats <= 2,
    `heartbeat ticks per 10 pokes must be bounded (got ${newHeartbeats})`,
  );

  lc.stopHeartbeatLoop();
});

// --------------------------------------------------------------------------
// Ordering invariants in pokeHeartbeat (Bug 1 follow-up to #544)
//
// All early-exit checks (running guard, in-flight gate, throttle) must
// run BEFORE any state mutation. Wiping _consecutiveFailures or
// _reauthBackoffUntil before the single-flight gate would:
//   - corrupt the failure history a mid-await tick is about to record
//   - let rapid user activity erase a fresh _reauthBackoffUntil even
//     though the in-flight gate then immediately no-ops
// --------------------------------------------------------------------------

test('pokeHeartbeat(): in-flight poke does NOT clear _consecutiveFailures before tick records its 401', async () => {
  // Repro for Bug 1: an in-flight tick that is about to fail (mid-await
  // on a hub fetch that will 401) must record its failure on top of the
  // pre-existing failure history. If poke clears state BEFORE the
  // in-flight gate, the failure counter would be reset to 0 and the
  // subsequent 401-bump would record "1" instead of (n+1), masking the
  // streak the backoff math depends on.
  const lc = makeManager();

  // Build a heartbeat() that awaits an external promise we control, then
  // bumps _consecutiveFailures (mirroring the real heartbeat() 401 path
  // at L459). This lets us hold the tick "mid-await" while we poke.
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  lc.heartbeat = async () => {
    await fetchGate; // simulate fetch in-flight
    lc._consecutiveFailures++; // simulate the 401 branch incrementing
    return { ok: false, error: 'auth_failed_401' };
  };

  lc.startHeartbeatLoop(30_000);
  // Wait one microtask so the first auto-tick has entered its await.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(lc._tickInFlight, true, 'sanity: tick must be mid-await');

  // Install a non-zero _reauthBackoffUntil to verify it is NOT wiped by
  // the in-flight poke. Use a SHALLOW failure streak so the new ordering
  // would otherwise be willing to clear it (deepReauthFailure=false) --
  // the in-flight gate is the only thing that should keep it intact.
  const backoffUntil = Date.now() + 30 * 60_000;
  lc._reauthBackoffUntil = backoffUntil;
  lc._consecutiveReauthFailures = 1;

  // Poke while the tick is in flight.
  const r = lc.pokeHeartbeat();
  assert.equal(r, true, 'in-flight poke must return true (the running tick is the proof)');
  assert.equal(
    lc._reauthBackoffUntil, backoffUntil,
    'in-flight poke must NOT wipe _reauthBackoffUntil (state mutation must follow the in-flight gate)',
  );

  // Now release the fetch so the tick can finish and record its 401.
  releaseFetch();
  await new Promise((r2) => setTimeout(r2, 30));

  assert.equal(
    lc._consecutiveFailures, 1,
    'after in-flight tick records its 401, _consecutiveFailures must be 1 (not 0 from a premature poke clear)',
  );

  lc.stopHeartbeatLoop();
});

test('pokeHeartbeat(): deep-failure node still respects POKE_THROTTLE_MS', async () => {
  // Pairs with the previous test. When _consecutiveReauthFailures >= 2,
  // not only must we keep the backoff, we must also not bypass the
  // POKE_THROTTLE_MS debounce -- otherwise a deep-failure node would
  // still fire a tick on every keystroke (even if reAuth itself is
  // gated, the tick storm wastes CPU and clobbers _lastTickAttemptAt).
  const lc = makeManager();
  let heartbeatCalls = 0;
  lc.heartbeat = async () => { heartbeatCalls++; return { ok: true }; };

  lc.startHeartbeatLoop(30_000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(heartbeatCalls, 1, 'sanity: first auto-tick fired');

  // Deep-failure state with active backoff.
  lc._consecutiveReauthFailures = 3;
  lc._reauthBackoffUntil = Date.now() + 30 * 60_000;

  const r = lc.pokeHeartbeat();
  await new Promise((r2) => setTimeout(r2, 30));

  // Throttle must apply -- the recent _lastTickAttemptAt blocks a new tick.
  assert.equal(
    r, false,
    'deep-failure poke must respect POKE_THROTTLE_MS (got true == bypass)',
  );
  assert.equal(heartbeatCalls, 1, 'no extra heartbeat must fire under throttle');

  lc.stopHeartbeatLoop();
});

// --------------------------------------------------------------------------
// Hung-fetch watchdog + last-success-vs-attempt timestamp (Bug A + Bug B)
//
// Bug A: if a fetch hangs past its AbortSignal (TLS-level hang, custom
// transport ignoring abort), _tickInFlight stays true forever and every
// subsequent pokeHeartbeat() early-returns. The watchdog must force-reset
// the in-flight flag and let the next poke proceed.
//
// Bug B: the drift-detector recovery branch keyed off _lastTickAt
// (attempt time). On a node failing every 30s the attempt timestamp is
// always fresh and the branch never fires. Splitting attempt vs success
// time fixes the gate.
// --------------------------------------------------------------------------

test('pokeHeartbeat(): rescues a hung in-flight tick past the watchdog threshold', async () => {
  // Simulate a stuck fetch: _tickInFlight true, _tickStartedAt > 60s ago.
  // Without the rescue, the poke would early-return at the in-flight gate
  // and the loop would be permanently dead. With the rescue, the flag
  // must be force-reset and a fresh tick scheduled.
  const lc = makeManager();
  let heartbeatCalls = 0;
  lc.heartbeat = async () => { heartbeatCalls++; return { ok: true }; };

  lc.startHeartbeatLoop(30_000);
  // Let the first auto-tick settle so the loop is bound.
  await new Promise((r) => setTimeout(r, 30));
  const heartbeatCallsBefore = heartbeatCalls;

  // Synthesize the wedge. The rescue path inside pokeHeartbeat() detects
  // the hung tick (held > TICK_HUNG_THRESHOLD_MS) and bypasses the
  // throttle on the immediate re-tick, since the rescue itself proves we
  // waited past the throttle window. No need for any wasFailing bypass.
  lc._tickInFlight = true;
  lc._tickStartedAt = Date.now() - 61_000;

  const ok = lc.pokeHeartbeat();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(ok, true, 'rescued poke must report a scheduled tick');
  assert.equal(lc._tickInFlight, false, 'hung in-flight flag must be force-reset (post-tick)');
  assert.equal(lc._tickStartedAt, null, '_tickStartedAt must be cleared on rescue (post-tick)');
  assert.ok(
    heartbeatCalls > heartbeatCallsBefore,
    `a fresh heartbeat must fire after rescue (before=${heartbeatCallsBefore}, after=${heartbeatCalls})`,
  );

  lc.stopHeartbeatLoop();
});

test('_lastTickSuccessAt: not updated on failing tick, updated on succeeding tick', async () => {
  // Failing path: heartbeat returns {ok:false}. _lastTickSuccessAt must
  // stay null. Success path: heartbeat returns {ok:true}. The field must
  // be populated. This is the load-bearing invariant for the drift
  // detector's recovery branch.
  const lc = makeManager();
  let outcome = { ok: false, error: 'synthetic' };
  lc.heartbeat = async () => outcome;

  lc.startHeartbeatLoop(30_000);
  // First auto-tick: failing.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(
    lc._lastTickSuccessAt, null,
    '_lastTickSuccessAt must NOT be set when the tick returned {ok:false}',
  );
  assert.ok(
    lc._lastTickAttemptAt > 0,
    '_lastTickAttemptAt must be set even on failing ticks',
  );

  // Flip to success and poke a fresh tick. Push _lastTickAttemptAt past
  // the throttle window so the poke can fire immediately (the
  // wasFailing bypass no longer exists; failing nodes also obey the
  // throttle, and tests for that path live elsewhere).
  outcome = { ok: true };
  lc._lastTickAttemptAt = 0;
  lc.pokeHeartbeat();
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(
    lc._lastTickSuccessAt && lc._lastTickSuccessAt > 0,
    `_lastTickSuccessAt must be populated after a {ok:true} tick (got ${lc._lastTickSuccessAt})`,
  );

  lc.stopHeartbeatLoop();
});

test('drift detector: recovery branch uses _lastTickSuccessAt, not _lastTickAttemptAt', async () => {
  // Repro for Bug B: a node failing every 30s keeps _lastTickAttemptAt
  // fresh, so the old "now - _lastTickAt > 60s" gate never fired. With
  // the fix, the gate keys off _lastTickSuccessAt: if no success in 90s
  // (and we are in a failing state) the branch must poke.
  const lc = makeManager();
  lc.heartbeat = async () => ({ ok: false, error: 'still_failing' });

  const realSetInterval = global.setInterval;
  let driftCallback = null;
  global.setInterval = function (fn, ms, ...rest) {
    if (ms === 30_000) {
      driftCallback = fn;
      return { unref: () => {}, _captured: true };
    }
    return realSetInterval(fn, ms, ...rest);
  };

  try {
    lc.startHeartbeatLoop(30_000);
    assert.ok(driftCallback, 'drift interval must be registered');

    const realNow = Date.now;
    const baseline = realNow();
    // Node failing every 30s for a while: attempt timestamp is fresh,
    // success timestamp is stale (>90s ago). _consecutiveFailures > 0.
    lc._consecutiveFailures = 4;
    lc._lastDriftCheckAt = baseline;
    lc._lastTickAttemptAt = baseline; // fresh attempt
    lc._lastTickSuccessAt = baseline - 120_000; // 120s since last success

    let pokeCount = 0;
    lc.pokeHeartbeat = () => { pokeCount++; return true; };

    // Small wall-clock gap so the sleep/wake branch does NOT fire.
    Date.now = () => baseline + 15_000;
    try {
      driftCallback();
    } finally {
      Date.now = realNow;
    }

    assert.equal(
      pokeCount, 1,
      'recovery branch must fire when _lastTickSuccessAt is stale even though _lastTickAttemptAt is fresh',
    );
  } finally {
    lc.stopHeartbeatLoop();
    global.setInterval = realSetInterval;
  }
});

// --------------------------------------------------------------------------
// Generation counter: a hung-fetch rescue must NOT spawn parallel loops
//
// Pre-fix, the rescue cleared _tickInFlight while the zombie original tick
// was still awaiting the hung fetch. When that fetch eventually resolved,
// the zombie's finally would (a) write _tickInFlight=false (already false),
// (b) schedule its OWN setTimeout for the next tick. Combined with the
// rescuer's already-scheduled replacement, you got two concurrent _tick
// invocations, each writing _heartbeatTimer / _consecutiveFailures, with
// the earlier setTimeout reference leaking but still firing.
// --------------------------------------------------------------------------

test('rescue chain: back-to-back rescues bump _tickGeneration monotonically and never leak parallel timers', async () => {
  // Single-rescue is tested below; this verifies the COMPOUND case where
  // two ticks hang in succession. The audit flagged this as untested. If
  // _tickGeneration bump or _heartbeatTimer reset is off in any sequence,
  // the second rescue could either (a) leave the first rescue's replacement
  // tick orphaned (parallel ticks) or (b) skip the generation bump and
  // let the zombie corrupt state on resolve.
  const lc = makeManager();

  const gates = [];
  let heartbeatCalls = 0;
  lc.heartbeat = async () => {
    heartbeatCalls++;
    if (heartbeatCalls <= 2) {
      // First two ticks hang past the threshold until released.
      const release = new Promise((resolve) => { gates.push(resolve); });
      await release;
      return { ok: true };
    }
    return { ok: true };
  };

  lc.startHeartbeatLoop(30_000);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(lc._tickInFlight, true);
  const gen0 = lc._tickGeneration;

  // First rescue: hang the first tick past the threshold.
  lc._tickStartedAt = Date.now() - 61_000;
  lc.pokeHeartbeat();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(lc._tickGeneration > gen0, 'first rescue must bump generation');
  const gen1 = lc._tickGeneration;
  // The replacement tick has entered heartbeat() (heartbeatCalls=2) and
  // is awaiting its gate.
  assert.equal(heartbeatCalls, 2, 'rescue must have started the second tick');
  assert.equal(lc._tickInFlight, true, 'replacement tick must be in flight');

  // Second rescue: hang the SECOND tick (the rescuer's replacement) past
  // the threshold too.
  lc._tickStartedAt = Date.now() - 61_000;
  lc.pokeHeartbeat();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(lc._tickGeneration > gen1, 'second rescue must bump generation again');
  // The chain can bump generation more than once per rescue: _rescueHungTick
  // bumps once, then the replacement _tick body bumps again on entry
  // (myGen = ++_tickGeneration). What matters is monotonic increase and
  // that no zombie ever writes _heartbeatTimer (asserted below).

  // Now release BOTH zombies. Their finally blocks must see generation
  // mismatch and bail.
  const timerAfter = lc._heartbeatTimer;
  for (const release of gates) release();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(
    lc._heartbeatTimer, timerAfter,
    'neither zombie must overwrite _heartbeatTimer across the rescue chain',
  );

  lc.stopHeartbeatLoop();
});

test('rescue + zombie tick: zombie must NOT schedule a duplicate timer after generation bump', async () => {
  const lc = makeManager();

  // Manually drive _tick so we control the await point and can release the
  // hung fetch after the rescue has run.
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  let heartbeatCalls = 0;
  lc.heartbeat = async () => {
    heartbeatCalls++;
    if (heartbeatCalls === 1) {
      // First call is the zombie -- hang past the watchdog threshold.
      await fetchGate;
      return { ok: true };
    }
    // Subsequent calls (the rescued replacement) return fast.
    return { ok: true };
  };

  lc.startHeartbeatLoop(30_000);
  // Wait one microtask so the first auto-tick has entered its await.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(lc._tickInFlight, true, 'sanity: first tick is mid-await');
  const genBefore = lc._tickGeneration;

  // Synthesize a hung tick: rewind _tickStartedAt past the threshold.
  lc._tickStartedAt = Date.now() - 61_000;

  // Rescue path inside pokeHeartbeat fires the replacement.
  lc.pokeHeartbeat();
  // Let the replacement tick run.
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(
    lc._tickGeneration > genBefore,
    `_tickGeneration must be bumped on rescue (before=${genBefore}, after=${lc._tickGeneration})`,
  );
  const timerAfterRescue = lc._heartbeatTimer;
  const consecutiveAfterRescue = lc._consecutiveFailures;

  // Now release the zombie's hung fetch. It will fall into its finally,
  // see generation mismatch, and bail. _heartbeatTimer and
  // _consecutiveFailures must NOT change as a result of the zombie's
  // post-resolution code path.
  releaseFetch();
  await new Promise((r) => setTimeout(r, 30));

  assert.strictEqual(
    lc._heartbeatTimer, timerAfterRescue,
    'zombie tick must NOT overwrite _heartbeatTimer (would leak the rescued replacement timer)',
  );
  assert.equal(
    lc._consecutiveFailures, consecutiveAfterRescue,
    'zombie tick must NOT touch _consecutiveFailures',
  );

  lc.stopHeartbeatLoop();
});

// --------------------------------------------------------------------------
// _reauthInProgress guard: pokeHeartbeat must observe an active reauth
// as liveness work and NOT fire a parallel tick that would collide.
//
// SyncEngine.onAuthError -> lifecycle.reAuthenticate() runs WITHOUT the
// _tickInFlight slot held (no heartbeat tick is involved). If poke fires
// a fresh tick during that window, heartbeat() calls reAuthenticate
// which sees _reauthInProgress=true and returns false -- a spurious
// failure that bumps _consecutiveFailures while the original reauth is
// still genuinely running.
// --------------------------------------------------------------------------

test('pokeHeartbeat(): does NOT fire a parallel tick while reAuthenticate is in progress', async () => {
  const lc = makeManager();
  let heartbeatCalls = 0;
  lc.heartbeat = async () => { heartbeatCalls++; return { ok: true }; };

  lc.startHeartbeatLoop(30_000);
  await new Promise((r) => setTimeout(r, 30));
  const heartbeatCallsBefore = heartbeatCalls;

  // Simulate the SyncEngine.onAuthError path: reauth in progress, no
  // tick mid-flight (loop has been quiet since startup).
  lc._reauthInProgress = true;
  // Push _lastTickAttemptAt past the throttle window so the only thing
  // gating the poke is the reauth guard.
  lc._lastTickAttemptAt = 0;

  const ok = lc.pokeHeartbeat();

  assert.equal(ok, true, 'poke must report success (active reauth IS liveness)');
  assert.equal(
    heartbeatCalls, heartbeatCallsBefore,
    'no parallel heartbeat tick must fire during active reauth',
  );

  lc._reauthInProgress = false;
  lc.stopHeartbeatLoop();
});

// --------------------------------------------------------------------------
// Regression: drift detector callback must contain any throw locally.
//
// Without an outer try/catch on the setInterval body, a throw from
// logger.warn (file handle exhausted, transport adapter bug) or any other
// dependency would escape the callback and route to process.on(
// 'uncaughtException'). Many production daemons install a self-killing
// handler there, so a trivial log failure could take the entire process
// down. The detector now swallows the throw, logs it, and keeps running.
// --------------------------------------------------------------------------

test('drift detector: throw from logger.warn does NOT escape the setInterval callback', async () => {
  const lc = makeManager();
  lc.heartbeat = async () => ({ ok: true });

  const realSetInterval = global.setInterval;
  let driftCallback = null;
  global.setInterval = function (fn, ms, ...rest) {
    if (ms === 30_000) {
      driftCallback = fn;
      return { unref: () => {}, _captured: true };
    }
    return realSetInterval(fn, ms, ...rest);
  };

  try {
    lc.startHeartbeatLoop(30_000);
    assert.ok(driftCallback);

    // Replace the logger with one that throws on every call. The detector
    // logs once on the wall-clock-jump branch and once on the recovery
    // branch -- both sit inside the outer try/catch.
    lc.logger = {
      warn: () => { throw new Error('synthetic logger failure'); },
      log: () => {},
      error: () => {},
    };

    // Trigger the wall-clock-jump branch.
    const realNow = Date.now;
    const baseline = realNow();
    lc._lastDriftCheckAt = baseline;
    Date.now = () => baseline + 5 * 60_000;

    let escaped = false;
    try {
      driftCallback();
    } catch (_) {
      escaped = true;
    } finally {
      Date.now = realNow;
    }

    assert.equal(
      escaped, false,
      'a throw from inside the drift callback must be swallowed by the outer guard',
    );
  } finally {
    lc.stopHeartbeatLoop();
    global.setInterval = realSetInterval;
  }
});

// --------------------------------------------------------------------------
// BUG-1: zombie tick state pollution via heartbeat()
//
// Pre-fix the _tickGeneration generation check at _tick's finally only
// stopped the zombie from RESCHEDULING. The body of heartbeat() itself ran
// every post-await mutation when its hung fetch eventually resolved:
//   - _consecutiveFailures++ on stale 401/!ok
//   - reAuthenticate() on stale 401
//   - _consecutiveFailures = 0 on stale 200 (masking the replacement
//     tick's real failures)
//   - last_heartbeat_at write with stale timestamp
//   - writeInboundBatch with stale events
//   - proxy_upgrade_required emit from stale state
//
// Fix layers:
//   1. _tick creates a fresh AbortController per tick stored on
//      this._inflightAbortController; _rescueHungTick aborts it.
//   2. heartbeat() snapshots _tickGeneration on entry and re-checks
//      before EVERY mutation after the hubFetch await; returns null on
//      mismatch without touching state.
// --------------------------------------------------------------------------

function _makeDeferredFetch() {
  // Builds a fetch stub that returns a promise we control. The test can
  // capture and resolve/reject the inner promise after triggering the
  // watchdog, simulating "fetch finally returned after the rescue".
  let resolveOuter;
  const gate = new Promise((resolve) => { resolveOuter = resolve; });
  const fetchImpl = async (_url, _opts) => gate;
  return { fetchImpl, resolveOuter: (...args) => resolveOuter(...args) };
}

test('BUG-1: rescued zombie tick does NOT increment _consecutiveFailures via stale 401', async () => {
  const lc = makeManager();
  const { fetchImpl, resolveOuter } = _makeDeferredFetch();
  const restore = installFetchStub(fetchImpl);

  try {
    lc.startHeartbeatLoop(30_000);
    // Wait for the first tick to enter its hubFetch await.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(lc._tickInFlight, true, 'sanity: first tick mid-await');
    assert.ok(lc._inflightAbortController, 'sanity: per-tick controller set');
    const controller = lc._inflightAbortController;

    // Synthesize hang past the threshold and rescue.
    lc._tickStartedAt = Date.now() - 61_000;
    const rescued = lc._rescueHungTick('test', Date.now());
    assert.equal(rescued, true, 'sanity: rescue fired');
    assert.equal(controller.signal.aborted, true, 'controller must be aborted by rescue');

    const failuresAfterRescue = lc._consecutiveFailures;

    // Now resolve the hung fetch with a stale 401. The zombie's resumed
    // heartbeat() must NOT bump _consecutiveFailures.
    resolveOuter({
      ok: false, status: 401,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => 'stale auth error',
    });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(
      lc._consecutiveFailures, failuresAfterRescue,
      'zombie tick must NOT bump _consecutiveFailures on stale 401',
    );
  } finally {
    lc.stopHeartbeatLoop();
    restore();
  }
});

test('BUG-1: rescued zombie tick does NOT call reAuthenticate', async () => {
  const lc = makeManager();
  let reauthCalls = 0;
  lc.reAuthenticate = async () => { reauthCalls++; return true; };

  const { fetchImpl, resolveOuter } = _makeDeferredFetch();
  const restore = installFetchStub(fetchImpl);

  try {
    lc.startHeartbeatLoop(30_000);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(lc._tickInFlight, true);

    lc._tickStartedAt = Date.now() - 61_000;
    lc._rescueHungTick('test', Date.now());

    resolveOuter({
      ok: false, status: 401,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => '',
    });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(reauthCalls, 0, 'zombie tick must NOT call reAuthenticate on stale 401');
  } finally {
    lc.stopHeartbeatLoop();
    restore();
  }
});

test('BUG-1: rescued zombie tick does NOT write last_heartbeat_at on stale 200', async () => {
  const store = makeStore();
  const setStateCalls = [];
  const realSetState = store.setState;
  store.setState = (k, v) => { setStateCalls.push({ k, v }); return realSetState(k, v); };

  const lc = makeManager({ store });
  const { fetchImpl, resolveOuter } = _makeDeferredFetch();
  const restore = installFetchStub(fetchImpl);

  try {
    lc.startHeartbeatLoop(30_000);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(lc._tickInFlight, true);

    lc._tickStartedAt = Date.now() - 61_000;
    lc._rescueHungTick('test', Date.now());

    // Stale success response.
    resolveOuter({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ status: 'ok' }),
      text: async () => '',
    });
    await new Promise((r) => setTimeout(r, 30));

    const lastHbWrites = setStateCalls.filter((c) => c.k === 'last_heartbeat_at');
    assert.equal(
      lastHbWrites.length, 0,
      'zombie tick must NOT write last_heartbeat_at on stale 200',
    );
  } finally {
    lc.stopHeartbeatLoop();
    restore();
  }
});

// --------------------------------------------------------------------------
// BUG-2 Claim A: reauth watchdog
//
// Pre-fix, _reauthInProgress was cleared only in reAuthenticate's finally.
// If the inner hello()/heartbeat() returned a promise that never settled
// (TLS-level hang where AbortSignal is ignored), the finally never ran and
// _reauthInProgress stayed true forever. Every subsequent pokeHeartbeat()
// early-returned at the reauth-in-progress gate doing zero work -- exact
// "I keep clicking but nothing happens" symptom.
//
// Fix: REAUTH_HUNG_THRESHOLD_MS (60s) watchdog races the inner state
// machine. When it fires, the finally clears _reauthInProgress and the
// next poke can drive recovery.
// --------------------------------------------------------------------------

test('BUG-2: reauth that never resolves does NOT permanently latch _reauthInProgress', async () => {
  const lc = makeManager();
  // hello() returns a never-resolving promise -- simulates TLS hang that
  // ignores AbortSignal. Pre-fix the await on this would never return and
  // the finally clearing _reauthInProgress would never run.
  lc.hello = () => new Promise(() => {});

  // Shorten the watchdog window via setTimeout patching so the test
  // doesn't block for 60s. We only intercept the FIRST setTimeout call
  // with the production threshold delay (REAUTH_HUNG_THRESHOLD_MS=60000)
  // and replace it with 50ms, so the watchdog fires inside the test.
  const realSetTimeout = global.setTimeout;
  let intercepted = false;
  global.setTimeout = function (fn, ms, ...rest) {
    if (!intercepted && ms === 60_000) {
      intercepted = true;
      return realSetTimeout(fn, 50, ...rest);
    }
    return realSetTimeout(fn, ms, ...rest);
  };

  try {
    const reauthPromise = lc.reAuthenticate();
    // Sanity: latch is held while we wait.
    assert.equal(lc._reauthInProgress, true, 'sanity: latch held during await');

    const result = await reauthPromise;

    assert.equal(intercepted, true, 'sanity: watchdog setTimeout call was intercepted');
    assert.equal(
      lc._reauthInProgress, false,
      'reauth watchdog must clear _reauthInProgress even when inner promise never settles',
    );
    assert.equal(result, false, 'watchdog-timed-out reauth must return false');
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test('BUG-2: after reauth watchdog fires, pokeHeartbeat is no longer a no-op', async () => {
  const lc = makeManager();
  lc.hello = () => new Promise(() => {});

  const realSetTimeout = global.setTimeout;
  let intercepted = false;
  global.setTimeout = function (fn, ms, ...rest) {
    if (!intercepted && ms === 60_000) {
      intercepted = true;
      return realSetTimeout(fn, 50, ...rest);
    }
    return realSetTimeout(fn, ms, ...rest);
  };

  try {
    // Wait for reauth to time out via the watchdog.
    await lc.reAuthenticate();
    assert.equal(lc._reauthInProgress, false, 'sanity: watchdog cleared the latch');

    // Now start the heartbeat loop and confirm a poke actually does work
    // (clears _consecutiveFailures). Pre-fix the reauth-in-progress gate
    // would early-return true and the state-clear below would never run.
    let heartbeatCalls = 0;
    lc.heartbeat = async () => { heartbeatCalls++; return { ok: true }; };
    lc.startHeartbeatLoop(30_000);
    await new Promise((r) => realSetTimeout(r, 20));
    // Install a non-zero failure counter -- the poke's state-clear path
    // must reset it (proof that the reauth-in-progress gate is no longer
    // short-circuiting the work).
    lc._consecutiveFailures = 5;
    // Push attempt timestamp past the throttle so the poke proceeds.
    lc._lastTickAttemptAt = 0;
    lc.pokeHeartbeat();

    assert.equal(
      lc._consecutiveFailures, 0,
      'pokeHeartbeat must perform its state-clear work after the watchdog released the latch',
    );

    lc.stopHeartbeatLoop();
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test('BUG-1: rescued zombie tick does NOT writeInboundBatch stale events', async () => {
  const store = makeStore();
  let batchCalls = 0;
  store.writeInboundBatch = () => { batchCalls++; };

  const lc = makeManager({ store });
  const { fetchImpl, resolveOuter } = _makeDeferredFetch();
  const restore = installFetchStub(fetchImpl);

  try {
    lc.startHeartbeatLoop(30_000);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(lc._tickInFlight, true);

    lc._tickStartedAt = Date.now() - 61_000;
    lc._rescueHungTick('test', Date.now());

    // Stale success with events payload that would otherwise be batched in.
    resolveOuter({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({
        status: 'ok',
        events: [
          { type: 'stale_a', payload: { v: 1 } },
          { type: 'stale_b', payload: { v: 2 } },
        ],
      }),
      text: async () => '',
    });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(
      batchCalls, 0,
      'zombie tick must NOT writeInboundBatch on stale events payload',
    );
  } finally {
    lc.stopHeartbeatLoop();
    restore();
  }
});
