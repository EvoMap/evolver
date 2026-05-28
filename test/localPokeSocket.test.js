'use strict';

// Tests for src/ops/localPokeSocket.js (#548 third-pass X1).
//
// What this pins down:
//   - Server binds at a fresh path and accepts a poke
//   - Stale socket file (from a crashed prior daemon) is reclaimed
//   - Live socket file (another daemon is up) is NOT clobbered;
//     start() returns null instead
//   - Client poke is best-effort: missing socket returns false without throwing
//   - The reason string is propagated through to the handler

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const {
  startLocalPokeServer,
  pokeLocalDaemonBestEffort,
  isSupportedPlatform,
} = require('../src/ops/localPokeSocket');

function tmpSocketPath(label) {
  return path.join(os.tmpdir(), `evolver-poke-test-${label}-${process.pid}-${Date.now()}.sock`);
}

function silentLogger() {
  return { log: () => {}, warn: () => {}, error: () => {} };
}

// Skip the whole suite on platforms where the helper is a no-op.
const skipReason = isSupportedPlatform() ? null : 'unix domain sockets unsupported on this platform';

test('server: binds, accepts a poke, calls handler with the reason', skipReason ? { skip: skipReason } : {}, async () => {
  const sockPath = tmpSocketPath('basic');
  let received = null;
  const handle = await startLocalPokeServer({
    onPoke: (reason) => { received = reason; },
    logger: silentLogger(),
    socketPath: sockPath,
  });
  assert.ok(handle, 'server must start when path is fresh');
  assert.equal(handle.socketPath, sockPath);

  const ok = await pokeLocalDaemonBestEffort({ reason: 'fetch', socketPath: sockPath });
  assert.equal(ok, true, 'client poke must report success');

  // Handler runs on a separate event-loop turn; wait one tick.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(received, 'fetch', 'handler must receive the reason from the client');

  handle.stop();
  // After stop the socket file must be unlinked.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fs.existsSync(sockPath), false, 'socket file must be unlinked on stop');
});

test('client: missing socket returns false silently', skipReason ? { skip: skipReason } : {}, async () => {
  const sockPath = tmpSocketPath('missing');
  // Ensure clean state.
  try { fs.unlinkSync(sockPath); } catch {}
  const ok = await pokeLocalDaemonBestEffort({ reason: 'cli', socketPath: sockPath });
  assert.equal(ok, false, 'missing socket must return false (no throw)');
});

test('server: reclaims a stale socket file from a crashed prior daemon', skipReason ? { skip: skipReason } : {}, async () => {
  const sockPath = tmpSocketPath('stale');
  // Simulate a stale socket file. Write an empty file that has no listener.
  fs.writeFileSync(sockPath, '');
  assert.equal(fs.existsSync(sockPath), true);

  const handle = await startLocalPokeServer({
    onPoke: () => {},
    logger: silentLogger(),
    socketPath: sockPath,
  });
  assert.ok(handle, 'server must reclaim a stale socket file');

  const ok = await pokeLocalDaemonBestEffort({ reason: 'r', socketPath: sockPath });
  assert.equal(ok, true);
  handle.stop();
});

test('server: refuses to clobber a live socket owned by another daemon', skipReason ? { skip: skipReason } : {}, async () => {
  const sockPath = tmpSocketPath('live');
  // Stand up a stub server that owns the path.
  const stubServer = net.createServer(() => {});
  await new Promise((resolve, reject) => {
    stubServer.once('error', reject);
    stubServer.listen(sockPath, () => {
      stubServer.removeListener('error', reject);
      resolve();
    });
  });

  try {
    const handle = await startLocalPokeServer({
      onPoke: () => {},
      logger: silentLogger(),
      socketPath: sockPath,
    });
    assert.equal(handle, null, 'second daemon must not clobber a live socket');
  } finally {
    stubServer.close();
    try { fs.unlinkSync(sockPath); } catch {}
  }
});

test('client: invalid reason is replaced with default; daemon does not crash on garbage payload', skipReason ? { skip: skipReason } : {}, async () => {
  const sockPath = tmpSocketPath('garbage');
  let received = null;
  const handle = await startLocalPokeServer({
    onPoke: (reason) => { received = reason; },
    logger: silentLogger(),
    socketPath: sockPath,
  });
  assert.ok(handle);

  // Connect manually and send garbage; verify the server tolerates it
  // and still invokes onPoke (defaults to 'ipc').
  await new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath);
    sock.once('connect', () => {
      sock.write('this is not json\n');
      sock.end();
    });
    sock.once('error', reject);
    sock.once('close', resolve);
  });

  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(received, 'ipc', 'non-JSON payload must fall back to default reason');

  handle.stop();
});
