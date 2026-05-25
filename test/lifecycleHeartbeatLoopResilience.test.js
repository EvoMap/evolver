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
