'use strict';

// Regression tests for #548 third-pass fixes that touch
// src/proxy/lifecycle/manager.js:
//
//   TG-2 -- _tickGeneration must not be reset to 0 by startHeartbeatLoop,
//           so a zombie tick captured before stop() can never look live
//           after a subsequent start().
//
//   G1   -- force_update and upgrade_available signals are objects on
//           the wire; the prior `=== true` check was dead code.
//
//   D2   -- startHeartbeatLoop now accepts a { keepAlive } option and
//           the drift detector interval is not .unref()'d when set.

const test = require('node:test');
const assert = require('node:assert');

const { LifecycleManager } = require('../src/proxy/lifecycle/manager');

const _origInsecure = process.env.EVOMAP_HUB_ALLOW_INSECURE;
process.env.EVOMAP_HUB_ALLOW_INSECURE = '1';
test.after(() => {
  if (_origInsecure === undefined) delete process.env.EVOMAP_HUB_ALLOW_INSECURE;
  else process.env.EVOMAP_HUB_ALLOW_INSECURE = _origInsecure;
});

function makeStore() {
  const state = { node_id: 'node_aaaaaaaaaaaa', node_secret: 'a'.repeat(64) };
  return {
    getState: (k) => state[k] ?? null,
    setState: (k, v) => { state[k] = v; },
    countPending: () => 0,
    writeInbound: () => {},
    writeInboundBatch: () => {},
  };
}

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

function makeManager(opts = {}) {
  return new LifecycleManager({
    hubUrl: 'https://example.test',
    store: opts.store || makeStore(),
    logger: opts.logger || silentLogger(),
    getTaskMeta: opts.getTaskMeta || (() => ({})),
  });
}

function installFetchStub(impl) {
  const orig = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = orig; };
}

// -------- TG-2 --------

test('TG-2: startHeartbeatLoop bumps _tickGeneration above any pre-stop value', () => {
  const lc = makeManager();
  lc.startHeartbeatLoop();
  // Simulate that several hung-tick rescues happened during the prior
  // session, advancing _tickGeneration. Then stop, then start again.
  lc._tickGeneration = 5;
  lc.stopHeartbeatLoop();
  lc.startHeartbeatLoop();
  assert.ok(
    lc._tickGeneration > 5,
    'second startHeartbeatLoop must NOT reset _tickGeneration to 0 (got ' + lc._tickGeneration + ')',
  );
  lc.stopHeartbeatLoop();
});

test('TG-2: a zombie generation captured before stop cannot look live after restart', () => {
  const lc = makeManager();
  lc.startHeartbeatLoop();
  lc._tickGeneration = 7;
  const zombieMyGen = lc._tickGeneration;
  lc.stopHeartbeatLoop();
  lc.startHeartbeatLoop();
  assert.ok(
    lc._tickGeneration > zombieMyGen,
    'live gen=' + lc._tickGeneration + ' must exceed zombie gen=' + zombieMyGen,
  );
  lc.stopHeartbeatLoop();
});

// -------- G1 --------

async function runHeartbeatReturning(body, opts = {}) {
  const logger = silentLogger();
  const warns = [];
  const logs = [];
  logger.warn = (m) => warns.push(String(m));
  logger.log = (m) => logs.push(String(m));
  logger.info = (m) => logs.push(String(m));

  const restore = installFetchStub(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));

  const lc = makeManager({ logger });
  // Drive the heartbeat path directly without spinning the loop.
  let result;
  try {
    if (opts.runs && opts.runs > 1) {
      for (let i = 0; i < opts.runs; i++) result = await lc.heartbeat();
    } else {
      result = await lc.heartbeat();
    }
  } finally {
    restore();
  }
  return { lc, warns, logs, result };
}

test('G1: force_update as an object arms _forceUpdateRequired (previously dead under === true)', async () => {
  const { lc, warns } = await runHeartbeatReturning({
    force_update: { message: 'Upgrade by EOD', url: 'https://example.test/release' },
  });
  assert.equal(
    lc._forceUpdateRequired,
    true,
    'force_update object must set _forceUpdateRequired',
  );
  assert.ok(
    warns.some((w) => /force_update/.test(w) && /Upgrade by EOD/.test(w)),
    'warn must surface the hub-provided message; got: ' + JSON.stringify(warns),
  );
});

test('G1: force_update as literal true still arms the flag (back-compat)', async () => {
  const { lc } = await runHeartbeatReturning({ force_update: true });
  assert.equal(lc._forceUpdateRequired, true);
});

test('G1: missing force_update does not arm the flag', async () => {
  const { lc } = await runHeartbeatReturning({});
  assert.notEqual(lc._forceUpdateRequired, true);
});

test('G1: upgrade_available object logs the hub message exactly once across two heartbeats', async () => {
  const { logs } = await runHeartbeatReturning({
    upgrade_available: { message: 'New version 2.0', url: 'https://example.test/v2' },
  }, { runs: 2 });
  const upgLogs = logs.filter((l) => /upgrade available/.test(l));
  assert.equal(upgLogs.length, 1, 'expected exactly one upgrade log; got: ' + JSON.stringify(logs));
  assert.ok(/New version 2.0/.test(upgLogs[0]));
});

test('G1: false-y values for force_update do not arm the flag', async () => {
  const { lc } = await runHeartbeatReturning({ force_update: null });
  assert.notEqual(lc._forceUpdateRequired, true);
  const { lc: lc2 } = await runHeartbeatReturning({ force_update: 0 });
  assert.notEqual(lc2._forceUpdateRequired, true);
  const { lc: lc3 } = await runHeartbeatReturning({ force_update: false });
  assert.notEqual(lc3._forceUpdateRequired, true);
});

// -------- D2 --------

test('D2: startHeartbeatLoop({ keepAlive: true }) leaves the drift interval ref\'d', () => {
  const lc = makeManager();
  lc.startHeartbeatLoop(undefined, { keepAlive: true });
  const interval = lc._driftInterval;
  assert.ok(interval, 'drift interval must be installed');
  if (typeof interval.hasRef === 'function') {
    assert.equal(interval.hasRef(), true, 'keepAlive must NOT unref the drift interval');
  } else {
    // Older Node without hasRef(): at minimum verify the option was
    // captured. Production correctness is then a code-review concern.
    assert.equal(lc._driftKeepAlive, true);
  }
  lc.stopHeartbeatLoop();
});

test('D2: default (no opts) unrefs the drift interval for back-compat', () => {
  const lc = makeManager();
  lc.startHeartbeatLoop();
  const interval = lc._driftInterval;
  assert.ok(interval);
  if (typeof interval.hasRef === 'function') {
    assert.equal(interval.hasRef(), false, 'default must remain unref\'d');
  } else {
    assert.equal(lc._driftKeepAlive, false);
  }
  lc.stopHeartbeatLoop();
});
