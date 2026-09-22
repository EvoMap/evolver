'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function waitForFile(file, timeoutMs = 5_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    function poll() {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() - startedAt > timeoutMs) {
        return reject(new Error(`timed out waiting for ${path.basename(file)}`));
      }
      setTimeout(poll, 10);
    }
    poll();
  });
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('stale remover never deletes a live successor lock after owner ABA', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-lock-aba-'));
  const nodeIdFile = path.join(root, 'node_id');
  const lockDir = `${nodeIdFile}.tuple.lock`;
  const ownerFile = path.join(lockDir, 'owner.stale-owner.json');
  const acquiredFile = path.join(root, 'p2-acquired');
  const releaseFile = path.join(root, 'release-p2');
  const releasedFile = path.join(root, 'p2-released');
  const lockModulePath = require.resolve('../src/canonicalIdentityLock');
  const lock = require('../src/canonicalIdentityLock');
  let child = null;

  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ownerFile, JSON.stringify({
    pid: 999999999,
    token: 'stale-owner',
  }), { mode: 0o600 });

  const childScript = [
    "const fs = require('fs');",
    `const { acquireCanonicalIdentityLock } = require(${JSON.stringify(lockModulePath)});`,
    `const release = acquireCanonicalIdentityLock(${JSON.stringify(nodeIdFile)});`,
    `fs.writeFileSync(${JSON.stringify(acquiredFile)}, '1');`,
    'const deadline = Date.now() + 10_000;',
    `while (!fs.existsSync(${JSON.stringify(releaseFile)}) && Date.now() < deadline) {`,
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
    '}',
    `if (!fs.existsSync(${JSON.stringify(releaseFile)})) throw new Error('release signal timeout');`,
    'release();',
    `fs.writeFileSync(${JSON.stringify(releasedFile)}, '1');`,
  ].join('\n');

  try {
    lock._setCanonicalIdentityLockTimingForTesting({ waitMs: 1, timeoutMs: 75 });
    lock._setBeforeAbandonedLockUnlinkForTesting(() => {
      lock._setBeforeAbandonedLockUnlinkForTesting(null);
      child = spawn(process.execPath, ['-e', childScript], { stdio: 'ignore' });
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(acquiredFile) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      assert.equal(fs.existsSync(acquiredFile), true, 'P2 must acquire the replacement lock');
    });

    assert.throws(
      () => lock.acquireCanonicalIdentityLock(nodeIdFile),
      (err) => err && err.code === 'CANONICAL_IDENTITY_LOCK_TIMEOUT',
      'P1 must wait for the live successor rather than acquiring concurrently'
    );
    assert.ok(child, 'the interleaving must start P2');
    assert.equal(fs.existsSync(lockDir), true, 'P2 lock must remain present after P1 resumes');

    fs.writeFileSync(releaseFile, '1');
    assert.deepEqual(await waitForChild(child), { code: 0, signal: null });
    await waitForFile(releasedFile);
    assert.equal(fs.existsSync(lockDir), false, 'P2 release must remove its own lock cleanly');
  } finally {
    lock._setBeforeAbandonedLockUnlinkForTesting(null);
    lock._resetCanonicalIdentityLockTimingForTesting();
    if (child && child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('acquire recovers an aged empty lock directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-lock-empty-'));
  const nodeIdFile = path.join(root, 'node_id');
  const lockDir = `${nodeIdFile}.tuple.lock`;
  const lock = require('../src/canonicalIdentityLock');

  try {
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const staleAt = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, staleAt, staleAt);

    const release = lock.acquireCanonicalIdentityLock(nodeIdFile);
    assert.equal(fs.existsSync(lockDir), true);
    release();
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('acquire recovers an aged truncated token owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-lock-truncated-'));
  const nodeIdFile = path.join(root, 'node_id');
  const lockDir = `${nodeIdFile}.tuple.lock`;
  const ownerFile = path.join(lockDir, 'owner.truncated-token.json');
  const lock = require('../src/canonicalIdentityLock');

  try {
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(ownerFile, '{"pid":', { mode: 0o600 });
    const staleAt = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, staleAt, staleAt);

    const release = lock.acquireCanonicalIdentityLock(nodeIdFile);
    const names = fs.readdirSync(lockDir);
    assert.equal(names.length, 1);
    assert.match(names[0], /^owner\.[a-zA-Z0-9-]+\.json$/);
    assert.notEqual(names[0], path.basename(ownerFile));
    release();
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('partial owner preparation failure never exposes a canonical lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-lock-partial-'));
  const nodeIdFile = path.join(root, 'node_id');
  const lockDir = `${nodeIdFile}.tuple.lock`;
  const lock = require('../src/canonicalIdentityLock');
  const originalWriteFileSync = fs.writeFileSync;

  try {
    let injected = false;
    fs.writeFileSync = function injectPartialOwnerWrite(file, data, options) {
      if (!injected && String(file).includes('.tuple.lock.owner.') && String(file).endsWith('.tmp')) {
        injected = true;
        originalWriteFileSync.call(fs, file, '{"pid":', options);
        const err = new Error('injected partial owner write failure');
        err.code = 'ENOSPC';
        throw err;
      }
      return originalWriteFileSync.call(fs, file, data, options);
    };

    assert.throws(
      () => lock.acquireCanonicalIdentityLock(nodeIdFile),
      (err) => err && err.code === 'ENOSPC'
    );
    assert.equal(fs.existsSync(lockDir), false, 'partial owner must never be published');
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.includes('.tuple.lock.owner.')),
      [],
      'partial staging files must be removed'
    );

    fs.writeFileSync = originalWriteFileSync;
    const release = lock.acquireCanonicalIdentityLock(nodeIdFile);
    release();
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepares owner files with a writable descriptor for fdatasync', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-lock-fdatasync-'));
  const nodeIdFile = path.join(root, 'node_id');
  const lock = require('../src/canonicalIdentityLock');
  const originalOpenSync = fs.openSync;
  let stagedOwnerFlags = null;

  try {
    fs.openSync = function captureStagedOwnerFlags(file, flags, ...args) {
      if (String(file).endsWith('.tmp')) stagedOwnerFlags = flags;
      return originalOpenSync.call(fs, file, flags, ...args);
    };

    const release = lock.acquireCanonicalIdentityLock(nodeIdFile);
    release();
    assert.equal(stagedOwnerFlags, 'r+');
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release cleanup failure leaves canonical path available to a successor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-lock-release-'));
  const nodeIdFile = path.join(root, 'node_id');
  const lockDir = `${nodeIdFile}.tuple.lock`;
  const lock = require('../src/canonicalIdentityLock');
  const originalRmdirSync = fs.rmdirSync;

  try {
    const release = lock.acquireCanonicalIdentityLock(nodeIdFile);
    let injected = false;
    fs.rmdirSync = function injectReleaseCleanupFailure(dir, options) {
      if (!injected && String(dir).startsWith(`${lockDir}.release.`)) {
        injected = true;
        const err = new Error('injected interrupted release cleanup');
        err.code = 'EINTR';
        throw err;
      }
      return originalRmdirSync.call(fs, dir, options);
    };

    assert.throws(() => release(), (err) => err && err.code === 'EINTR');
    assert.equal(fs.existsSync(lockDir), false, 'release residue must not occupy canonical path');

    fs.rmdirSync = originalRmdirSync;
    const successorRelease = lock.acquireCanonicalIdentityLock(nodeIdFile);
    successorRelease();
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    fs.rmdirSync = originalRmdirSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy fixed owner marker fails closed and is never auto-reclaimed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-lock-legacy-owner-'));
  const nodeIdFile = path.join(root, 'node_id');
  const lockDir = `${nodeIdFile}.tuple.lock`;
  const ownerFile = path.join(lockDir, 'owner.json');
  const lock = require('../src/canonicalIdentityLock');

  try {
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(ownerFile, JSON.stringify({
      pid: 999999999,
      token: 'legacy-stale-owner',
    }), { mode: 0o600 });
    const staleAt = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, staleAt, staleAt);
    lock._setCanonicalIdentityLockTimingForTesting({ waitMs: 1, timeoutMs: 20 });

    assert.throws(
      () => lock.acquireCanonicalIdentityLock(nodeIdFile),
      (err) => err && err.code === 'CANONICAL_IDENTITY_LOCK_TIMEOUT'
    );
    assert.equal(fs.existsSync(ownerFile), true);
  } finally {
    lock._resetCanonicalIdentityLockTimingForTesting();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('acquire reclaims a lock when the PID has a different process start identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-lock-pid-reused-'));
  const nodeIdFile = path.join(root, 'node_id');
  const lockDir = `${nodeIdFile}.tuple.lock`;
  const ownerFile = path.join(lockDir, 'owner.reused-pid.json');
  const lock = require('../src/canonicalIdentityLock');

  try {
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(ownerFile, JSON.stringify({
      pid: process.pid,
      token: 'reused-pid',
      processStartIdentity: 'previous-process-start',
    }), { mode: 0o600 });
    lock._setProcessStartIdentityReaderForTesting(() => 'current-process-start');

    const release = lock.acquireCanonicalIdentityLock(nodeIdFile);
    assert.equal(fs.existsSync(ownerFile), false, 'the prior process lock must be reclaimed');
    release();
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    lock._setProcessStartIdentityReaderForTesting(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('acquire never reclaims the same process identity even when the lock is old', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-lock-same-process-'));
  const nodeIdFile = path.join(root, 'node_id');
  const lockDir = `${nodeIdFile}.tuple.lock`;
  const ownerFile = path.join(lockDir, 'owner.same-process.json');
  const lock = require('../src/canonicalIdentityLock');

  try {
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(ownerFile, JSON.stringify({
      pid: process.pid,
      token: 'same-process',
      processStartIdentity: 'current-process-start',
    }), { mode: 0o600 });
    const staleAt = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, staleAt, staleAt);
    lock._setProcessStartIdentityReaderForTesting(() => 'current-process-start');
    lock._setCanonicalIdentityLockTimingForTesting({ waitMs: 1, timeoutMs: 20 });

    assert.throws(
      () => lock.acquireCanonicalIdentityLock(nodeIdFile),
      (err) => err && err.code === 'CANONICAL_IDENTITY_LOCK_TIMEOUT'
    );
    assert.equal(fs.existsSync(ownerFile), true, 'the live owner marker must remain intact');
  } finally {
    lock._setProcessStartIdentityReaderForTesting(null);
    lock._resetCanonicalIdentityLockTimingForTesting();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
