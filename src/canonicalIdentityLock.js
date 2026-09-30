'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_LOCK_WAIT_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const UNKNOWN_OWNER_STALE_MS = 60_000;
const heldLocks = new Map();
let lockWaitMs = DEFAULT_LOCK_WAIT_MS;
let lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;
let beforeAbandonedLockUnlinkForTesting = null;
let processStartIdentityReaderForTesting = null;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'ESRCH') return false;
    if (e && e.code === 'EPERM') return true;
    return null;
  }
}

function readLinuxProcessStartIdentity(pid) {
  let bootId;
  let statContents;
  try {
    bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    statContents = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
  } catch {
    return null;
  }
  if (!/^[a-f0-9-]{36}$/i.test(bootId)) return null;

  // A process name may contain spaces and parentheses, so fields after comm
  // must be parsed from the final closing parenthesis. starttime is field 22.
  const closeParen = statContents.lastIndexOf(')');
  const openParen = statContents.indexOf('(');
  if (openParen <= 0 || closeParen <= openParen) return null;
  const statPid = Number(statContents.slice(0, openParen).trim());
  if (statPid !== pid) return null;
  const fieldsAfterComm = statContents.slice(closeParen + 1).trim().split(/\s+/);
  const startTimeTicks = fieldsAfterComm[19];
  if (!/^\d+$/.test(startTimeTicks || '')) return null;
  return `linux:${bootId}:${startTimeTicks}`;
}

function runDarwinIdentityCommand(file, args) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    maxBuffer: 16 * 1024,
    timeout: 1_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout.trim();
}

function readDarwinProcessStartIdentity(pid) {
  const bootOutput = runDarwinIdentityCommand('/usr/sbin/sysctl', ['-n', 'kern.boottime']);
  const bootMatch = /\{\s*sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\s*\}/.exec(bootOutput || '');
  if (!bootMatch) return null;

  const processOutput = runDarwinIdentityCommand('/bin/ps', [
    '-o', 'pid=',
    '-o', 'lstart=',
    '-p', String(pid),
  ]);
  const processMatch = /^(\d+)\s+(.+)$/.exec(processOutput || '');
  if (!processMatch || Number(processMatch[1]) !== pid) return null;
  const startedAt = processMatch[2].trim().replace(/\s+/g, ' ');
  if (!startedAt) return null;
  return `darwin:${bootMatch[1]}.${bootMatch[2]}:${startedAt}`;
}

function readProcessStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (processStartIdentityReaderForTesting) {
    const value = processStartIdentityReaderForTesting(pid);
    return typeof value === 'string' && value ? value : null;
  }
  if (process.platform === 'linux') return readLinuxProcessStartIdentity(pid);
  if (process.platform === 'darwin') return readDarwinProcessStartIdentity(pid);
  return null;
}

function ownerIsProvablyDead(owner) {
  const alive = processIsAlive(owner.pid);
  if (alive === false) return true;
  if (alive !== true || !owner.processStartIdentity) return false;
  const currentIdentity = readProcessStartIdentity(owner.pid);
  return Boolean(currentIdentity && currentIdentity !== owner.processStartIdentity);
}

function readOwner(ownerFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const pid = Number(parsed.pid);
    const token = typeof parsed.token === 'string' ? parsed.token : '';
    const processStartIdentity = typeof parsed.processStartIdentity === 'string'
      ? parsed.processStartIdentity
      : '';
    if (!Number.isInteger(pid) || pid <= 0 || !token) return null;
    return { pid, token, processStartIdentity };
  } catch {
    return null;
  }
}

function discoverOwner(lockDir) {
  let names;
  try {
    names = fs.readdirSync(lockDir);
  } catch {
    return null;
  }
  if (names.length !== 1) return null;
  const match = /^owner\.([a-zA-Z0-9-]+)\.json$/.exec(names[0]);
  if (!match) return null;
  const token = match[1];
  const ownerFile = path.join(lockDir, names[0]);
  let contents;
  try {
    contents = fs.readFileSync(ownerFile);
  } catch {
    return null;
  }
  const owner = readOwner(ownerFile);
  if (!owner || owner.token !== token) {
    return { kind: 'malformed', owner: null, ownerFile, token, contents };
  }
  return { kind: 'valid', owner, ownerFile, token, contents };
}

function readLockIdentity(lockDir) {
  try {
    const stat = fs.statSync(lockDir, { bigint: true });
    return {
      dev: String(stat.dev),
      ino: String(stat.ino),
      mtimeNs: String(stat.mtimeNs),
      mtimeMs: Number(stat.mtimeMs),
    };
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function sameOwner(left, right) {
  return Boolean(
    left &&
    right &&
    left.pid === right.pid &&
    left.token === right.token &&
    left.processStartIdentity === right.processStartIdentity
  );
}

function sameLockIdentity(left, right) {
  return Boolean(
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs
  );
}

function sameDiscoveredOwner(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.ownerFile !== right.ownerFile || left.token !== right.token) return false;
  if (!Buffer.isBuffer(left.contents) || !Buffer.isBuffer(right.contents)) return false;
  if (!left.contents.equals(right.contents)) return false;
  if (left.kind === 'valid') return sameOwner(left.owner, right.owner);
  return true;
}

function currentAbandonedSnapshotMatches(lockDir, expected) {
  const identity = readLockIdentity(lockDir);
  if (!sameLockIdentity(identity, expected && expected.identity)) return false;
  if (expected.kind === 'empty') {
    try {
      return fs.readdirSync(lockDir).length === 0;
    } catch {
      return false;
    }
  }
  return sameDiscoveredOwner(discoverOwner(lockDir), expected);
}

function removeAbandonedLock(lockDir, expected) {
  if (!expected || !currentAbandonedSnapshotMatches(lockDir, expected)) return false;

  if (expected.kind === 'valid') {
    if (!ownerIsProvablyDead(expected.owner)) return false;
  } else if (Date.now() - expected.identity.mtimeMs <= UNKNOWN_OWNER_STALE_MS) {
    return false;
  }

  // Reject replacements that happened after stale classification. The
  // tokenized unlink below also protects the final post-check ABA window.
  if (beforeAbandonedLockUnlinkForTesting) {
    beforeAbandonedLockUnlinkForTesting({ lockDir, expected });
  }

  if (!currentAbandonedSnapshotMatches(lockDir, expected)) return false;
  if (expected.kind === 'empty') {
    try {
      fs.rmdirSync(lockDir);
      return true;
    } catch (e) {
      return Boolean(e && e.code === 'ENOENT');
    }
  }

  try {
    // Tokenized owner paths are the deletion CAS. If a successor replaced the
    // stale directory after the final check, this exact old path is absent;
    // it can never resolve to the successor's different owner token.
    fs.unlinkSync(expected.ownerFile);
  } catch {
    return false;
  }
  const emptiedIdentity = readLockIdentity(lockDir);
  try {
    fs.rmdirSync(lockDir);
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return true;
    // If an unexpected directory entry prevented removal, restore the stale
    // owner marker when this is still the same directory. That keeps a later
    // safe recovery attempt possible instead of leaving an ownerless wedge.
    try {
      const after = readLockIdentity(lockDir);
      if (sameLockIdentity(after, emptiedIdentity) && fs.readdirSync(lockDir).length === 0) {
        fs.writeFileSync(expected.ownerFile, expected.contents, {
          mode: PRIVATE_FILE_MODE,
          flag: 'wx',
        });
      }
    } catch { /* the failed removal remains authoritative */ }
    return false;
  }
}

function abandonedLockSnapshot(lockDir) {
  const identity = readLockIdentity(lockDir);
  if (!identity) return null;
  const discovered = discoverOwner(lockDir);
  if (!discovered) {
    try {
      if (fs.readdirSync(lockDir).length !== 0) return null;
    } catch {
      return null;
    }
    if (Date.now() - identity.mtimeMs <= UNKNOWN_OWNER_STALE_MS) return null;
    return { kind: 'empty', identity };
  }
  if (discovered.kind === 'malformed') {
    if (Date.now() - identity.mtimeMs <= UNKNOWN_OWNER_STALE_MS) return null;
    return { ...discovered, identity };
  }
  const { owner } = discovered;
  if (!ownerIsProvablyDead(owner)) return null;
  return { ...discovered, identity };
}

function prepareOwnerFile(lockDir, token) {
  const preparedOwnerFile = `${lockDir}.owner.${token}.tmp`;
  const processStartIdentity = readProcessStartIdentity(process.pid);
  let descriptor = null;
  try {
    fs.writeFileSync(preparedOwnerFile, JSON.stringify({
      pid: process.pid,
      token,
      processStartIdentity,
    }), {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
      flag: 'wx',
    });
    descriptor = fs.openSync(preparedOwnerFile, 'r+');
    fs.fdatasyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    const owner = readOwner(preparedOwnerFile);
    if (
      !owner ||
      owner.token !== token ||
      owner.pid !== process.pid ||
      owner.processStartIdentity !== (processStartIdentity || '')
    ) {
      const err = new Error('failed to prepare canonical identity lock owner');
      err.code = 'CANONICAL_IDENTITY_LOCK_OWNER_INVALID';
      throw err;
    }
    return preparedOwnerFile;
  } catch (e) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* preparation error remains primary */ }
    }
    try { fs.unlinkSync(preparedOwnerFile); } catch { /* preparation error remains primary */ }
    throw e;
  }
}

function releaseCanonicalIdentityLock(lockDir, ownerFile, token) {
  const owner = readOwner(ownerFile);
  if (!owner || owner.token !== token) {
    const err = new Error('canonical identity lock ownership was lost');
    err.code = 'CANONICAL_IDENTITY_LOCK_LOST';
    throw err;
  }

  const releaseDir = `${lockDir}.release.${token}`;
  fs.renameSync(lockDir, releaseDir);
  const releaseOwnerFile = path.join(releaseDir, path.basename(ownerFile));
  const movedOwner = readOwner(releaseOwnerFile);
  if (!movedOwner || movedOwner.token !== token) {
    try { fs.renameSync(releaseDir, lockDir); } catch { /* ownership error remains primary */ }
    const err = new Error('canonical identity lock ownership was lost');
    err.code = 'CANONICAL_IDENTITY_LOCK_LOST';
    throw err;
  }
  fs.unlinkSync(releaseOwnerFile);
  fs.rmdirSync(releaseDir);
}

function acquireCanonicalIdentityLock(nodeIdFile) {
  const canonicalFile = path.resolve(nodeIdFile);
  const lockDir = `${canonicalFile}.tuple.lock`;
  const token = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  const ownerFile = path.join(lockDir, `owner.${token}.json`);
  const startedAt = Date.now();
  let preparedOwnerFile = null;

  fs.mkdirSync(path.dirname(canonicalFile), { recursive: true, mode: PRIVATE_DIR_MODE });
  preparedOwnerFile = prepareOwnerFile(lockDir, token);
  try {
    while (true) {
      try {
        fs.mkdirSync(lockDir, { mode: PRIVATE_DIR_MODE });
        try {
          fs.renameSync(preparedOwnerFile, ownerFile);
          preparedOwnerFile = null;
        } catch (e) {
          try { fs.rmdirSync(lockDir); } catch { /* publication error remains primary */ }
          throw e;
        }
        return function releaseLock() {
          releaseCanonicalIdentityLock(lockDir, ownerFile, token);
        };
      } catch (e) {
        if (!e || e.code !== 'EEXIST') throw e;
        const abandoned = abandonedLockSnapshot(lockDir);
        if (abandoned) {
          if (removeAbandonedLock(lockDir, abandoned)) continue;
        }
        if (Date.now() - startedAt > lockTimeoutMs) {
          const err = new Error('timed out waiting for canonical identity lock');
          err.code = 'CANONICAL_IDENTITY_LOCK_TIMEOUT';
          throw err;
        }
        sleepSync(lockWaitMs);
      }
    }
  } finally {
    if (preparedOwnerFile) {
      try { fs.unlinkSync(preparedOwnerFile); } catch { /* acquisition error remains primary */ }
    }
  }
}

function _setCanonicalIdentityLockTimingForTesting(options) {
  const next = options || {};
  lockWaitMs = Number.isFinite(next.waitMs) && next.waitMs >= 0
    ? Number(next.waitMs)
    : DEFAULT_LOCK_WAIT_MS;
  lockTimeoutMs = Number.isFinite(next.timeoutMs) && next.timeoutMs >= 0
    ? Number(next.timeoutMs)
    : DEFAULT_LOCK_TIMEOUT_MS;
}

function _resetCanonicalIdentityLockTimingForTesting() {
  lockWaitMs = DEFAULT_LOCK_WAIT_MS;
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS;
}

function _setBeforeAbandonedLockUnlinkForTesting(callback) {
  beforeAbandonedLockUnlinkForTesting = typeof callback === 'function' ? callback : null;
}

function _setProcessStartIdentityReaderForTesting(callback) {
  processStartIdentityReaderForTesting = typeof callback === 'function' ? callback : null;
}

/**
 * Run a synchronous canonical identity/credential operation under the shared
 * cross-process lock. Nested calls in the same process reuse the lock.
 *
 * @template T
 * @param {string} nodeIdFile
 * @param {() => T} operation
 * @returns {T}
 */
function withCanonicalIdentityLock(nodeIdFile, operation) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  const key = path.resolve(nodeIdFile);
  const held = heldLocks.get(key);
  if (held) {
    held.depth += 1;
    try {
      return operation();
    } finally {
      held.depth -= 1;
    }
  }

  const release = acquireCanonicalIdentityLock(key);
  heldLocks.set(key, { depth: 1 });
  try {
    return operation();
  } finally {
    heldLocks.delete(key);
    release();
  }
}

module.exports = {
  acquireCanonicalIdentityLock,
  withCanonicalIdentityLock,
  _setCanonicalIdentityLockTimingForTesting,
  _resetCanonicalIdentityLockTimingForTesting,
  _setBeforeAbandonedLockUnlinkForTesting,
  _setProcessStartIdentityReaderForTesting,
};
