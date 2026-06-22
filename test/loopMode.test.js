const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rejectPendingRun, isPendingSolidify, readJsonSafe } = require('../index.js');

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

  const repoRoot = path.resolve(__dirname, '..');
  const indexSource = () => fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8');

  it('loop-mode continues after evolve.run() throws', () => {
    const source = indexSource();
    assert.match(source, /catch \(error\) \{[\s\S]*console\.error\(`Evolution cycle failed: \$\{msg\}`\);[\s\S]*\} finally \{/);
    assert.match(source, /catch \(loopErr\) \{[\s\S]*Unexpected loop error \(recovering\)[\s\S]*await sleepMs/);
  });

  it('should_explore branch does not leak errors to cycle loop', () => {
    // lines 281-291: should_explore branch wraps tryExplore in try/catch
    // This test verifies explore errors are swallowed and logged verbosely only
    const source = indexSource();
    assert.match(source, /if \(schedule\.should_explore\) \{[\s\S]*try \{[\s\S]*await tryExplore[\s\S]*\} catch \(e\) \{/);
    assert.match(source, /if \(isVerbose\) console\.warn\('\[OMLS\] Explore error:/);
  });
});

describe('loop-mode EVOLVE_BRIDGE default (issue #96)', () => {
  // From v1.85.0 the daemon defaults EVOLVE_BRIDGE=true so cycles actually
  // evolve the working tree. The previous default 'false' produced no
  // EvolutionEvents on Aurora over 33 days because every cycle hit
  // rejectPendingRun(reason=loop_bridge_disabled_autoreject_no_rollback).
  // These tests verify the default flip and the safety banner.
  const { resolveLoopBridgeMode } = require('../src/evolve/loopBridgeMode');

  it('--loop with EVOLVE_BRIDGE unset defaults to bridge=true', () => {
    const env = {};
    const mode = resolveLoopBridgeMode(env);
    assert.equal(mode.value, 'true');
    assert.equal(mode.enabled, true);
    assert.equal(env.EVOLVE_BRIDGE, 'true');
  });

  it('--loop with EVOLVE_BRIDGE=true keeps bridge=true', () => {
    const mode = resolveLoopBridgeMode({ EVOLVE_BRIDGE: 'true' });
    assert.equal(mode.value, 'true');
    assert.equal(mode.enabled, true);
  });

  it('--loop with EVOLVE_BRIDGE=false still respected (opt-out)', () => {
    const mode = resolveLoopBridgeMode({ EVOLVE_BRIDGE: 'false' });
    assert.equal(mode.value, 'false');
    assert.equal(mode.enabled, false);
    assert.match(mode.banner.join('\n'), /observe-only/);
  });

  it('bridge=true banner mentions stash recovery', () => {
    // The safety banner is the one mitigation that compensates for the
    // riskier default. If the message is missing or rewritten, users lose
    // the recovery breadcrumb -- they must see "git stash" in the warning.
    const mode = resolveLoopBridgeMode({});
    assert.match(mode.banner.join('\n'), /git stash/);
  });
});

describe('bare invocation routing -- black-box', () => {
  const { classifyInvocation } = require('../index.js');

  it('node index.js (no args) starts evolution, not help', () => {
    assert.deepEqual(classifyInvocation([]), {
      command: undefined,
      isLoop: false,
      startsEvolution: true,
    });
  });

  it('run and /evolve start evolution', () => {
    assert.equal(classifyInvocation(['run']).startsEvolution, true);
    assert.equal(classifyInvocation(['/evolve']).startsEvolution, true);
  });

  it('--loop starts evolution regardless of command position', () => {
    assert.equal(classifyInvocation(['--loop']).startsEvolution, true);
    assert.equal(classifyInvocation(['nonexistent-cmd', '--loop']).startsEvolution, true);
  });

  it('unknown command routes to usage help', () => {
    assert.deepEqual(classifyInvocation(['nonexistent-cmd']), {
      command: 'nonexistent-cmd',
      isLoop: false,
      startsEvolution: false,
    });
  });
});
