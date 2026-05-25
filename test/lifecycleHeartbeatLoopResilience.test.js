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
  // Set "failing" state so throttle is bypassed -- we want pokes to TRY
  // to fire so the in-flight gate is what's being tested, not the throttle.
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

test('pokeHeartbeat(): failing node bypasses the throttle so recovery is unblocked', async () => {
  // Mirror of the previous test: when _consecutiveFailures > 0 (or reauth
  // backoff is active), throttle MUST be bypassed -- otherwise a stuck
  // node could never use poke to recover.
  const lc = makeManager();
  let heartbeatCalls = 0;
  lc.heartbeat = async () => { heartbeatCalls++; return { ok: true }; };

  lc.startHeartbeatLoop(30_000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(heartbeatCalls, 1);

  lc._consecutiveFailures = 3; // simulate degraded state

  const r = lc.pokeHeartbeat();
  await new Promise((r2) => setTimeout(r2, 30));

  assert.equal(r, true, 'failing node must bypass throttle (return true)');
  assert.equal(heartbeatCalls, 2, 'a recovery heartbeat must fire');

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
    //   - _lastTickAt is well in the past (longer than 2 * interval) but
    //     wall-clock gap on the drift sample itself is small (<90s).
    const realNow = Date.now;
    const baseline = realNow();
    lc._consecutiveFailures = 1;
    lc._lastDriftCheckAt = baseline;
    lc._lastTickAt = baseline - 5 * interval; // 150s since last tick

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
    // Healthy node: no failures. Even if _lastTickAt is "stale" by the
    // 2*interval rule, the consecutiveFailures===0 guard must prevent
    // any poke -- this is the only thing keeping the drift detector
    // quiet on healthy systems.
    lc._consecutiveFailures = 0;
    lc._lastDriftCheckAt = baseline;
    lc._lastTickAt = baseline - 5 * interval;

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

test('pokeHeartbeat(): deep-failure node still respects POKE_THROTTLE_MS', async () => {
  // Pairs with the previous test. When _consecutiveReauthFailures >= 2,
  // not only must we keep the backoff, we must also not bypass the
  // POKE_THROTTLE_MS debounce -- otherwise a deep-failure node would
  // still fire a tick on every keystroke (even if reAuth itself is
  // gated, the tick storm wastes CPU and clobbers _lastTickAt).
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

  // Throttle must apply -- the recent _lastTickAt blocks a new tick.
  assert.equal(
    r, false,
    'deep-failure poke must respect POKE_THROTTLE_MS (got true == bypass)',
  );
  assert.equal(heartbeatCalls, 1, 'no extra heartbeat must fire under throttle');

  lc.stopHeartbeatLoop();
});
