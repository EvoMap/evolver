'use strict';

// Local IPC poke channel between evolver subcommands and a running daemon.
//
// Problem this exists to fix (#548 third-pass X1, agent 8):
//
//   The original bug report was that after the daemon (`evolver --loop`
//   or `evolver webui`) has been idle for a while, the heartbeat is dead
//   and "no matter what the user does" it does not recover. The PR's
//   in-process recovery primitives (drift detector, supervisor poke,
//   activity wires on the HTTP server) all fire only when something
//   reaches the daemon's process: either an OS-suspend event hits the
//   wall-clock drift detector, or an HTTP request arrives on the daemon's
//   own port. Neither happens when the user simply runs
//
//       evolver run        # terminal B, while daemon is still in terminal A
//
//   The subcommand is a separate process; it does not talk to the daemon.
//   So the daemon never sees the user's activity, and the heartbeat
//   stays in whatever wedge it was in.
//
// Design:
//
//   - The daemon (whichever long-running mode is active: --loop default,
//     --loop proxy, or webui) listens on a unix socket at a per-user
//     path under the existing ~/.evomap state directory.
//   - Every short-lived evolver subcommand attempts a best-effort connect
//     to that socket at the top of main() and writes a one-line JSON
//     poke. The daemon's handler calls into whichever lifecycle / supervisor
//     happens to be active and forwards the poke.
//   - On any error -- no daemon, refused, stale socket, timeout -- the
//     client returns silently. The subcommand must not fail because the
//     daemon happens not to be running.
//
// Cross-platform:
//
//   Unix domain sockets work on macOS and Linux. On Windows we use a
//   named pipe path; Node's net module handles both transparently when
//   the path is set up correctly. If the platform is unsupported, the
//   helpers short-circuit to no-ops.
//
// Concurrency / staleness:
//
//   If a previous daemon process crashed without unlinking the socket
//   file, a fresh start() will see EADDRINUSE. We probe the existing
//   socket with a short-timeout connect; if it refuses (ECONNREFUSED)
//   the socket file is stale and we unlink it before re-binding. If it
//   accepts, another daemon is already running and we do NOT bind --
//   start() returns null so the caller can decide whether that's a
//   problem.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const PROBE_TIMEOUT_MS = 250;
const CLIENT_CONNECT_TIMEOUT_MS = 500;
const CLIENT_WRITE_TIMEOUT_MS = 500;
const POKE_MAX_BYTES = 4096;

function isSupportedPlatform() {
  // Named pipes on Windows work via net.createServer too, but the path
  // shape (\\.\pipe\name) and lifecycle semantics differ. Until we
  // explicitly test that path, restrict to unix-like platforms where
  // domain sockets are first-class.
  return process.platform !== 'win32';
}

function defaultSocketPath() {
  // Match the existing ~/.evomap/mailbox/state.json convention so the
  // poke socket lives next to the state it nominally relates to.
  const home = os.homedir() || os.tmpdir();
  return path.join(home, '.evomap', 'poke.sock');
}

function _ensureParentDir(p) {
  const dir = path.dirname(p);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) { /* best effort */ }
}

// Probe an existing socket file; returns 'alive' if a server accepts the
// connection, 'stale' if it refuses or errors out, or 'missing' if no
// file is present. Resolves within PROBE_TIMEOUT_MS regardless of OS.
function _probeExistingSocket(socketPath) {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(socketPath)) return resolve('missing');
    } catch { return resolve('missing'); }

    const sock = net.createConnection(socketPath);
    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_e) { /* noop */ }
      resolve(verdict);
    };
    const timer = setTimeout(() => finish('alive'), PROBE_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    sock.once('connect', () => { clearTimeout(timer); finish('alive'); });
    sock.once('error', () => { clearTimeout(timer); finish('stale'); });
  });
}

// Start the daemon-side server. Returns a handle { socketPath, stop }
// on success, null when another daemon already owns the socket (caller
// decides whether to log / continue / bail), and throws only on
// truly unexpected fs errors.
//
// `onPoke(reason)` is invoked once per incoming poke. It must never
// throw (we catch defensively here too, but uphold the contract).
async function startLocalPokeServer({ onPoke, logger, socketPath } = {}) {
  if (!isSupportedPlatform()) {
    if (logger && logger.log) logger.log('[localPoke] platform unsupported; skipping server');
    return null;
  }

  const sockPath = socketPath || defaultSocketPath();
  _ensureParentDir(sockPath);

  // Reclaim a stale socket if the previous daemon crashed without
  // unlinking it. If another daemon is alive, do NOT clobber its
  // socket -- return null so the caller can act.
  const probe = await _probeExistingSocket(sockPath);
  if (probe === 'alive') {
    if (logger && logger.warn) {
      logger.warn(`[localPoke] socket ${sockPath} is already owned by another daemon; skipping server`);
    }
    return null;
  }
  if (probe === 'stale') {
    try { fs.unlinkSync(sockPath); } catch (_e) { /* noop */ }
  }

  const handler = typeof onPoke === 'function' ? onPoke : () => {};

  const server = net.createServer((socket) => {
    let buf = '';
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      try { socket.end(); } catch (_e) { /* noop */ }
      try { socket.destroy(); } catch (_e) { /* noop */ }
    };
    // Defensive byte cap so a malicious or buggy client can't OOM us.
    socket.on('data', (chunk) => {
      if (closed) return;
      buf += chunk.toString('utf8');
      if (buf.length > POKE_MAX_BYTES) {
        finish();
        return;
      }
      const newlineIdx = buf.indexOf('\n');
      if (newlineIdx === -1) return;
      const line = buf.slice(0, newlineIdx);
      buf = buf.slice(newlineIdx + 1);
      let reason = 'ipc';
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.reason === 'string' && obj.reason.length <= 64) {
          reason = obj.reason;
        }
      } catch (_e) { /* tolerate non-JSON; still treat as poke */ }
      try { handler(reason); } catch (e) {
        if (logger && logger.warn) {
          logger.warn('[localPoke] onPoke threw: ' + (e && e.message || e));
        }
      }
      finish();
    });
    // Don't keep the daemon alive on an idle client socket. The data
    // handler closes after one line; this is just a backstop.
    socket.on('error', () => finish());
    const idle = setTimeout(finish, 2_000);
    if (idle && typeof idle.unref === 'function') idle.unref();
    socket.on('close', () => clearTimeout(idle));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // Lock down the socket so other users on the host cannot poke our
  // daemon. macOS / Linux semantics: 0600 (owner-only) is appropriate
  // here, mirroring the state.json convention.
  try { fs.chmodSync(sockPath, 0o600); } catch (_e) { /* best effort */ }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { server.close(); } catch (_e) { /* noop */ }
    try { fs.unlinkSync(sockPath); } catch (_e) { /* noop */ }
  };

  // Best-effort cleanup on process exit. We don't override existing
  // SIGINT/SIGTERM handlers; the 'exit' event runs after them.
  process.on('exit', stop);

  return { socketPath: sockPath, stop };
}

// Client side: connect, write one line of JSON, close. Resolves with
// `true` if the poke was delivered, `false` otherwise. Never rejects,
// never throws -- subcommand callsites must not be tied to whether a
// daemon happens to be listening.
function pokeLocalDaemonBestEffort({ reason, socketPath, timeoutMs } = {}) {
  if (!isSupportedPlatform()) return Promise.resolve(false);
  const sockPath = socketPath || defaultSocketPath();
  const connectMs = (typeof timeoutMs === 'number' && timeoutMs > 0)
    ? timeoutMs
    : CLIENT_CONNECT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_e) { /* noop */ }
      clearTimeout(connectTimer);
      clearTimeout(writeTimer);
      resolve(!!ok);
    };

    // Pre-check: if the file is missing, no daemon to poke. Cheap fast-
    // path that avoids the connect error roundtrip in the common case.
    try { if (!fs.existsSync(sockPath)) return resolve(false); } catch { return resolve(false); }

    const sock = net.createConnection(sockPath);
    const connectTimer = setTimeout(() => finish(false), connectMs);
    if (connectTimer && typeof connectTimer.unref === 'function') connectTimer.unref();

    let writeTimer = null;
    sock.once('error', () => finish(false));
    sock.once('connect', () => {
      clearTimeout(connectTimer);
      const payload = JSON.stringify({
        reason: (typeof reason === 'string' && reason.length <= 64) ? reason : 'cli',
      }) + '\n';
      writeTimer = setTimeout(() => finish(false), CLIENT_WRITE_TIMEOUT_MS);
      if (writeTimer && typeof writeTimer.unref === 'function') writeTimer.unref();
      sock.write(payload, () => finish(true));
    });
  });
}

module.exports = {
  startLocalPokeServer,
  pokeLocalDaemonBestEffort,
  defaultSocketPath,
  isSupportedPlatform,
};
