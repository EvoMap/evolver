'use strict';

// Regression tests for the #544 follow-up: src/proxy/sync/engine.js had the
// EXACT same loop-killer bug class as lifecycle/manager.js. In both
// _scheduleOutbound and _scheduleInbound, the recursive _schedule* call
// lived AFTER the try/catch, and store.countPending() ran outside the try.
// A sqlite EBUSY from countPending, or a rejection from the awaited
// _handleAuthError call inside catch, would escape and skip the
// reschedule -- the outbound/inbound sync loop dies until daemon restart.

const test = require('node:test');
const assert = require('node:assert');

const { SyncEngine, DEFAULT_OUTBOUND_INTERVAL } = require('../src/proxy/sync/engine');
const { AuthError } = require('../src/proxy/lifecycle/manager');

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

function makeStore({ countPending } = {}) {
  return {
    countPending: countPending || (() => 0),
  };
}

function makeEngine({ store, onAuthError } = {}) {
  return new SyncEngine({
    store: store || makeStore(),
    hubUrl: 'https://example.test',
    getHeaders: () => ({}),
    logger: silentLogger(),
    onAuthError: onAuthError || null,
  });
}

// Shared setTimeout stub for the loop-survival tests. Each test installs
// its own restore() and tears it down in finally. The stub recognises the
// engine's reschedule callbacks (their toString contains '_scheduleOutbound'
// or '_scheduleInbound') and fires them on a 0-ms real timer so the chain
// runs to completion in microtasks. After TARGET successive reschedules,
// the stub returns a fake no-op timer to stop the chain.
function installRescheduleStub({ matcher, target }) {
  const realSetTimeout = global.setTimeout;
  let count = 0;
  global.setTimeout = function (fn, ms, ...rest) {
    try {
      const src = fn && fn.toString ? fn.toString() : '';
      if (matcher(src)) {
        count++;
        if (count < target) {
          return realSetTimeout(fn, 0, ...rest);
        }
        return { unref: () => {} };
      }
    } catch { /* noop */ }
    return realSetTimeout(fn, ms, ...rest);
  };
  return {
    restore: () => { global.setTimeout = realSetTimeout; },
    get count() { return count; },
    realSetTimeout,
  };
}

// --------------------------------------------------------------------------
// _scheduleOutbound

test('_scheduleOutbound: countPending throwing must NOT kill the loop', async () => {
  // Pre-fix: countPending() lived outside the try block; a sqlite lock
  // or disk-IO throw escaped the closure and the trailing
  // _scheduleOutbound(nextDelay) was never called -> outbound dead.
  // The loop-killer regression manifests as "stops rescheduling at tick
  // N>=2"; we assert >=5 successive ticks so an implementation that
  // reschedules once and dies cannot accidentally pass.
  const store = makeStore({
    countPending: () => { throw new Error('simulated sqlite EBUSY'); },
  });
  const engine = makeEngine({ store });
  // Replace outbound.flush so we don't try to actually talk to a hub.
  let flushCalls = 0;
  engine.outbound = { flush: async () => { flushCalls++; return { sent: 0 }; } };

  const TARGET = 6;
  const stub = installRescheduleStub({
    matcher: (src) => src.includes('_scheduleOutbound'),
    target: TARGET,
  });

  try {
    engine._running = true;
    engine._scheduleOutbound(0);
    await new Promise((r) => stub.realSetTimeout(r, 200));

    // Off-by-one: the stub no-ops on the Nth schedule call, so flush
    // runs (N-1) times. TARGET=6 -> expect flush >=5.
    assert.ok(
      flushCalls >= TARGET - 1,
      `expected >= ${TARGET - 1} flush calls across the chain, got ${flushCalls}`,
    );
    assert.ok(
      stub.count >= TARGET - 1,
      `expected >= ${TARGET - 1} successive _scheduleOutbound reschedules, got ${stub.count}`,
    );
  } finally {
    engine.stop();
    stub.restore();
  }
});

test('_scheduleOutbound: AuthError + _handleAuthError rejecting must NOT kill the loop', async () => {
  // Pre-fix: the `await this._handleAuthError('outbound')` call inside
  // catch could itself reject (onAuthError callback throwing); the
  // rejection escaped the catch and skipped the reschedule.
  const store = makeStore();
  const engine = makeEngine({
    store,
    onAuthError: async () => { throw new Error('reauth pipeline blew up'); },
  });
  let flushCalls = 0;
  engine.outbound = {
    flush: async () => { flushCalls++; throw new AuthError('401', 401); },
  };

  // The existing _handleAuthError wraps the onAuthError callback in
  // try/catch so its callback rejection is already absorbed. Override
  // _handleAuthError itself to reject so we exercise the outer-reject
  // hole the caller would face if a future refactor removed that wrap.
  engine._handleAuthError = async () => { throw new Error('handleAuthError rejected'); };

  const TARGET = 6;
  const stub = installRescheduleStub({
    matcher: (src) => src.includes('_scheduleOutbound'),
    target: TARGET,
  });

  try {
    engine._running = true;
    engine._scheduleOutbound(0);
    await new Promise((r) => stub.realSetTimeout(r, 200));

    assert.ok(
      flushCalls >= TARGET - 1,
      `expected >= ${TARGET - 1} flush calls across the chain, got ${flushCalls}`,
    );
    assert.ok(
      stub.count >= TARGET - 1,
      `expected >= ${TARGET - 1} successive reschedules under AuthError+reject, got ${stub.count}`,
    );
  } finally {
    engine.stop();
    stub.restore();
  }
});

// --------------------------------------------------------------------------
// _scheduleInbound

test('_scheduleInbound: store/inbound error path must NOT kill the loop', async () => {
  // Mirror of the outbound countPending test. The inbound loop computes
  // nextDelay from _isIdle() (not countPending) but the same invariant
  // applies: if anything between catch and _scheduleInbound throws, the
  // loop dies. Stress every escape path the catch has: a non-Auth error
  // out of inbound.ackDelivered AND a logger.error that throws on every
  // call (defense-in-depth path).
  const engine = makeEngine();
  let pullCalls = 0;
  engine.inbound = {
    pull: async () => { pullCalls++; return { received: 0 }; },
    ackDelivered: async () => { throw new Error('simulated ack failure'); },
  };
  // Logger that throws on .warn/.error (the methods reachable inside the
  // tick body) but is silent on .log so engine.stop() during teardown does
  // not itself throw and prevent the stub from being restored cleanly.
  engine.logger = {
    log: () => {},
    warn: () => { throw new Error('logger died'); },
    error: () => { throw new Error('logger died'); },
  };

  const TARGET = 6;
  const stub = installRescheduleStub({
    matcher: (src) => src.includes('_scheduleInbound'),
    target: TARGET,
  });

  try {
    engine._running = true;
    engine._scheduleInbound(0);
    await new Promise((r) => stub.realSetTimeout(r, 200));

    assert.ok(
      pullCalls >= TARGET - 1,
      `expected >= ${TARGET - 1} pull calls across the chain, got ${pullCalls}`,
    );
    assert.ok(
      stub.count >= TARGET - 1,
      `expected >= ${TARGET - 1} successive _scheduleInbound reschedules, got ${stub.count}`,
    );
  } finally {
    engine.stop();
    stub.restore();
  }
});

test('_scheduleInbound: AuthError + _handleAuthError rejecting must NOT kill the loop', async () => {
  const engine = makeEngine({
    onAuthError: async () => { throw new Error('reauth pipeline blew up'); },
  });
  let pullCalls = 0;
  engine.inbound = {
    pull: async () => { pullCalls++; throw new AuthError('401', 401); },
    ackDelivered: async () => {},
  };
  engine._handleAuthError = async () => { throw new Error('handleAuthError rejected'); };

  const TARGET = 6;
  const stub = installRescheduleStub({
    matcher: (src) => src.includes('_scheduleInbound'),
    target: TARGET,
  });

  try {
    engine._running = true;
    engine._scheduleInbound(0);
    await new Promise((r) => stub.realSetTimeout(r, 200));

    assert.ok(
      pullCalls >= TARGET - 1,
      `expected >= ${TARGET - 1} pull calls across the chain, got ${pullCalls}`,
    );
    assert.ok(
      stub.count >= TARGET - 1,
      `expected >= ${TARGET - 1} successive reschedules under AuthError+reject, got ${stub.count}`,
    );
  } finally {
    engine.stop();
    stub.restore();
  }
});

// --------------------------------------------------------------------------
// Sanity: happy-path reschedule still uses the expected delay

test('_scheduleOutbound: happy path schedules at DEFAULT_OUTBOUND_INTERVAL when no pending', async () => {
  const engine = makeEngine({ store: makeStore({ countPending: () => 0 }) });
  engine.outbound = { flush: async () => ({ sent: 0 }) };

  let observedDelay = null;
  const realSetTimeout = global.setTimeout;
  let callIdx = 0;
  global.setTimeout = function (fn, ms, ...rest) {
    const src = fn && fn.toString ? fn.toString() : '';
    if (src.includes('_scheduleOutbound')) {
      callIdx++;
      // The first call is the initial schedule with delayMs=0. The second
      // call is the reschedule inside finally -- that's the one we want
      // to observe.
      if (callIdx === 2) {
        observedDelay = ms;
        return { unref: () => {} };
      }
      return realSetTimeout(fn, 0, ...rest);
    }
    return realSetTimeout(fn, ms, ...rest);
  };

  try {
    engine._running = true;
    engine._scheduleOutbound(0);
    await new Promise((r) => realSetTimeout(r, 50));
    assert.equal(observedDelay, DEFAULT_OUTBOUND_INTERVAL);
  } finally {
    engine.stop();
    global.setTimeout = realSetTimeout;
  }
});
