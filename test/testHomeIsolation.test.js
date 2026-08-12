'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');

test('npm test preloads the isolation setup through the suite runner', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const runner = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-tests.js'), 'utf8');

  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.js');
  assert.match(runner, /spawnSync\(process\.execPath/);
  assert.match(runner, /'--require',\s*setupFile,\s*'--test'/);
});

test('test setup keeps identity files out of the parent home', () => {
  const parentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-parent-home-'));
  const repoRoot = path.resolve(__dirname, '..');

  try {
    const result = spawnSync(process.execPath, [
      '--require',
      path.join(repoRoot, 'test', 'setup.js'),
      '--test',
      path.join(repoRoot, 'test', 'fixtures', 'homeIsolationProbe.test.js'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: parentHome,
        USERPROFILE: parentHome,
        EVOLVER_HOME: path.join(parentHome, '.evomap'),
        EVOLVER_SETTINGS_DIR: path.join(parentHome, '.evolver'),
        EVOLVER_TEST_PARENT_HOME: parentHome,
      },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(parentHome, '.evomap')), false);
    assert.equal(fs.existsSync(path.join(parentHome, '.evolver')), false);
  } finally {
    fs.rmSync(parentHome, { recursive: true, force: true });
  }
});
