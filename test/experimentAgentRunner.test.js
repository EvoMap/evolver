// test/experimentAgentRunner.test.js
//
// Process-level tests for src/experiment/agentRunner.js — the ONE experiment
// module that intentionally spawns a subprocess. Kept out of
// experimentComparison.test.js, whose header promises zero-subprocess tests.
// The fake "agent CLI" is `node <script.js> <mode>`: runAgentTask appends
// `-p <prompt> --output-format json`, which land in the script's argv and are
// ignored (a bare `node -e` fake does NOT work — node itself rejects
// `--output-format` as a bad node option before any code runs).
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAgentTask } = require('../src/experiment/agentRunner');

const FAKE_CLI = `
const envelope = JSON.stringify({
  result: 'done',
  is_error: false,
  usage: { input_tokens: 1, output_tokens: 1 },
  num_turns: 1,
});
const mode = process.argv[2];
if (mode === 'kill') {
  // Flush the clean envelope FIRST, then die by signal.
  process.stdout.write(envelope + '\\n', () => { process.kill(process.pid, 'SIGKILL'); });
  setInterval(() => {}, 1000); // keep alive until the kill lands
} else if (mode === 'split-utf8') {
  const output = Buffer.from(JSON.stringify({ result: '中文𠀀', is_error: false }) + '\\n');
  const boundary = output.indexOf(Buffer.from('中文𠀀')) + 1;
  process.stdout.write(output.subarray(0, boundary), () => {
    setTimeout(() => process.stdout.write(output.subarray(boundary)), 50);
  });
} else if (mode === 'split-stderr') {
  const output = Buffer.from('失败𠀀');
  process.stderr.write(output.subarray(0, 1), () => {
    setTimeout(() => process.stderr.write(output.subarray(1)), 50);
  });
} else if (mode === 'late-output') {
  const script = 'setTimeout(() => process.stdout.write(' + JSON.stringify(envelope + '\\n') + '), 100)';
  const child = require('child_process').spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.unref();
  process.exit(0);
} else {
  process.stdout.write(envelope + '\\n');
}
`;

let tmpDir;
let cliPath;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-agentrunner-'));
  cliPath = path.join(tmpDir, 'fake-agent-cli.js');
  fs.writeFileSync(cliPath, FAKE_CLI);
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
});

function fakeCli(mode) {
  return { command: process.execPath, extraArgs: [cliPath, mode], timeoutMs: 15000 };
}

describe('runAgentTask', () => {
  it('a signal-terminated arm is NEVER ok, even when stdout already holds a clean JSON envelope', async () => {
    // Regression: child 'exit' reports code=null for a signal death, and
    // Number(null) === 0 — the old num(code, -1) read that as a clean exit,
    // so a killed arm with parseable output scored ok:true.
    const res = await runAgentTask('noop', fakeCli('kill'));
    assert.equal(res.ok, false, 'a killed arm must not score ok');
    assert.notEqual(res.exitCode, 0, 'signal death must not read as exit 0');
    assert.ok(res.error, 'a killed arm carries an error label');
  });

  it('positive control: a clean exit 0 with the same envelope IS ok', async () => {
    const res = await runAgentTask('noop', fakeCli('clean'));
    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 0);
    assert.equal(res.error, null);
  });

  it('preserves UTF-8 characters split across output chunks', async () => {
    const res = await runAgentTask('noop', fakeCli('split-utf8'));
    assert.equal(res.ok, true);
    assert.equal(res.resultText, '中文𠀀');
  });

  it('preserves UTF-8 characters split across stderr chunks', async () => {
    const res = await runAgentTask('noop', fakeCli('split-stderr'));
    assert.equal(res.ok, false);
    assert.equal(res.error, 'agent_output_parse_failed');
    assert.equal(res.resultText, '失败𠀀');
  });

  it('waits for output streams after the agent process exits', {
    skip: process.platform === 'win32' && 'inherited pipe behavior differs on Windows',
  }, async () => {
    const res = await runAgentTask('noop', fakeCli('late-output'));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.resultText, 'done');
  });
});
