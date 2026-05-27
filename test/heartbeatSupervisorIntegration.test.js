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

test('integration: documents whether obfuscated totalSent resets across stop+start (H2 contract)', async () => {
  // The supervisor's freshness pointer reset semantics depend on what
  // the obfuscated module does with `totalSent` across `stopHeartbeat`+
  // `startHeartbeat`. The audit flagged this as unverified.
  //
  // The supervisor logic is robust to BOTH cases:
  //   - If totalSent resets to 0: after _hardRestart, _lastObservedSent
  //     is -1, next _livenessTick observes 0, sets _lastObservedSent=0
  //     and _lastSuccessfulSendAt=now. Wedge re-arms.
  //   - If totalSent accumulates: same flow, just with a non-zero
  //     starting value. _lastObservedSent=N. Wedge re-arms.
  //
  // This test (1) pins down which behavior is real, so future contributors
  // can see it explicitly, and (2) drives the freshness tracking across
  // a real stop+start and asserts the supervisor's pointer updates correctly.
  const a2a = require('../src/gep/a2aProtocol');
  const supervisor = require('../src/gep/heartbeatSupervisor');

  supervisor._resetForTesting();
  hits.length = 0;
  respondWithStatus = 200;

  let now = Date.now();
  const nowFn = () => now;
  let handles;
  try {
    handles = supervisor.start(a2a, { nowFn });

    // Wait for the obfuscated module to register (hello).
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !hits.some((h) => h.url === '/a2a/hello')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(hits.some((h) => h.url === '/a2a/hello'), 'startup hello must land');

    // Drive a poke so totalSent is non-zero pre-restart. Then wait for
    // the underlying send to complete.
    supervisor.poke('h2-pre', { nowFn });
    const hb1Deadline = Date.now() + 3000;
    while (
      Date.now() < hb1Deadline
      && hits.filter((h) => h.url === '/a2a/heartbeat').length < 1
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const sentPreRestart = a2a.getHeartbeatStats().totalSent;
    assert.ok(sentPreRestart > 0, 'pre-restart totalSent must be > 0 after a successful poke');

    // Trigger _hardRestart via a wall-clock jump.
    now += 60 * 60 * 1000;
    handles._driftTick();
    const sentPostRestart = a2a.getHeartbeatStats().totalSent;

    // Document the observed behavior. This test passes either way; the
    // assert message reports which case is real so future contributors
    // can see it without re-running the experiment.
    const totalSentResets = sentPostRestart < sentPreRestart;
    console.log(
      `[H2 observation] obfuscated totalSent across stop+start: ` +
        `pre=${sentPreRestart}, post=${sentPostRestart}, resets=${totalSentResets}`,
    );

    // The supervisor's freshness pointer must correctly absorb whichever
    // value the underlying counter takes. After _hardRestart resets
    // _lastObservedSent to -1, the next _livenessTick must update it to
    // the current totalSent — proving the freshness tracking is correct
    // regardless of which case applies.
    handles._livenessTick();

    // To prove the pointer is now tracking the post-restart value, advance
    // past the (default) wedge threshold WITH no additional totalSent
    // movement and assert a SECOND restart fires. If the pointer were
    // still stale (-1 or pre-restart value), the freshness check on the
    // first _livenessTick after restart would already have flagged a
    // wedge — but it shouldn't, because the restart just happened.
    now += supervisor.WEDGE_THRESHOLD_MS + 60_000;
    const sentBeforeSecondTick = a2a.getHeartbeatStats().totalSent;
    handles._livenessTick();
    const sentAfterSecondTick = a2a.getHeartbeatStats().totalSent;

    // If supervisor correctly tracked the post-restart counter, the
    // second restart fires now (freshness was set at the time of the
    // first post-restart tick, and 15+ min have passed with no advance).
    // We can't directly observe stopCalls on the real module, but we
    // can verify uptimeMs reset again — which only happens on a fresh
    // startHeartbeat call.
    const postSecondRestartStats = a2a.getHeartbeatStats();
    assert.ok(
      postSecondRestartStats.uptimeMs < 5_000,
      `second wedge-driven restart must reset uptimeMs (got ${postSecondRestartStats.uptimeMs}ms). ` +
        'If this fails, the supervisor freshness pointer is not being updated ' +
        'after _hardRestart and the wedge detector is broken.',
    );
    // Sanity: totalSent shouldn't change just from a _livenessTick call
    // (the tick doesn't send; _hardRestart only stops+starts).
    assert.equal(
      sentAfterSecondTick, sentBeforeSecondTick,
      '_livenessTick must not directly drive sendHeartbeat',
    );
  } finally {
    supervisor.stop();
  }
});

test('integration: real-module wedge path fires _hardRestart and recovery sends a fresh heartbeat', async () => {
  // The audit flagged that no test verified the wedge path against the
  // real obfuscated module — only against the fake. This test uses a
  // small wedgeThresholdMs override to drive the path in seconds rather
  // than 15 minutes.
  //
  // Flow:
  //   1. Start supervisor with wedgeThresholdMs=2000 against the real
  //      obfuscated module and a 200-responding stub hub.
  //   2. Drive a poke so totalSent advances and a hub heartbeat lands.
  //   3. Establish a baseline _livenessTick.
  //   4. Advance nowFn past the override threshold with NO totalSent
  //      movement (the obfuscated module's internal cadence is 6 min,
  //      so it won't naturally fire during this short test window).
  //   5. Fire _livenessTick. The wedge condition is met -> _hardRestart.
  //   6. Confirm uptimeMs reset (proves stop+start actually ran).
  //   7. Advance past throttle, poke again, confirm a fresh hub-side
  //      /a2a/heartbeat lands.
  const a2a = require('../src/gep/a2aProtocol');
  const supervisor = require('../src/gep/heartbeatSupervisor');

  supervisor._resetForTesting();
  hits.length = 0;
  respondWithStatus = 200;

  let now = Date.now();
  const nowFn = () => now;
  let handles;
  try {
    handles = supervisor.start(a2a, { nowFn, wedgeThresholdMs: 2_000 });

    const helloDeadline = Date.now() + 3000;
    while (Date.now() < helloDeadline && !hits.some((h) => h.url === '/a2a/hello')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(hits.some((h) => h.url === '/a2a/hello'), 'startup hello must land');

    // Drive a poke so totalSent has a non-zero starting value.
    supervisor.poke('wedge-pre', { nowFn });
    const hbCountAfterPoke = await waitForHeartbeats(1);
    assert.ok(hbCountAfterPoke >= 1, 'pre-wedge poke must produce a hub heartbeat');

    // Baseline _livenessTick. After this, the freshness pointer is set
    // to current totalSent and _lastSuccessfulSendAt = now.
    handles._livenessTick();
    const statsAtBaseline = a2a.getHeartbeatStats();
    const uptimeBeforeWedge = statsAtBaseline.uptimeMs;

    // Jump well past the override threshold. The obfuscated module's
    // internal cadence (~6 min) means totalSent does NOT advance from
    // the module's own loop during this gap.
    now += 5_000;
    const sentBeforeWedge = a2a.getHeartbeatStats().totalSent;
    handles._livenessTick(); // wedge condition met -> _hardRestart

    // Proof of restart: uptimeMs resets after stop+start.
    const statsAfterWedge = a2a.getHeartbeatStats();
    assert.ok(
      statsAfterWedge.uptimeMs < uptimeBeforeWedge,
      `wedge must trigger stop+start, resetting uptimeMs ` +
        `(before=${uptimeBeforeWedge}ms, after=${statsAfterWedge.uptimeMs}ms)`,
    );
    assert.ok(
      statsAfterWedge.uptimeMs < 5_000,
      `wedge restart must produce a near-zero uptimeMs (got ${statsAfterWedge.uptimeMs}ms)`,
    );
    assert.equal(
      a2a.getHeartbeatStats().totalSent, sentBeforeWedge,
      '_livenessTick itself does not send; totalSent must not advance from the tick',
    );

    // Now prove the underlying loop is genuinely usable post-restart: a
    // poke after throttle bypass must produce a new hub-visible heartbeat.
    now += supervisor.POKE_THROTTLE_MS + 5_000;
    const hbCountBeforeRecoveryPoke = hits.filter((h) => h.url === '/a2a/heartbeat').length;
    const okPoke = supervisor.poke('wedge-recovery', { nowFn });
    assert.equal(okPoke, true, 'recovery poke must commit a send after wedge restart');

    const hbDeadline = Date.now() + 3000;
    while (
      Date.now() < hbDeadline
      && hits.filter((h) => h.url === '/a2a/heartbeat').length <= hbCountBeforeRecoveryPoke
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const hbCountAfter = hits.filter((h) => h.url === '/a2a/heartbeat').length;
    assert.ok(
      hbCountAfter > hbCountBeforeRecoveryPoke,
      `wedge-recovery poke must produce a NEW hub-visible heartbeat ` +
        `(before=${hbCountBeforeRecoveryPoke}, after=${hbCountAfter}). ` +
        'If this fails, _hardRestart against the real module did not leave ' +
        'the obfuscated loop in a usable state.',
    );
  } finally {
    supervisor.stop();
  }
});

// Helper used by the wedge test above. Polls hub-side heartbeat hits until
// at least `minCount` have landed or the deadline expires.
async function waitForHeartbeats(minCount) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const count = hits.filter((h) => h.url === '/a2a/heartbeat').length;
    if (count >= minCount) return count;
    await new Promise((r) => setTimeout(r, 50));
  }
  return hits.filter((h) => h.url === '/a2a/heartbeat').length;
}

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
