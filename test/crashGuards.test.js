'use strict';

// F1 / F15: crashGuards regression tests.
//
// Two flavors: in-process unit tests for the cluster gate / install
// idempotency / releaseLock plumbing, and a real-subprocess test that
// proves the installed uncaughtException handler actually fires when a
// heartbeat tick throws synchronously inside a setTimeout in a long-
// running mode. Pre-fix, that handler was only installed for --loop --
// proxy / webui daemons silently died with no diagnostic.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  installCrashGuards,
  REJECTION_WINDOW_MS,
  REJECTION_THRESHOLD,
  _resetForTesting,
} = require('../src/ops/crashGuards');

function freshGuards(opts) {
  _resetForTesting();
  return installCrashGuards(opts);
}

test('installCrashGuards: installs both handlers on first call', () => {
  try {
    const wasFresh = freshGuards();
    assert.equal(wasFresh, true);
    assert.ok(process.listenerCount('uncaughtException') >= 1);
    assert.ok(process.listenerCount('unhandledRejection') >= 1);
  } finally {
    _resetForTesting();
  }
});

test('installCrashGuards: second call is a no-op (idempotent)', () => {
  try {
    freshGuards();
    const firstUE = process.listenerCount('uncaughtException');
    const firstUR = process.listenerCount('unhandledRejection');
    const wasFresh = installCrashGuards();
    assert.equal(wasFresh, false, 'second install must report it did nothing');
    assert.equal(process.listenerCount('uncaughtException'), firstUE);
    assert.equal(process.listenerCount('unhandledRejection'), firstUR);
  } finally {
    _resetForTesting();
  }
});

test('installCrashGuards: exports the cluster gate constants for callers to introspect', () => {
  assert.equal(REJECTION_WINDOW_MS, 5 * 60 * 1000);
  assert.equal(REJECTION_THRESHOLD, 5);
});

// ---------------------------------------------------------------------------
// Subprocess test. Runs a tiny script that requires crashGuards, installs
// them, then schedules a throw inside a setTimeout (the exact shape that
// a heartbeat tick or eventConsumer iteration would take). Asserts the
// FATAL handler logs to stderr and exits 1 instead of silently dying or
// exiting 0.

test('uncaughtException handler logs FATAL + exits 1 in a long-running mode', () => {
  const script = `
    const releaseCalls = [];
    const { installCrashGuards } = require('./src/ops/crashGuards');
    installCrashGuards({ releaseLock: () => releaseCalls.push(Date.now()) });
    // Keep the loop alive so the throw inside setTimeout is the only thing
    // we care about -- mirrors --loop / webui's await-forever shape.
    setInterval(() => {}, 60_000);
    setTimeout(() => { throw new Error('synthetic-tick-throw'); }, 25);
  `;
  const repoRoot = path.resolve(__dirname, '..');
  const res = spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
  // Exit code is 1 because the handler called process.exit(1). Pre-fix,
  // a thrown error inside setTimeout in proxy / webui mode escaped Node's
  // default handler and the process exited with code 1 ALSO (default
  // behavior), but with no [FATAL] log line and no releaseLock call.
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}, stderr=${res.stderr}`);
  assert.match(res.stderr, /\[FATAL\] Uncaught exception:/);
  assert.match(res.stderr, /synthetic-tick-throw/);
});

test('uncaughtException handler invokes releaseLock before exiting', () => {
  // Verify that a releaseLock callback the caller passes is actually
  // invoked by the FATAL path. We can't read state across process
  // boundaries, so the script writes a marker file the parent reads.
  const fs = require('node:fs');
  const os = require('node:os');
  const tmpFile = path.join(os.tmpdir(), `crashguards-test-${process.pid}-${Date.now()}`);
  try {
    const script = `
      const fs = require('node:fs');
      const { installCrashGuards } = require('./src/ops/crashGuards');
      installCrashGuards({
        releaseLock: () => { try { fs.writeFileSync(${JSON.stringify(tmpFile)}, 'released'); } catch (_) {} },
      });
      setInterval(() => {}, 60_000);
      setTimeout(() => { throw new Error('synthetic-tick-throw'); }, 25);
    `;
    const repoRoot = path.resolve(__dirname, '..');
    const res = spawnSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}, stderr=${res.stderr}`);
    assert.ok(fs.existsSync(tmpFile), 'releaseLock callback must run before process.exit');
    assert.equal(fs.readFileSync(tmpFile, 'utf8'), 'released');
  } finally {
    try { require('node:fs').unlinkSync(tmpFile); } catch (_) { /* noop */ }
  }
});

test('unhandledRejection cluster gate: 4 rejections do NOT exit; 5 do', () => {
  // Drive REJECTION_THRESHOLD rejections in a short window and assert the
  // process exits 1 only after crossing the threshold. Below threshold,
  // the script proves it kept running by also writing a marker file.
  const fs = require('node:fs');
  const os = require('node:os');
  const tmpFile = path.join(os.tmpdir(), `crashguards-cluster-${process.pid}-${Date.now()}`);
  try {
    const scriptBelowThreshold = `
      const fs = require('node:fs');
      const { installCrashGuards } = require('./src/ops/crashGuards');
      installCrashGuards();
      for (let i = 0; i < 4; i++) Promise.reject(new Error('synthetic-' + i));
      // Give the unhandledRejection events one tick to drain, then prove
      // we are alive by writing the marker and exiting cleanly.
      setTimeout(() => { fs.writeFileSync(${JSON.stringify(tmpFile)}, 'alive'); process.exit(0); }, 50);
    `;
    const repoRoot = path.resolve(__dirname, '..');
    const belowRes = spawnSync(process.execPath, ['-e', scriptBelowThreshold], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(belowRes.status, 0, `4 rejections must NOT exit, stderr=${belowRes.stderr}`);
    assert.ok(fs.existsSync(tmpFile), 'process must remain alive below threshold');

    const scriptAboveThreshold = `
      const { installCrashGuards } = require('./src/ops/crashGuards');
      installCrashGuards();
      setInterval(() => {}, 60_000);
      for (let i = 0; i < 5; i++) Promise.reject(new Error('synthetic-' + i));
    `;
    const aboveRes = spawnSync(process.execPath, ['-e', scriptAboveThreshold], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(aboveRes.status, 1, `5 rejections must exit 1, stderr=${aboveRes.stderr}`);
    assert.match(aboveRes.stderr, /unhandled rejections within 300s. Exiting/);
  } finally {
    try { require('node:fs').unlinkSync(tmpFile); } catch (_) { /* noop */ }
  }
});
