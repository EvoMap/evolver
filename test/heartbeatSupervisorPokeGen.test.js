'use strict';

// Regression test for #548 third-pass MAJOR-2:
// heartbeatSupervisor.poke() used to clear _pokeInFlight / _pokeStartedAt
// unconditionally in its finally. Under this sequence:
//   1. poke A starts; awaits a never-resolving sendHeartbeat.
//   2. _hardRestart fires (e.g. drift detector after host wake);
//      clears the latch and lets a fresh poke fire.
//   3. poke B starts and acquires the latch.
//   4. poke A's underlying promise eventually settles; its finally
//      stomps poke B's latch values.
// At step 4, a third poke C could then fire in parallel with B.
// The fix is a generation counter captured at acquire time; finally
// only releases the latch if the generation hasn't moved on.

const test = require('node:test');
const assert = require('node:assert');

const supervisor = require('../src/gep/heartbeatSupervisor');

function makeA2a({ holdSend = false } = {}) {
  let resolveHeld = null;
  const state = { startCalls: 0, stopCalls: 0, sendCalls: 0 };
  return {
    state,
    releaseHeldSend: () => { if (resolveHeld) { resolveHeld(); resolveHeld = null; } },
    api: {
      startHeartbeat() { state.startCalls++; },
      stopHeartbeat() { state.stopCalls++; },
      sendHeartbeat() {
        state.sendCalls++;
        if (holdSend && state.sendCalls === 1) {
          return new Promise((resolve) => { resolveHeld = resolve; });
        }
        return Promise.resolve();
      },
      getHeartbeatStats() {
        return {
          running: true,
          uptimeMs: 0,
          totalSent: state.sendCalls,
          totalFailed: 0,
          consecutiveFailures: 0,
        };
      },
    },
  };
}

function cleanup() {
  try { supervisor.stop(); } catch (_e) { /* noop */ }
  supervisor._resetForTesting();
}

test('supervisor: hung-poke finally must not clobber a fresh poke acquired after _hardRestart', async () => {
  cleanup();
  const { state, api, releaseHeldSend } = makeA2a({ holdSend: true });

  // Drift / liveness off so we drive the test deterministically.
  supervisor.start(api, { driftCheckMs: 60_000, livenessCheckMs: 60_000 });

  // Poke A: enters sendHeartbeat which never resolves. We await one
  // microtask so the IIFE has captured its generation and assigned the
  // latch.
  const okA = supervisor.poke('A');
  assert.equal(okA, true, 'poke A must succeed');
  await new Promise((r) => setImmediate(r));

  const latchAfterA = supervisor._getLatchForTesting('_pokeInFlight');
  const tsAfterA = supervisor._getLatchForTesting('_pokeStartedAt');
  assert.ok(latchAfterA, 'latch must be held by poke A');
  assert.ok(tsAfterA > 0, 'acquire timestamp must be set');

  // Simulate _hardRestart firing in the middle of poke A. The
  // production code clears the latch AND bumps _pokeGeneration so
  // poke A's eventual finally is a no-op.
  supervisor._hardRestart(Date.now());

  // poke A is still "in flight" inside Node's microtask queue, but
  // its latch is cleared. A subsequent poke must be able to fire.
  // To allow it, also bypass the 60s throttle by directly clearing
  // _lastPokeAt via reset would discard too much; instead just wait
  // -- the test below validates the *finally* doesn't clobber. So
  // we don't actually need to fire poke B in this same test, only
  // verify that when poke A's promise settles, the latch (which we
  // re-set manually to a sentinel below) is NOT cleared.
  supervisor._setLatchForTesting('_pokeInFlight', 'sentinel-poke-B');
  supervisor._setLatchForTesting('_pokeStartedAt', 999_999);

  // Now release poke A's underlying send so its IIFE finally runs.
  releaseHeldSend();
  // Let the microtask drain.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const latchAfterReleaseA = supervisor._getLatchForTesting('_pokeInFlight');
  const tsAfterReleaseA = supervisor._getLatchForTesting('_pokeStartedAt');

  assert.equal(
    latchAfterReleaseA,
    'sentinel-poke-B',
    'poke A finally must NOT clobber a newer poke\'s latch (got ' + latchAfterReleaseA + ')',
  );
  assert.equal(
    tsAfterReleaseA,
    999_999,
    'poke A finally must NOT clobber a newer poke\'s acquire timestamp',
  );

  cleanup();
});

test('supervisor: normal poke release path still clears the latch', async () => {
  cleanup();
  const { api } = makeA2a({ holdSend: false });
  supervisor.start(api, { driftCheckMs: 60_000, livenessCheckMs: 60_000 });

  const ok = supervisor.poke('normal');
  assert.equal(ok, true);
  // sendHeartbeat resolves synchronously; let the IIFE finally drain.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const latch = supervisor._getLatchForTesting('_pokeInFlight');
  const ts = supervisor._getLatchForTesting('_pokeStartedAt');
  assert.equal(latch, null, 'latch must be cleared after a successful poke');
  assert.equal(ts, 0, 'acquire timestamp must be cleared too');

  cleanup();
});
