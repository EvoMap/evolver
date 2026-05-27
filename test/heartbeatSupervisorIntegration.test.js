'use strict';

// Integration test: heartbeatSupervisor against the REAL (obfuscated)
// src/gep/a2aProtocol module. The unit tests in heartbeatSupervisor.test.js
// use a hand-rolled fake `a2a` that mirrors the production surface shape,
// but cannot verify the PR's load-bearing assumption:
//
//   "stopHeartbeat() + startHeartbeat() re-initialises the obfuscated
//    module's internal heartbeat cadence so a stuck-in-backoff loop
//    recovers after a wake event."
//
// This test wires the real module to a localhost stub hub, drives the
// supervisor through (1) startup + hello, (2) a poke that should produce
// a hub-visible heartbeat, (3) a simulated sleep/wake via _driftTick, and
// (4) a post-restart poke that must again produce a hub-visible
// heartbeat. If the obfuscated module's startHeartbeat were a no-op
// after a prior stopHeartbeat (the unverified failure mode the audit
// flagged), step (4) would observe totalSent unchanged and fail.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'evomap-int-hb-'));
// Isolate persistent state (node_id file, mailbox etc.) per-run.
process.env.EVOLVER_HOME = tmpHome;
process.env.EVOMAP_HUB_ALLOW_INSECURE = '1';
// The obfuscated module REQUIRES a 64-hex secret to talk to a non-HTTPS
// hub; set one upfront so the hello path doesn't bail.
process.env.A2A_NODE_SECRET = 'a'.repeat(64);

let server;
let port;
let hits;
let respondWithStatus = 200;

function startStubHub() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        hits.push({ method: req.method, url: req.url, status: respondWithStatus });
        if (respondWithStatus >= 500) {
          res.writeHead(respondWithStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'hub_down' }));
          return;
        }
        if (req.url === '/a2a/hello') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ payload: { node_secret: 'b'.repeat(64) } }));
        } else if (req.url === '/a2a/heartbeat') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      process.env.A2A_HUB_URL = `http://127.0.0.1:${port}`;
      resolve();
    });
    server.once('error', reject);
  });
}

test.before(async () => {
  hits = [];
  await startStubHub();
});

test.after(async () => {
  if (server) {
    await new Promise((r) => server.close(() => r()));
  }
});

test('integration: supervisor + real a2aProtocol survives a simulated sleep/wake and resumes sending', async () => {
  // Require AFTER env vars are set. The obfuscated module reads
  // A2A_HUB_URL at require time (via getHubUrl()).
  const a2a = require('../src/gep/a2aProtocol');
  const supervisor = require('../src/gep/heartbeatSupervisor');

  // Defensive reset (singleton across require()).
  supervisor._resetForTesting();
  hits.length = 0;

  // Inject a fake clock so we can drive _driftTick with a "wall-clock
  // jump" without actually waiting an hour. The real timers (setInterval
  // inside the obfuscated module's own loop) keep using Date.now() so
  // their cadence is unaffected -- they just don't fire within this
  // test's lifetime (default cadence is multi-minute).
  let now = Date.now();
  const nowFn = () => now;

  let handles;
  try {
    handles = supervisor.start(a2a, { nowFn });

    // -- Step 1: startup. Wait for /a2a/hello to be registered. --
    const helloDeadline = Date.now() + 3000;
    while (Date.now() < helloDeadline && !hits.some((h) => h.url === '/a2a/hello')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(
      hits.some((h) => h.url === '/a2a/hello'),
      `expected /a2a/hello on startup, got ${JSON.stringify(hits)}`,
    );

    const startedStats = a2a.getHeartbeatStats();
    assert.equal(startedStats.running, true, 'obfuscated loop must be running after startup');

    // -- Step 2: first poke -> hub-visible heartbeat. --
    const sentBefore = startedStats.totalSent;
    const okPoke1 = supervisor.poke('integration-step2', { nowFn });
    assert.equal(okPoke1, true, 'first poke must report a committed send');

    // Wait for the async sendHeartbeat to complete and the hub to record it.
    const hb1Deadline = Date.now() + 3000;
    while (
      Date.now() < hb1Deadline
      && hits.filter((h) => h.url === '/a2a/heartbeat').length < 1
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const hbCountAfterPoke = hits.filter((h) => h.url === '/a2a/heartbeat').length;
    assert.ok(
      hbCountAfterPoke >= 1,
      `poke must produce a hub-visible /a2a/heartbeat (got ${hbCountAfterPoke})`,
    );
    const statsAfterPoke = a2a.getHeartbeatStats();
    assert.ok(
      statsAfterPoke.totalSent > sentBefore,
      `totalSent must advance on poke (before=${sentBefore}, after=${statsAfterPoke.totalSent})`,
    );

    // -- Step 3: simulated sleep/wake via _driftTick. --
    // Advance the supervisor's wall-clock by 1 hour. The drift detector,
    // which keys off (now - _lastDriftSampleAt), must see a > 90s gap
    // and call _hardRestart (stop+start) on the obfuscated module.
    const stopBefore = statsAfterPoke.totalSent; // monotonic, just for sanity
    now += 60 * 60 * 1000; // 1 hour
    handles._driftTick();

    // The obfuscated module's startHeartbeat resets uptimeMs to 0 (we
    // verified this in the live probe before writing this test). Use
    // that as a behavioral proof that stop+start actually re-initialised
    // the internal cadence -- if stop+start were no-ops, uptimeMs would
    // be ~1h or more by now.
    const postDriftStats = a2a.getHeartbeatStats();
    assert.equal(
      postDriftStats.running, true,
      'after stop+start, the loop must be re-armed and running',
    );
    assert.ok(
      postDriftStats.uptimeMs < 5_000,
      `uptimeMs must reset on stop+start (got ${postDriftStats.uptimeMs}ms -- ` +
        'either stop+start is a no-op or the obfuscated module is broken)',
    );

    // -- Step 4: post-restart poke must drive ANOTHER hub-visible
    //    heartbeat. This is the actual user-recovery proof. --
    // Advance "now" past the throttle window so the poke is allowed
    // through. (POKE_THROTTLE_MS = 60s.)
    now += supervisor.POKE_THROTTLE_MS + 5_000;
    const hbCountBeforeStep4 = hits.filter((h) => h.url === '/a2a/heartbeat').length;
    const okPoke2 = supervisor.poke('integration-step4', { nowFn });
    assert.equal(okPoke2, true, 'post-restart poke must commit a send');

    const hb2Deadline = Date.now() + 3000;
    while (
      Date.now() < hb2Deadline
      && hits.filter((h) => h.url === '/a2a/heartbeat').length <= hbCountBeforeStep4
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const hbCountAfterStep4 = hits.filter((h) => h.url === '/a2a/heartbeat').length;
    assert.ok(
      hbCountAfterStep4 > hbCountBeforeStep4,
      `post-restart poke must produce a NEW /a2a/heartbeat hub hit ` +
        `(before=${hbCountBeforeStep4}, after=${hbCountAfterStep4}). If this ` +
        'fails, the recovery story in the PR is unverified -- ' +
        'stop+start does NOT actually re-arm the obfuscated module.',
    );

    const finalStats = a2a.getHeartbeatStats();
    assert.ok(
      finalStats.totalSent > stopBefore,
      `totalSent must advance after the recovery poke (was ${stopBefore}, now ${finalStats.totalSent})`,
    );
  } finally {
    supervisor.stop();
  }
});

test('integration: obfuscated module totalSent counts ATTEMPTS, not successes (documents wedge semantics)', async () => {
  // CRITICAL DOCUMENTATION TEST. The supervisor's _livenessTick wedge
  // gate keys off totalSent. The naming suggests "successful sends"
  // but production behavior (verified here) is "send ATTEMPTS that
  // completed an HTTP round-trip, regardless of status code". A 503
  // response still increments totalSent.
  //
  // Practical implication for the wedge detector:
  //
  //   - It catches "loop has stopped attempting" cleanly (totalSent
  //     stops advancing).
  //
  //   - It catches "loop is in a long backoff" where the interval
  //     between attempts exceeds WEDGE_THRESHOLD_MS (15 min). The
  //     obfuscated module's documented 30-min backoff cap means a
  //     stuck-in-backoff loop spends 15 min with no progress before
  //     the wedge fires -- a bounded recovery time.
  //
  //   - It does NOT catch "loop attempts every minute and the hub
  //     returns 503 on every attempt". In that mode the user-perceived
  //     symptom is the same ("no heartbeat reaches the hub") but the
  //     supervisor cannot tell from outside that the attempts are
  //     all failing. This is a known limitation; recovery in that
  //     case depends on the hub coming back, not on the supervisor.
  //
  // If this test ever changes (totalSent becomes "successful sends
  // only"), the wedge threshold should be reconsidered.
  const a2a = require('../src/gep/a2aProtocol');
  const supervisor = require('../src/gep/heartbeatSupervisor');

  supervisor._resetForTesting();
  hits.length = 0;
  respondWithStatus = 503; // hub is down

  let now = Date.now();
  try {
    supervisor.start(a2a, { nowFn: () => now });
    await new Promise((r) => setTimeout(r, 200));

    const sentBefore = a2a.getHeartbeatStats().totalSent;

    // Direct send against a 503 hub.
    try { await a2a.sendHeartbeat(); } catch { /* tolerated */ }

    const sentAfter = a2a.getHeartbeatStats().totalSent;
    assert.ok(
      sentAfter > sentBefore,
      `production behavior: totalSent advances on send attempts EVEN when ` +
        `the hub returns an error (before=${sentBefore}, after=${sentAfter}). ` +
        'If this assertion ever flips, the wedge semantics change too.',
    );
  } finally {
    supervisor.stop();
    respondWithStatus = 200;
  }
});
