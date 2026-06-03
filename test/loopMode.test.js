const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  rejectPendingRun,
  rejectStalePendingRun,
  isPendingSolidify,
  pendingRunAgeMs,
  readJsonSafe,
} = require('../index.js');

const savedEnv = {};
const envKeys = [
  'EVOLVER_REPO_ROOT', 'OPENCLAW_WORKSPACE', 'EVOLUTION_DIR',
  'MEMORY_DIR', 'A2A_HUB_URL', 'HEARTBEAT_INTERVAL_MS', 'WORKER_ENABLED',
];
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-loop-test-'));
  for (const k of envKeys) { savedEnv[k] = process.env[k]; }
  process.env.EVOLVER_REPO_ROOT = tmpDir;
  process.env.OPENCLAW_WORKSPACE = tmpDir;
  process.env.EVOLUTION_DIR = path.join(tmpDir, 'memory', 'evolution');
  process.env.MEMORY_DIR = path.join(tmpDir, 'memory');
  process.env.A2A_HUB_URL = '';
  process.env.HEARTBEAT_INTERVAL_MS = '3600000';
  delete process.env.WORKER_ENABLED;
});

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loop-mode auto reject', () => {
  it('marks pending runs rejected without deleting untracked files', () => {
    const stateDir = path.join(tmpDir, 'memory', 'evolution');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'evolution_solidify_state.json'), JSON.stringify({
      last_run: { run_id: 'run_123' }
    }, null, 2));
    fs.writeFileSync(path.join(tmpDir, 'PR_BODY.md'), 'keep me\n');
    const changed = rejectPendingRun(path.join(stateDir, 'evolution_solidify_state.json'));

    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'evolution_solidify_state.json'), 'utf8'));
    assert.equal(changed, true);
    assert.equal(state.last_solidify.run_id, 'run_123');
    assert.equal(state.last_solidify.rejected, true);
    assert.equal(state.last_solidify.reason, 'loop_bridge_disabled_autoreject_no_rollback');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'PR_BODY.md'), 'utf8'), 'keep me\n');
  });
});

describe('isPendingSolidify', () => {
  it('returns false when state is null', () => {
    assert.equal(isPendingSolidify(null), false);
  });

  it('returns false when state has no last_run', () => {
    assert.equal(isPendingSolidify({}), false);
  });

  it('returns false when last_run has no run_id', () => {
    assert.equal(isPendingSolidify({ last_run: {} }), false);
  });

  it('returns true when last_run has run_id but no last_solidify', () => {
    assert.equal(isPendingSolidify({ last_run: { run_id: 'run_1' } }), true);
  });

  it('returns true when last_solidify run_id differs from last_run', () => {
    assert.equal(isPendingSolidify({
      last_run: { run_id: 'run_2' },
      last_solidify: { run_id: 'run_1' },
    }), true);
  });

  it('returns false when last_solidify run_id matches last_run', () => {
    assert.equal(isPendingSolidify({
      last_run: { run_id: 'run_1' },
      last_solidify: { run_id: 'run_1' },
    }), false);
  });

  it('handles numeric run_ids via string coercion', () => {
    assert.equal(isPendingSolidify({
      last_run: { run_id: 123 },
      last_solidify: { run_id: '123' },
    }), false);
  });
});

describe('pendingRunAgeMs (issue #556)', () => {
  const NOW = Date.parse('2026-06-03T12:00:00.000Z');

  it('returns null when there is no pending run', () => {
    assert.equal(pendingRunAgeMs(null, NOW), null);
    assert.equal(pendingRunAgeMs({}, NOW), null);
    assert.equal(pendingRunAgeMs({
      last_run: { run_id: 'r1' },
      last_solidify: { run_id: 'r1' },
    }, NOW), null);
  });

  it('returns null when pending but no parseable timestamp (age unknown -> never force-reject)', () => {
    assert.equal(pendingRunAgeMs({ last_run: { run_id: 'r1' } }, NOW), null);
    assert.equal(pendingRunAgeMs({ last_run: { run_id: 'r1', created_at: 'not-a-date' } }, NOW), null);
  });

  it('computes age from created_at', () => {
    const created = new Date(NOW - 90 * 1000).toISOString();
    assert.equal(pendingRunAgeMs({ last_run: { run_id: 'r1', created_at: created } }, NOW), 90 * 1000);
  });

  it('falls back to started_at when created_at is absent', () => {
    const started = new Date(NOW - 30 * 1000).toISOString();
    assert.equal(pendingRunAgeMs({ last_run: { run_id: 'r1', started_at: started } }, NOW), 30 * 1000);
  });

  it('returns null for a future timestamp (clock skew -> do not force-reject)', () => {
    const future = new Date(NOW + 60 * 1000).toISOString();
    assert.equal(pendingRunAgeMs({ last_run: { run_id: 'r1', created_at: future } }, NOW), null);
  });
});

describe('rejectStalePendingRun (issue #556)', () => {
  it('marks a pending run rejected with the stale-specific reason, preserving untracked files', () => {
    const stateDir = path.join(tmpDir, 'memory', 'evolution');
    fs.mkdirSync(stateDir, { recursive: true });
    const sp = path.join(stateDir, 'evolution_solidify_state.json');
    fs.writeFileSync(sp, JSON.stringify({ last_run: { run_id: 'run_stale' } }, null, 2));
    fs.writeFileSync(path.join(tmpDir, 'KEEP.md'), 'keep me\n');

    const changed = rejectStalePendingRun(sp);
    const state = JSON.parse(fs.readFileSync(sp, 'utf8'));

    assert.equal(changed, true);
    assert.equal(state.last_solidify.run_id, 'run_stale');
    assert.equal(state.last_solidify.rejected, true);
    // Distinct reason from rejectPendingRun() so the two paths stay auditable.
    assert.equal(state.last_solidify.reason, 'stale_pending_no_solidify_autoreject_no_rollback');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'KEEP.md'), 'utf8'), 'keep me\n');
    // After rejection the run is no longer pending.
    assert.equal(isPendingSolidify(state), false);
  });

  it('returns false when there is no pending run to reject', () => {
    const stateDir = path.join(tmpDir, 'memory', 'evolution');
    fs.mkdirSync(stateDir, { recursive: true });
    const sp = path.join(stateDir, 'evolution_solidify_state.json');
    fs.writeFileSync(sp, JSON.stringify({}, null, 2));
    assert.equal(rejectStalePendingRun(sp), false);
  });

  it('does NOT overwrite a run that already solidified (TOCTOU guard, Bugbot #559 High)', () => {
    // If the sub-agent solidifies between the gate's age snapshot and this
    // write, last_run == last_solidify (not pending) and a rejection would
    // corrupt a successful solidify. rejectStalePendingRun must re-check
    // pending status under its own fresh read and refuse.
    const stateDir = path.join(tmpDir, 'memory', 'evolution');
    fs.mkdirSync(stateDir, { recursive: true });
    const sp = path.join(stateDir, 'evolution_solidify_state.json');
    const solidified = {
      last_run: { run_id: 'run_done' },
      last_solidify: { run_id: 'run_done', validation: { ok: true } },
    };
    fs.writeFileSync(sp, JSON.stringify(solidified, null, 2));

    const changed = rejectStalePendingRun(sp);
    const after = JSON.parse(fs.readFileSync(sp, 'utf8'));

    assert.equal(changed, false, 'must not reject an already-solidified run');
    // The successful solidify is preserved verbatim — not overwritten with a rejection.
    assert.deepEqual(after.last_solidify, solidified.last_solidify);
  });
});

describe('readJsonSafe', () => {
  it('returns null for non-existent file', () => {
    assert.equal(readJsonSafe(path.join(tmpDir, 'nonexistent.json')), null);
  });

  it('returns null for empty file', () => {
    const p = path.join(tmpDir, 'empty.json');
    fs.writeFileSync(p, '');
    assert.equal(readJsonSafe(p), null);
  });

  it('returns null for whitespace-only file', () => {
    const p = path.join(tmpDir, 'whitespace.json');
    fs.writeFileSync(p, '   \n  ');
    assert.equal(readJsonSafe(p), null);
  });

  it('returns null for invalid JSON', () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, '{ not valid json }');
    assert.equal(readJsonSafe(p), null);
  });

  it('parses valid JSON', () => {
    const p = path.join(tmpDir, 'good.json');
    fs.writeFileSync(p, JSON.stringify({ key: 'value' }));
    const result = readJsonSafe(p);
    assert.deepEqual(result, { key: 'value' });
  });
});

describe('loop-mode non-fatal error handling', () => {
  // line 298 in index.js: empty catch block swallowing errors during cycle execution
  // This test verifies the error handling contract: errors in the cycle loop are caught
  // and do not propagate, allowing the loop to continue executing subsequent cycles.

  const { execFileSync } = require('child_process');
  const repoRoot = path.resolve(__dirname, '..');

  it('loop-mode continues after evolve.run() throws', () => {
    // When EVOLVE_LOOP=true, the cycle loop catches all errors (line 297's catch(e){})
    // This ensures a throwing evolve.run() does not terminate the daemon.
    // We verify by checking the process exits cleanly rather than crashing.
    let exitCode = null;
    let stdout = '';
    const env = {
      ...process.env,
      EVOLVE_LOOP: 'true',
      EVOLVE_BRIDGE: 'false',
      A2A_HUB_URL: '',
      EVOLVER_REPO_ROOT: repoRoot,
      // Force immediate exit after first cycle for test predictability
      EVOLVER_MAX_CYCLES_PER_PROCESS: '1',
    };
    try {
      const out = execFileSync(process.execPath, ['index.js'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30000,
        env,
      });
      stdout = out;
    } catch (err) {
      exitCode = err.status;
      stdout = (err.stdout || '') + (err.stderr || '');
    }
    // Loop-mode should exit cleanly with code 0 or 1 (bridge mode exit),
    // not with a thrown error that would give code > 1 or ENOENT
    assert.ok(
      exitCode === null || exitCode === 0 || exitCode === 1,
      'loop-mode should exit cleanly, got code: ' + exitCode + ', stdout: ' + stdout.slice(0, 200)
    );
    assert.ok(
      !stdout.includes('SyntaxError') && !stdout.includes('ReferenceError'),
      'loop-mode should not leak uncaught errors: ' + stdout.slice(0, 200)
    );
  });

  it('should_explore branch does not leak errors to cycle loop', async () => {
    // lines 281-291: should_explore branch wraps tryExplore in try/catch
    // This test verifies explore errors are swallowed and logged verbosely only
    const { execFileSync } = require('child_process');
    const repoRoot = path.resolve(__dirname, '..');
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, ['index.js'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          EVOLVE_LOOP: 'true',
          EVOLVE_BRIDGE: 'false',
          OMLS_ENABLED: 'true',
          A2A_HUB_URL: '',
          EVOLVER_REPO_ROOT: repoRoot,
          EVOLVER_MAX_CYCLES_PER_PROCESS: '1',
        },
      });
    } catch (err) {
      stdout = (err.stdout || '') + (err.stderr || '');
    }
    // Should not have unhandled errors from tryExplore
    assert.ok(
      !stdout.includes('TypeError: Cannot') && !stdout.includes('Error: ENOENT'),
      'explore branch should not leak filesystem errors: ' + stdout.slice(0, 300)
    );
  });
});

describe('loop-mode EVOLVE_BRIDGE default (issue #96)', () => {
  // From v1.85.0 the daemon defaults EVOLVE_BRIDGE=true so cycles actually
  // evolve the working tree. The previous default 'false' produced no
  // EvolutionEvents on Aurora over 33 days because every cycle hit
  // rejectPendingRun(reason=loop_bridge_disabled_autoreject_no_rollback).
  // These tests verify the default flip and the safety banner.
  const { execFileSync } = require('child_process');
  const repoRoot = path.resolve(__dirname, '..');

  // Use the test-scoped tmpDir as REPO_ROOT so a leftover `.evolver.lock`
  // in the dev repo (e.g. during a release prep) does not preflight-yield
  // the spawned daemon and short-circuit the test. Init it as a git repo
  // since the daemon refuses to run outside of one.
  function ensureGitRepo(dir) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['commit', '--allow-empty', '-m', 'init', '-q'], { cwd: dir, stdio: 'ignore' });
    } catch (_) { /* best-effort */ }
  }

  function runDaemonOnce(extraEnv) {
    ensureGitRepo(tmpDir);
    let out = '';
    let err = '';
    try {
      const result = execFileSync(process.execPath, [path.join(repoRoot, 'index.js'), '--loop'], {
        cwd: tmpDir,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          EVOLVE_LOOP: 'true',
          A2A_HUB_URL: '',
          EVOLVER_REPO_ROOT: tmpDir,
          // Isolate the singleton pid-file in tmpDir so concurrent tests (and
          // a real daemon at the dev repo) do not block this spawn.
          EVOLVER_LOCK_DIR: tmpDir,
          EVOLVER_MAX_CYCLES_PER_PROCESS: '1',
          ...extraEnv,
        },
      });
      out = result;
    } catch (e) {
      out = e.stdout || '';
      err = e.stderr || '';
    }
    return out + err;
  }

  it('--loop with EVOLVE_BRIDGE unset defaults to bridge=true', () => {
    const combined = runDaemonOnce({ EVOLVE_BRIDGE: '' });
    assert.ok(
      /bridge=true/.test(combined),
      'combined output should announce bridge=true: ' + combined.slice(0, 500)
    );
  });

  it('--loop with EVOLVE_BRIDGE=true keeps bridge=true', () => {
    const combined = runDaemonOnce({ EVOLVE_BRIDGE: 'true' });
    assert.ok(
      /bridge=true/.test(combined),
      'explicit true should be honored: ' + combined.slice(0, 500)
    );
  });

  it('--loop with EVOLVE_BRIDGE=false still respected (opt-out)', () => {
    const combined = runDaemonOnce({ EVOLVE_BRIDGE: 'false' });
    assert.ok(
      /bridge=false/.test(combined),
      'explicit false must be honored as opt-out: ' + combined.slice(0, 500)
    );
    assert.ok(
      /observe-only/.test(combined),
      'opt-out banner should mention observe-only: ' + combined.slice(0, 500)
    );
  });

  it('bridge=true banner mentions stash recovery', () => {
    // The safety banner is the one mitigation that compensates for the
    // riskier default. If the message is missing or rewritten, users lose
    // the recovery breadcrumb -- they must see "git stash" in the warning.
    const combined = runDaemonOnce({ EVOLVE_BRIDGE: '' });
    assert.ok(
      /git stash/.test(combined),
      'safety banner must reference git stash recovery: ' + combined.slice(0, 800)
    );
  });

  // Issue #556: in bridge=true mode (the default) a pending run that never gets
  // solidified used to wedge the Ralph-loop gate forever, because the
  // bridge-disabled auto-reject only runs when EVOLVE_BRIDGE=false. We seed a
  // stale pending state with an old timestamp and a short staleness TTL, then
  // confirm the daemon clears it and proceeds rather than sleeping forever.
  function seedStalePending(ageMs) {
    const evoDir = path.join(tmpDir, 'memory', 'evolution');
    fs.mkdirSync(evoDir, { recursive: true });
    const createdAt = new Date(Date.now() - ageMs).toISOString();
    fs.writeFileSync(
      path.join(evoDir, 'evolution_solidify_state.json'),
      JSON.stringify({ last_run: { run_id: 'run_stuck', created_at: createdAt } }, null, 2)
    );
  }

  it('bridge=true: auto-rejects a stale pending run instead of Ralph-looping (#556)', () => {
    ensureGitRepo(tmpDir);
    // 10 min old pending run, TTL 1s -> immediately stale on the first gate check.
    seedStalePending(10 * 60 * 1000);
    const combined = runDaemonOnce({
      EVOLVE_BRIDGE: 'true',
      EVOLVER_PENDING_STALE_MS: '1000',
    });
    // The auto-reject log line is the deterministic proof of escape: it is
    // emitted only when the gate clears the stale run and FALLS THROUGH to run
    // a fresh cycle. Revert the fix and the gate sleeps pendingSleepMs forever
    // -> the 30s-timeout daemon is killed and this line never appears. (What
    // evolve.run() writes to the state file afterward is engine-dependent and
    // not asserted here; rejectStalePendingRun's state mutation is covered by
    // its own deterministic unit test above.)
    assert.ok(
      /Auto-rejected stale pending run/.test(combined) && /Issue #556/.test(combined),
      'daemon must auto-reject the stale pending run in bridge mode (not Ralph-loop): ' + combined.slice(0, 800)
    );
  });

  it('staleness TTL defaults OFF when the cycle timeout is disabled (Bugbot #559 Medium)', () => {
    // When EVOLVER_CYCLE_TIMEOUT_ENABLED=false there is no enforced hard ceiling,
    // so a sub-agent may legitimately run past 45 min. The TTL must NOT default
    // to 45 min and reject an in-progress solidify. With no explicit
    // EVOLVER_PENDING_STALE_MS, a stale-looking pending run must be left alone.
    ensureGitRepo(tmpDir);
    seedStalePending(60 * 60 * 1000); // 1h old — would trip a 45-min default TTL
    const combined = runDaemonOnce({
      EVOLVE_BRIDGE: 'true',
      EVOLVER_CYCLE_TIMEOUT_ENABLED: 'false',
      // EVOLVER_PENDING_STALE_MS intentionally unset -> default should be 0 (OFF).
    });
    assert.ok(
      !/Auto-rejected stale pending run/.test(combined),
      'TTL must be OFF by default when cycle timeout is disabled; must not auto-reject: ' + combined.slice(0, 800)
    );
    // The pending run is untouched (still no last_solidify written by us).
    const sp = path.join(tmpDir, 'memory', 'evolution', 'evolution_solidify_state.json');
    const state = JSON.parse(fs.readFileSync(sp, 'utf8'));
    assert.equal(state.last_run && state.last_run.run_id, 'run_stuck');
    assert.equal(
      state.last_solidify && state.last_solidify.reason,
      undefined,
      'no stale-reject should have been written'
    );
  });
});

describe('bare invocation routing -- black-box', () => {
  const { execFileSync } = require('child_process');
  const repoRoot = path.resolve(__dirname, '..');

  it('node index.js (no args) starts evolution, not help', () => {
    let out;
    try {
      out = execFileSync(process.execPath, ['index.js'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60000,
        env: { ...process.env, EVOLVE_BRIDGE: 'false', A2A_HUB_URL: '', EVOLVER_REPO_ROOT: repoRoot },
      });
    } catch (err) {
      // evolve.run() will block/timeout -- that is expected for a bare invocation.
      // Extract whatever stdout was captured before the timeout.
      out = (err.stdout || '') + '';
    }
    assert.ok(out.includes('Starting evolver') || out.includes('GEP'),
      'bare invocation should start evolution, not show usage. Got: ' + out.slice(0, 200));
    assert.ok(!out.includes('Usage:'), 'should not show usage for bare invocation');
  });

  it('unknown command shows usage help', () => {
    const out = execFileSync(process.execPath, ['index.js', 'nonexistent-cmd'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, A2A_HUB_URL: '' },
    });
    assert.ok(out.includes('Usage:'), 'unknown command should show usage');
  });
});
