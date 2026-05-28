'use strict';

// Tests for src/proxy/sync/eventConsumer.js.
//
// Strategy: inject a fetch stub via the EventConsumer's fetchImpl
// option so no real network IO occurs. Each test arranges a fixed
// queue of responses (or behaviours), waits a bounded amount of real
// time for the async loop to chew through them, and asserts on the
// observed pokeHeartbeat / reAuthenticate / onEvent invocations.

const test = require('node:test');
const assert = require('node:assert');

const {
  EventConsumer,
  MIN_BACKOFF_MS,
  MAX_BACKOFF_MS,
} = require('../src/proxy/sync/eventConsumer');

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

function makeLifecycle(opts = {}) {
  const calls = { poke: 0, reauth: 0 };
  return {
    calls,
    nodeId: opts.nodeId || 'node_test',
    _buildHeaders: () => ({ Authorization: 'Bearer test', 'Content-Type': 'application/json' }),
    pokeHeartbeat: opts.pokeHeartbeat || (() => { calls.poke++; return true; }),
    reAuthenticate: opts.reAuthenticate || (async () => { calls.reauth++; return true; }),
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// Build a fetch stub that returns responses in order. Each entry can be:
//   - a Response-shape object (returned directly)
//   - a function (called with (url, init) and its return value used)
//   - an Error (thrown)
function makeFetchStub(sequence) {
  let i = 0;
  const calls = [];
  const stub = async (url, init) => {
    calls.push({ url, init });
    if (i >= sequence.length) {
      // After the scripted sequence ends, hang forever so the loop is
      // forced into its abort path on stop(). Honour the abort signal.
      return new Promise((_, reject) => {
        const onAbort = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (init && init.signal) {
          if (init.signal.aborted) return onAbort();
          init.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
    const entry = sequence[i++];
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'function') return entry(url, init);
    return entry;
  };
  return { stub, calls };
}

// Wait until predicate() returns truthy or `timeoutMs` elapses.
async function waitFor(predicate, { timeoutMs = 1500, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ok = false;
    try { ok = predicate(); } catch (_e) { ok = false; }
    if (ok) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// --------------------------------------------------------------------------

test('successful poll calls pokeHeartbeat and delivers events', async () => {
  const lifecycle = makeLifecycle();
  const events = [{ type: 'council_invite', id: 'e1' }];
  const { stub, calls } = makeFetchStub([
    jsonResponse(200, { events }),
  ]);

  const seenEvents = [];
  const ec = new EventConsumer({
    hubUrl: 'https://hub.test',
    lifecycle,
    logger: silentLogger(),
    fetchImpl: stub,
    onEvent: (e) => seenEvents.push(e),
  });

  ec.start();
  try {
    const ok = await waitFor(() => lifecycle.calls.poke >= 1 && seenEvents.length >= 1);
    assert.ok(ok, 'pokeHeartbeat must be called and event delivered');
    assert.equal(lifecycle.calls.poke, 1);
    assert.deepEqual(seenEvents, events);
    assert.equal(calls.length >= 1, true);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.node_id, 'node_test');
    assert.equal(typeof sent.timeout_ms, 'number');
  } finally {
    await ec.stop();
  }
});

test('poll without events still wakes heartbeat (poll = liveness)', async () => {
  const lifecycle = makeLifecycle();
  const { stub } = makeFetchStub([
    jsonResponse(200, { events: [] }),
  ]);

  const ec = new EventConsumer({
    hubUrl: 'https://hub.test',
    lifecycle,
    logger: silentLogger(),
    fetchImpl: stub,
  });

  ec.start();
  try {
    const ok = await waitFor(() => lifecycle.calls.poke >= 1);
    assert.ok(ok, 'empty-event poll must still pokeHeartbeat');
  } finally {
    await ec.stop();
  }
});

test('401 triggers reAuthenticate without compounding backoff', async () => {
  const lifecycle = makeLifecycle();
  // First call returns 401; subsequent calls succeed.
  const { stub } = makeFetchStub([
    jsonResponse(401, { error: 'node_secret_invalid' }),
    jsonResponse(200, { events: [] }),
  ]);

  const ec = new EventConsumer({
    hubUrl: 'https://hub.test',
    lifecycle,
    logger: silentLogger(),
    fetchImpl: stub,
  });

  ec.start();
  try {
    const ok = await waitFor(() => lifecycle.calls.reauth >= 1 && lifecycle.calls.poke >= 1);
    assert.ok(ok, 'reAuthenticate must run on 401 and poll must resume');
    assert.equal(ec._backoffMs, MIN_BACKOFF_MS, 'backoff must be reset, not doubled, on auth path');
  } finally {
    await ec.stop();
  }
});

test('5xx applies exponential backoff', async () => {
  const lifecycle = makeLifecycle();
  // First call 503 doubles backoff from 1s to 2s; that single transition
  // is enough to assert the growth law. We do not wait for the second
  // round-trip (it would require the 2s sleep to elapse).
  const { stub } = makeFetchStub([
    jsonResponse(503, {}),
  ]);

  const ec = new EventConsumer({
    hubUrl: 'https://hub.test',
    lifecycle,
    logger: silentLogger(),
    fetchImpl: stub,
  });

  const iterations = [];
  ec._onIteration = (info) => iterations.push(info);

  ec.start();
  try {
    const ok = await waitFor(() => iterations.filter((i) => i.status === 'error').length >= 1);
    assert.ok(ok, 'one error iteration must be observed');
    assert.ok(
      ec._backoffMs > MIN_BACKOFF_MS && ec._backoffMs <= MAX_BACKOFF_MS,
      `backoff should grow after a failure (was ${ec._backoffMs})`,
    );
    assert.equal(lifecycle.calls.poke, 0, 'pokeHeartbeat must NOT fire on error responses');
  } finally {
    await ec.stop();
  }
});

test('fetch throw applies backoff and continues', async () => {
  const lifecycle = makeLifecycle();
  const { stub } = makeFetchStub([
    new Error('ECONNRESET'),
    jsonResponse(200, { events: [] }),
  ]);

  const ec = new EventConsumer({
    hubUrl: 'https://hub.test',
    lifecycle,
    logger: silentLogger(),
    fetchImpl: stub,
  });

  ec.start();
  try {
    const ok = await waitFor(() => lifecycle.calls.poke >= 1, { timeoutMs: 3500 });
    assert.ok(ok, 'loop must recover after a thrown fetch error');
  } finally {
    await ec.stop();
  }
});

test('stop() exits the loop quickly without waiting full backoff', async () => {
  const lifecycle = makeLifecycle();
  // Force the consumer into a long backoff window, then stop() and
  // assert it returns within a small fraction of that backoff.
  const { stub } = makeFetchStub([
    jsonResponse(503, {}),
  ]);

  const ec = new EventConsumer({
    hubUrl: 'https://hub.test',
    lifecycle,
    logger: silentLogger(),
    fetchImpl: stub,
  });

  ec.start();
  // Wait for the loop to enter the backoff sleep.
  await waitFor(() => ec._wakeSleep != null, { timeoutMs: 1500 });
  assert.ok(ec._wakeSleep, 'consumer should be sleeping after 503');

  const t0 = Date.now();
  await ec.stop();
  const dt = Date.now() - t0;
  assert.ok(dt < 500, `stop() must wake the backoff sleep; took ${dt}ms`);
});

test('stop() aborts an in-flight long-poll fetch', async () => {
  const lifecycle = makeLifecycle();
  // Custom fetch that hangs until aborted, then rejects with AbortError.
  let aborted = false;
  const stub = async (_url, init) => {
    return new Promise((_, reject) => {
      const onAbort = () => {
        aborted = true;
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (init && init.signal) {
        if (init.signal.aborted) return onAbort();
        init.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  };

  const ec = new EventConsumer({
    hubUrl: 'https://hub.test',
    lifecycle,
    logger: silentLogger(),
    fetchImpl: stub,
  });

  ec.start();
  await waitFor(() => ec._abortCtrl != null, { timeoutMs: 500 });
  assert.ok(ec._abortCtrl, 'fetch should be in-flight');

  const t0 = Date.now();
  await ec.stop();
  const dt = Date.now() - t0;
  assert.ok(aborted, 'abort signal must have fired on the in-flight fetch');
  assert.ok(dt < 500, `stop() must return promptly; took ${dt}ms`);
});

test('missing node_id waits without compounding backoff', async () => {
  // Lifecycle without nodeId until t=200ms; then becomes available.
  let nodeId = null;
  const lifecycle = makeLifecycle();
  Object.defineProperty(lifecycle, 'nodeId', { get: () => nodeId });
  setTimeout(() => { nodeId = 'node_late'; }, 200);

  const { stub, calls } = makeFetchStub([
    jsonResponse(200, { events: [] }),
  ]);

  const ec = new EventConsumer({
    hubUrl: 'https://hub.test',
    lifecycle,
    logger: silentLogger(),
    fetchImpl: stub,
  });

  ec.start();
  try {
    // Allow time for the no-node retry (2s) + late binding (200ms).
    const ok = await waitFor(() => lifecycle.calls.poke >= 1, { timeoutMs: 3500 });
    assert.ok(ok, 'loop must resume polling once nodeId becomes available');
    assert.ok(calls.length >= 1, 'fetch should fire after nodeId is set');
    assert.equal(ec._backoffMs, MIN_BACKOFF_MS, 'no-node wait must not advance backoff');
  } finally {
    await ec.stop();
  }
});

test('start() refuses when no hubUrl', () => {
  const ec = new EventConsumer({
    hubUrl: '',
    lifecycle: makeLifecycle(),
    logger: silentLogger(),
  });
  const ok = ec.start();
  assert.equal(ok, false, 'start without hubUrl must return false');
  assert.equal(ec._running, false);
});

test('successful poll resets backoff after a failure streak', async () => {
  const lifecycle = makeLifecycle();
  const { stub } = makeFetchStub([
    jsonResponse(503, {}),
    jsonResponse(503, {}),
    jsonResponse(200, { events: [] }),
  ]);

  const ec = new EventConsumer({
    hubUrl: 'https://hub.test',
    lifecycle,
    logger: silentLogger(),
    fetchImpl: stub,
    // Speed up backoff so the test completes in ~seconds, not minutes.
  });

  ec.start();
  try {
    const ok = await waitFor(() => lifecycle.calls.poke >= 1, { timeoutMs: 8000 });
    assert.ok(ok, 'eventual success must occur');
    assert.equal(ec._backoffMs, MIN_BACKOFF_MS, 'backoff must reset after success');
  } finally {
    await ec.stop();
  }
});
