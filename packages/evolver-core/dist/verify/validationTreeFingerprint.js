import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { trustedValidationRuntime } from './trustedValidationRuntime.js';
const CEILINGS = {
    timeoutMs: 5000,
    maxEntries: 100_000,
    maxDepth: 128,
    maxPathBytes: 32_768,
    maxFileBytes: 256 * 1024 * 1024,
    maxTotalBytes: 1024 * 1024 * 1024,
    maxRecordBytes: 16 * 1024 * 1024,
};
// Fixed trusted code, never interpolated with paths or file contents. A separate
// process owns every untrusted filesystem operation, including enumeration, so
// the synchronous compatibility API has a killable deadline and bounded retained
// application buffers. Node also enforces a V8 heap limit; Bun/JSC does not claim
// that extra guarantee. Neither mode is an immutable snapshot/security boundary.
const FINGERPRINT_WORKER = String.raw `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const limits = JSON.parse(process.argv[2]);
const constants = fs.constants;
const opened = new Set();
const directories = new Set();
const records = Buffer.alloc(Math.min(limits.maxRecordBytes, limits.maxEntries * 32));
const stack = [];
const buffer = Buffer.alloc(65536);
const slash = Buffer.from(path.sep);
const started = Date.now();
let totalBytes = 0;
let entries = 0;
let failure;
let fingerprint;

const fail = code => { const error = new Error(code); error.fingerprintCode = code; throw error; };
const tick = () => { if (Date.now() - started >= limits.timeoutMs) fail('timeout'); };
const same = (a, b) => ['dev','ino','mode','size','nlink','mtimeNs','ctimeNs','rdev'].every(key => a[key] === b[key]);
const state = target => fs.lstatSync(target, { bigint: true });
const joinBytes = (parent, name) => Buffer.concat([parent, slash, name]);
const fileFlags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
const directoryFlags = fileFlags | (constants.O_DIRECTORY || 0);
const anchored = process.platform === 'linux' && fs.existsSync('/proc/self/fd');

function checkParents() {
  // Linux entry operations start at pinned directory descriptors. On other
  // platforms retain/check every parent identity, and fail on observed races;
  // this deliberately does not claim a portable atomic filesystem snapshot.
  for (const parent of stack) {
    if (!same(parent.before, fs.fstatSync(parent.fd, { bigint: true }))
      || !same(parent.before, state(parent.actual))) fail('changed');
  }
}

function record(relative, kind, mode, detail = '') {
  tick();
  if (++entries > limits.maxEntries) fail('limit_entries');
  if (relative.length > limits.maxPathBytes) fail('limit_path');
  // JSON array framing and byte-preserving hex paths/links make boundaries
  // unambiguous, including invalid UTF-8 names on POSIX. Only fixed-size digests
  // remain in one fixed-size buffer, without an object per entry. Sorted digests
  // remove dependence on readdir ordering.
  const encoded = JSON.stringify([relative.toString('hex'), kind, Number(mode & 0o7777n), detail]);
  if (entries * 32 > records.length) fail('limit_record_bytes');
  createHash('sha256').update(encoded).digest().copy(records, (entries - 1) * 32);
}

function compare(left, right) {
  const a = left * 32;
  const b = right * 32;
  for (let offset = 0; offset < 32; offset++) {
    const difference = records[a + offset] - records[b + offset];
    if (difference) return difference;
  }
  return 0;
}

function swap(left, right) {
  const a = left * 32;
  const b = right * 32;
  for (let offset = 0; offset < 32; offset++) {
    const temporary = records[a + offset];
    records[a + offset] = records[b + offset];
    records[b + offset] = temporary;
  }
}

function sift(start, end) {
  let parent = start;
  while (parent * 2 + 1 <= end) {
    tick();
    let child = parent * 2 + 1;
    if (child + 1 <= end && compare(child, child + 1) < 0) child++;
    if (compare(parent, child) >= 0) return;
    swap(parent, child);
    parent = child;
  }
}

function sortRecords() {
  for (let start = Math.floor(entries / 2) - 1; start >= 0; start--) sift(start, entries - 1);
  for (let end = entries - 1; end > 0; end--) { tick(); swap(0, end); sift(0, end - 1); }
}

function openDirectory(actual, relative, before, depth) {
  tick();
  if (depth > limits.maxDepth) fail('limit_depth');
  if (relative.length > limits.maxPathBytes) fail('limit_path');
  checkParents();
  const fd = fs.openSync(actual, directoryFlags);
  opened.add(fd);
  const current = fs.fstatSync(fd, { bigint: true });
  if (!current.isDirectory() || !same(before, current)) fail('changed');
  checkParents();
  const access = anchored ? Buffer.from('/proc/self/fd/' + fd) : actual;
  const directory = fs.opendirSync(access, { encoding: 'buffer', bufferSize: 32 });
  directories.add(directory);
  stack.push({ actual, relative, before, fd, access, directory, depth });
  record(relative, 'directory', before.mode);
}

function readFile(actual, before) {
  if (before.size < 0n || before.size > BigInt(limits.maxFileBytes)) fail('limit_file_bytes');
  if (before.size > BigInt(limits.maxTotalBytes - totalBytes)) fail('limit_total_bytes');
  checkParents();
  const fd = fs.openSync(actual, fileFlags);
  opened.add(fd);
  try {
    const first = fs.fstatSync(fd, { bigint: true });
    if (!first.isFile() || !same(before, first)) fail('changed');
    checkParents();
    const hash = createHash('sha256');
    const size = Number(first.size);
    let offset = 0;
    while (offset < size) {
      tick();
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (count <= 0) fail('changed');
      totalBytes += count;
      if (totalBytes > limits.maxTotalBytes) fail('limit_total_bytes');
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    // Regular proc-like files can report zero size while yielding data. Refuse
    // them rather than fingerprinting an invented empty body.
    if (fs.readSync(fd, buffer, 0, 1, offset) !== 0) fail('changed');
    if (!same(first, fs.fstatSync(fd, { bigint: true })) || !same(first, state(actual))) fail('changed');
    checkParents();
    return hash.digest('hex');
  } finally {
    opened.delete(fd);
    fs.closeSync(fd);
  }
}

try {
  const root = fs.realpathSync(process.argv[1], { encoding: 'buffer' });
  const rootState = state(root);
  if (!rootState.isDirectory()) fail('invalid_root');
  openDirectory(root, Buffer.alloc(0), rootState, 0);
  while (stack.length) {
    tick();
    const parent = stack[stack.length - 1];
    const entry = parent.directory.readSync();
    if (entry === null) {
      checkParents();
      directories.delete(parent.directory);
      parent.directory.closeSync();
      opened.delete(parent.fd);
      fs.closeSync(parent.fd);
      stack.pop();
      continue;
    }
    if (entries >= limits.maxEntries) fail('limit_entries');
    if ((entries + 1) * 32 > records.length) fail('limit_record_bytes');
    // Node returns a Dirent, while Bun 1.3 returns the raw byte name when the
    // directory encoding is buffer. Metadata always comes from lstat below.
    const rawName = entry.name ?? entry;
    const name = Buffer.isBuffer(rawName) ? rawName
      : ArrayBuffer.isView(rawName) ? Buffer.from(rawName.buffer, rawName.byteOffset, rawName.byteLength)
        : typeof rawName === 'string' ? Buffer.from(rawName) : fail('io_failed');
    const relative = parent.relative.length ? joinBytes(parent.relative, name) : name;
    if (relative.length > limits.maxPathBytes) fail('limit_path');
    const actual = joinBytes(parent.access, name);
    checkParents();
    const before = state(actual);
    if (before.isDirectory()) {
      openDirectory(actual, relative, before, parent.depth + 1);
    } else if (before.isSymbolicLink()) {
      const target = fs.readlinkSync(actual, { encoding: 'buffer' });
      if (target.length > limits.maxPathBytes) fail('limit_path');
      if (!same(before, state(actual))) fail('changed');
      checkParents();
      record(relative, 'symlink', before.mode, target.toString('hex'));
    } else if (before.isFile()) {
      record(relative, 'file', before.mode, readFile(actual, before));
    } else {
      const kind = before.isFIFO() ? 'fifo' : before.isSocket() ? 'socket'
        : before.isBlockDevice() ? 'block-device' : before.isCharacterDevice() ? 'character-device' : 'special';
      if (!same(before, state(actual))) fail('changed');
      checkParents();
      record(relative, kind, before.mode, before.rdev.toString());
    }
  }
  tick();
  sortRecords();
  const digest = createHash('sha256').update('evolver-validation-tree-v2\0' + entries + ':');
  digest.update(records.subarray(0, entries * 32));
  tick();
  fingerprint = digest.digest('hex');
} catch (error) {
  failure = typeof error.fingerprintCode === 'string' ? error.fingerprintCode : 'io_failed';
} finally {
  // No fixture or source paths are removed. Child exit also closes all handles,
  // including on SIGKILL; cleanup errors cannot become a successful receipt.
  for (const directory of directories) { try { directory.closeSync(); } catch { failure = 'cleanup_failed'; } }
  for (const fd of opened) { try { fs.closeSync(fd); } catch { failure = 'cleanup_failed'; } }
}
if (failure) {
  process.stdout.write(JSON.stringify({ ok: false, code: failure }));
  process.exitCode = 1;
} else process.stdout.write(JSON.stringify({ ok: true, digest: fingerprint }));
`;
const FAILURE_CODES = new Set([
    'timeout', 'invalid_root', 'changed', 'io_failed', 'cleanup_failed',
    'limit_entries', 'limit_depth', 'limit_path', 'limit_file_bytes', 'limit_total_bytes', 'limit_record_bytes',
]);
function fingerprintFailure(code) {
    return new Error(`validation_tree_fingerprint_${code}`);
}
/** Internal test seam: overrides can tighten, never increase, the production ceilings. */
export function fingerprintTreeWithLimits(root, overrides = {}) {
    if (typeof root !== 'string' || root.length === 0 || root.length > CEILINGS.maxPathBytes || root.includes('\0')) {
        throw fingerprintFailure('invalid_root');
    }
    const limits = { ...CEILINGS };
    for (const key of Object.keys(CEILINGS)) {
        limits[key] = overrides[key] ?? CEILINGS[key];
        if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > CEILINGS[key]) {
            throw fingerprintFailure('invalid_limits');
        }
    }
    const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
    let runtime;
    let result;
    let cleanupFailed = false;
    try {
        runtime = trustedValidationRuntime(FINGERPRINT_WORKER, [resolve(root), JSON.stringify(limits)], {
            nodeArgs: ['--max-old-space-size=64', '--max-semi-space-size=4', '--stack-size=256', '--input-type=commonjs'],
        });
        result = spawnSync(runtime.cmd, runtime.args, {
            shell: false,
            windowsHide: true,
            env: { ...(systemRoot ? { SystemRoot: systemRoot } : {}), ...runtime.env },
            cwd: runtime.cwd,
            timeout: limits.timeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: 4096,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    }
    catch { /* Return a bounded diagnostic rather than a raw spawn/runtime path. */ }
    finally {
        try {
            runtime?.cleanup();
        }
        catch {
            cleanupFailed = true;
        }
    }
    if (cleanupFailed)
        throw fingerprintFailure('cleanup_failed');
    if (!result)
        throw fingerprintFailure('worker_failed');
    if (result.error) {
        throw fingerprintFailure(result.error.code === 'ETIMEDOUT' ? 'timeout' : 'worker_failed');
    }
    let response;
    try {
        response = JSON.parse(result.stdout);
    }
    catch {
        throw fingerprintFailure('worker_failed');
    }
    if (result.status === 0 && response.ok === true && typeof response.digest === 'string' && /^[a-f0-9]{64}$/.test(response.digest)) {
        return response.digest;
    }
    throw fingerprintFailure(typeof response.code === 'string' && FAILURE_CODES.has(response.code) ? response.code : 'worker_failed');
}
/** Bounded synchronous compatibility API. Execution containment must not depend on a fingerprint. */
export function treeFingerprint(root) {
    return fingerprintTreeWithLimits(root);
}