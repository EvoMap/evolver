const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function stripAnsi(str) {
  // Strip CSI sequences so child stdout stays deterministic regardless of
  // the parent shell's FORCE_COLOR state (see issue #430 and PRs #444/#445).
  return String(str).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

const savedEnv = {};
const envKeys = ['EVOLVE_BRIDGE', 'OPENCLAW_WORKSPACE'];

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

beforeEach(() => {
  for (const k of envKeys) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('determineBridgeEnabled -- white-box', () => {
  it('returns false when EVOLVE_BRIDGE unset and no OPENCLAW_WORKSPACE', () => {
    delete process.env.EVOLVE_BRIDGE;
    delete process.env.OPENCLAW_WORKSPACE;
    const { determineBridgeEnabled } = freshRequire('../src/evolve/bridgeMode');
    assert.equal(determineBridgeEnabled(), false);
  });

  it('returns true when EVOLVE_BRIDGE unset but OPENCLAW_WORKSPACE is set', () => {
    delete process.env.EVOLVE_BRIDGE;
    process.env.OPENCLAW_WORKSPACE = '/some/workspace';
    const { determineBridgeEnabled } = freshRequire('../src/evolve/bridgeMode');
    assert.equal(determineBridgeEnabled(), true);
  });

  it('returns true when EVOLVE_BRIDGE explicitly "true"', () => {
    process.env.EVOLVE_BRIDGE = 'true';
    delete process.env.OPENCLAW_WORKSPACE;
    const { determineBridgeEnabled } = freshRequire('../src/evolve/bridgeMode');
    assert.equal(determineBridgeEnabled(), true);
  });

  it('returns false when EVOLVE_BRIDGE explicitly "false"', () => {
    process.env.EVOLVE_BRIDGE = 'false';
    process.env.OPENCLAW_WORKSPACE = '/some/workspace';
    const { determineBridgeEnabled } = freshRequire('../src/evolve/bridgeMode');
    assert.equal(determineBridgeEnabled(), false);
  });

  it('returns true for EVOLVE_BRIDGE="True" (case insensitive)', () => {
    process.env.EVOLVE_BRIDGE = 'True';
    const { determineBridgeEnabled } = freshRequire('../src/evolve/bridgeMode');
    assert.equal(determineBridgeEnabled(), true);
  });

  it('returns false for EVOLVE_BRIDGE="False" (case insensitive)', () => {
    process.env.EVOLVE_BRIDGE = 'False';
    const { determineBridgeEnabled } = freshRequire('../src/evolve/bridgeMode');
    assert.equal(determineBridgeEnabled(), false);
  });

  it('returns true for EVOLVE_BRIDGE="1" (truthy non-false string)', () => {
    process.env.EVOLVE_BRIDGE = '1';
    const { determineBridgeEnabled } = freshRequire('../src/evolve/bridgeMode');
    assert.equal(determineBridgeEnabled(), true);
  });

  it('returns true for EVOLVE_BRIDGE whitespace (truthy non-false string)', () => {
    process.env.EVOLVE_BRIDGE = '   ';
    const { determineBridgeEnabled } = freshRequire('../src/evolve/bridgeMode');
    assert.equal(determineBridgeEnabled(), true);
  });

  it('returns false for EVOLVE_BRIDGE="" (empty string) without OPENCLAW_WORKSPACE', () => {
    process.env.EVOLVE_BRIDGE = '';
    delete process.env.OPENCLAW_WORKSPACE;
    const { determineBridgeEnabled } = freshRequire('../src/evolve/bridgeMode');
    assert.equal(determineBridgeEnabled(), false);
  });

  it('returns true for EVOLVE_BRIDGE="" (empty string) with OPENCLAW_WORKSPACE', () => {
    process.env.EVOLVE_BRIDGE = '';
    process.env.OPENCLAW_WORKSPACE = '/ws';
    const { determineBridgeEnabled } = freshRequire('../src/evolve/bridgeMode');
    assert.equal(determineBridgeEnabled(), true);
  });
});

describe('determineBridgeEnabled -- black-box via child_process', () => {
  const { execFileSync } = require('child_process');

  function runBridgeCheck(env) {
    const script = `
      delete process.env.EVOLVE_BRIDGE;
      delete process.env.OPENCLAW_WORKSPACE;
      ${env.EVOLVE_BRIDGE !== undefined ? `process.env.EVOLVE_BRIDGE = ${JSON.stringify(env.EVOLVE_BRIDGE)};` : ''}
      ${env.OPENCLAW_WORKSPACE !== undefined ? `process.env.OPENCLAW_WORKSPACE = ${JSON.stringify(env.OPENCLAW_WORKSPACE)};` : ''}
      const { determineBridgeEnabled } = require('./src/evolve/bridgeMode');
      console.log(determineBridgeEnabled());
    `;
    const cleanEnv = {
      ...process.env,
      NODE_DISABLE_COLORS: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      // Silence the one-shot "Using host git repository at:" banner in
      // paths.js so stdout contains only the bridge value and trim() yields
      // a deterministic string. See issue #430.
      EVOLVER_QUIET_PARENT_GIT: '1',
    };
    delete cleanEnv.EVOLVE_BRIDGE;
    delete cleanEnv.OPENCLAW_WORKSPACE;
    const raw = execFileSync(process.execPath, ['-e', script], {
      cwd: require('path').resolve(__dirname, '..'),
      encoding: 'utf8',
      timeout: 10000,
      env: cleanEnv,
    });
    return stripAnsi(raw).trim();
  }

  it('standalone mode: bridge off', () => {
    assert.equal(runBridgeCheck({}), 'false');
  });

  it('OpenClaw mode: bridge on', () => {
    assert.equal(runBridgeCheck({ OPENCLAW_WORKSPACE: '/ws' }), 'true');
  });

  it('explicit override: bridge forced on', () => {
    assert.equal(runBridgeCheck({ EVOLVE_BRIDGE: 'true' }), 'true');
  });

  it('explicit override: bridge forced off even with OPENCLAW_WORKSPACE', () => {
    assert.equal(runBridgeCheck({ EVOLVE_BRIDGE: 'false', OPENCLAW_WORKSPACE: '/ws' }), 'false');
  });
});

describe('extractFirstSpawnPayload / parseFirstSpawnCall', () => {
  const { renderSessionsSpawnCall, extractFirstSpawnPayload, parseFirstSpawnCall } = require('../src/gep/bridge');

  it('round-trips a rendered call', () => {
    const line = renderSessionsSpawnCall({ task: 'do the thing', agentId: 'main', label: 'gep_x', cleanup: 'delete' });
    const obj = parseFirstSpawnCall(line);
    assert.equal(obj.task, 'do the thing');
    assert.equal(obj.agentId, 'main');
    assert.equal(obj.label, 'gep_x');
    assert.equal(obj.cleanup, 'delete');
  });

  it('takes the FIRST call when the task field embeds an example sessions_spawn (the real trap)', () => {
    // The GEP prompt inside `task` contains a loop-chaining EXAMPLE spawn. The
    // real bridge call is the first/outer one; a last-match would grab the example.
    const innerExample = 'sessions_spawn({"task":"exec: node skills/evolver/index.js evolve","agentId":"main","cleanup":"delete","label":"gep_loop_next"})';
    const realTask = `Apply the patch following this prompt.\nLoop chaining: after solidify, print:\n${innerExample}\n`;
    const line = renderSessionsSpawnCall({ task: realTask, agentId: 'main', label: 'gep_bridge_42' });
    const stdout = `Starting evolver...\nsome log line\n${line}\nEvolver finished.`;
    const obj = parseFirstSpawnCall(stdout);
    assert.equal(obj.label, 'gep_bridge_42', 'must pick the OUTER real call, not the inner example');
    assert.ok(obj.task.includes('Apply the patch'), 'task is the real one');
    assert.ok(obj.task.includes(innerExample), 'the inner example is preserved verbatim inside the task');
  });

  it('handles nested braces / arrays in the payload via brace-depth counting', () => {
    const line = renderSessionsSpawnCall({ task: JSON.stringify({ a: { b: [1, 2, { c: 3 }] }, d: '}' }), agentId: 'main' });
    const obj = parseFirstSpawnCall(line);
    const taskObj = JSON.parse(obj.task);
    assert.deepEqual(taskObj.a.b, [1, 2, { c: 3 }]);
    assert.equal(taskObj.d, '}');
  });

  it('does not let a brace inside a JSON string literal close the object early', () => {
    const line = renderSessionsSpawnCall({ task: 'text with a literal } brace and a { brace inside', agentId: 'main' });
    const obj = parseFirstSpawnCall(line);
    assert.equal(obj.task, 'text with a literal } brace and a { brace inside');
  });

  it('returns null when there is no sessions_spawn marker', () => {
    assert.equal(extractFirstSpawnPayload('just regular output, no spawn here'), null);
    assert.equal(parseFirstSpawnCall('nope'), null);
  });

  it('returns null for empty / non-string input', () => {
    assert.equal(extractFirstSpawnPayload(''), null);
    assert.equal(extractFirstSpawnPayload(null), null);
    assert.equal(extractFirstSpawnPayload(undefined), null);
    assert.equal(parseFirstSpawnCall(''), null);
  });

  it('returns null on unbalanced braces (marker present but no closing)', () => {
    assert.equal(extractFirstSpawnPayload('sessions_spawn({"task":"unterminated'), null);
    assert.equal(parseFirstSpawnCall('sessions_spawn({"task":"unterminated'), null);
  });

  it('returns null when a non-whitespace char sits between marker and brace (malformed)', () => {
    assert.equal(extractFirstSpawnPayload('sessions_spawn(garbage{"task":"x"})'), null);
  });

  it('extractFirstSpawnPayload returns the raw JSON string; parseFirstSpawnCall returns the object', () => {
    const line = renderSessionsSpawnCall({ task: 'T', agentId: 'a1' });
    const raw = extractFirstSpawnPayload(line);
    assert.equal(typeof raw, 'string');
    assert.deepEqual(JSON.parse(raw), parseFirstSpawnCall(line));
  });
});
