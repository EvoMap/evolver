'use strict';

// Global crash guards for any long-running evolver mode (--loop, proxy,
// webui). Hoisted out of index.js so the wiring is testable in isolation
// AND so every mode shares the same semantics. Previously only --loop
// installed these handlers, so proxy / webui daemons silently exited on
// any exception that escaped the heartbeat try/catch (F1).
//
// Semantics:
//   - uncaughtException: log FATAL with stack, best-effort release any
//     lock the process holds, exit 1.
//   - unhandledRejection: cluster gate. An idle daemon accumulates
//     harmless rejections (transient hub blips, libuv quirks) over weeks.
//     Only exit when REJECTION_THRESHOLD rejections cluster inside
//     REJECTION_WINDOW_MS. A single noisy rejection logs and continues.
//
// Install once per process; subsequent calls are no-ops.

const REJECTION_WINDOW_MS = 5 * 60 * 1000;
const REJECTION_THRESHOLD = 5;

let _installed = false;

function installCrashGuards({ releaseLock } = {}) {
  if (_installed) return false;
  _installed = true;
  const safeReleaseLock = () => {
    if (typeof releaseLock === 'function') {
      try { releaseLock(); } catch (_) { /* never throw out of a fatal handler */ }
    }
  };
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err && err.stack ? err.stack : String(err));
    safeReleaseLock();
    process.exit(1);
  });
  let _rejectionTimestamps = [];
  process.on('unhandledRejection', (reason) => {
    const now = Date.now();
    _rejectionTimestamps.push(now);
    _rejectionTimestamps = _rejectionTimestamps.filter((t) => now - t < REJECTION_WINDOW_MS);
    console.error(
      '[FATAL] Unhandled promise rejection (' + _rejectionTimestamps.length + ' in window):',
      reason && reason.stack ? reason.stack : String(reason),
    );
    if (_rejectionTimestamps.length >= REJECTION_THRESHOLD) {
      console.error(
        '[FATAL] ' + _rejectionTimestamps.length + ' unhandled rejections within '
          + (REJECTION_WINDOW_MS / 1000) + 's. Exiting to avoid corrupt state.',
      );
      safeReleaseLock();
      process.exit(1);
    }
  });
  return true;
}

// Test-only: reset the install latch. Production callers never need this.
function _resetForTesting() {
  _installed = false;
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
}

module.exports = {
  installCrashGuards,
  REJECTION_WINDOW_MS,
  REJECTION_THRESHOLD,
  _resetForTesting,
};
