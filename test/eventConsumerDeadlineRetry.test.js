'use strict';

// Regression test for #548 third-pass MAJOR-1:
// EventConsumer used to treat the deadline-fired AbortError identically
// to a stop()-driven AbortError and `break` out of the while loop after
// the first long-poll deadline. NAT idle drops, transport hangs past the
// 60s deadline, and any single missed keepalive killed the "independent
// liveness channel" silently. This test pins down the corrected
// behaviour: a deadline abort must cause one retry iteration, not a
// permanent exit.

const test = require('node:test');
const assert = require('node:assert');

const { EventConsumer } = require('../src/proxy/sync/eventConsumer');

function silentLogger() {
  const warns = [];
  return {
    log: () => {},
    warn: (m) => { warns.push(String(m)); },
    error: () => {},
    _warns: warns,
  };
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

test('eventConsumer: deadline-fired AbortError does NOT kill the loop', async () => {
  const logger = silentLogger();
  let iterations = 0;
  let firstFetchAborted = false;

  // First fetch: hang until the consumer's deadline-AbortController
  // fires, then reject with AbortError. Subsequent fetches: succeed
  // immediately with an empty event list. The test passes iff a second
  // fetch happens at all, proving the loop survived the deadline abort.
  const fetchStub = async (_url, init) => {
    iterations += 1;
    if (iterations === 1) {
      return new Promise((_, reject) => {
        const signal = init && init.signal;
        if (!signal) return reject(new Error('no signal'));
        signal.addEventListener('abort', () => {
          firstFetchAborted = true;
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    // Second iteration onward: a normal long-poll empty response.
    return {
      ok: true,
      status: 200,
      json: async () => ({ events: [] }),
    };
  };

  const lifecycle = {
    nodeId: 'node_test',
    _buildHeaders: () => ({ 'Content-Type': 'application/json' }),
    pokeHeartbeat: () => {},
    reAuthenticate: async () => true,
  };

  const consumer = new EventConsumer({
    hubUrl: 'http://localhost:1',
    lifecycle,
    logger,
    fetchImpl: fetchStub,
    // Short timeout AND short deadline padding so the first iteration's
    // deadline-fired AbortError happens within the test's wall budget.
    pollTimeoutMs: 80,
    fetchDeadlinePaddingMs: 50,
  });
  consumer.start();

  // Wait for the second iteration to happen.
  const survived = await waitFor(() => iterations >= 2, { timeoutMs: 3000 });
  await consumer.stop();

  assert.ok(firstFetchAborted, 'first iteration must have been aborted by the deadline');
  assert.ok(
    survived,
    'consumer must perform a second iteration after a deadline-fired abort (got ' + iterations + ')',
  );
  // The fix logs a "deadline fired" warning -- not load-bearing for
  // behaviour, but a useful diagnostic. Sanity-check the warning was
  // emitted at least once.
  assert.ok(
    logger._warns.some((w) => /deadline fired/.test(w)),
    'expected a "deadline fired" warning in the logs, got: ' + JSON.stringify(logger._warns),
  );
});

test('eventConsumer: stop()-driven AbortError DOES exit the loop cleanly', async () => {
  const logger = silentLogger();
  let iterations = 0;

  const fetchStub = async (_url, init) => {
    iterations += 1;
    return new Promise((_, reject) => {
      const signal = init && init.signal;
      if (!signal) return reject(new Error('no signal'));
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };

  const lifecycle = {
    nodeId: 'node_test',
    _buildHeaders: () => ({ 'Content-Type': 'application/json' }),
    pokeHeartbeat: () => {},
    reAuthenticate: async () => true,
  };

  const consumer = new EventConsumer({
    hubUrl: 'http://localhost:1',
    lifecycle,
    logger,
    fetchImpl: fetchStub,
    pollTimeoutMs: 10_000, // long so deadline never fires
  });
  consumer.start();
  await new Promise((r) => setTimeout(r, 50));
  await consumer.stop();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(iterations, 1, 'stop() must produce exactly one iteration before exit');
});
