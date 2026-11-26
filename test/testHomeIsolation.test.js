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

test('preload isolates state before a Node test context exists', () => {
  const parentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-parent-home-'));
  const repoRoot = path.resolve(__dirname, '..');
  const childEnv = {
    ...process.env,
    HOME: parentHome,
    USERPROFILE: parentHome,
    EVOLVER_HOME: path.join(parentHome, '.evomap'),
    EVOLVER_SETTINGS_DIR: path.join(parentHome, '.evolver'),
  };
  delete childEnv.NODE_TEST_CONTEXT;

  try {
    const result = spawnSync(process.execPath, [
      '--require',
      path.join(repoRoot, 'test', 'setup.js'),
      '--print',
      'JSON.stringify([process.env.HOME, process.env.EVOLVER_HOME, process.env.EVOLVER_SETTINGS_DIR])',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: childEnv,
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    const [home, evolverHome, settingsDir] = JSON.parse(result.stdout);
    assert.notEqual(home, parentHome);
    assert.notEqual(evolverHome, path.join(parentHome, '.evomap'));
    assert.notEqual(settingsDir, path.join(parentHome, '.evolver'));
  } finally {
    fs.rmSync(parentHome, { recursive: true, force: true });
  }
});

test('test setup keeps identity files out of the parent home', () => {
  const parentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-parent-home-'));
  const repoRoot = path.resolve(__dirname, '..');

  try {
    const childEnv = {
      ...process.env,
      HOME: parentHome,
      USERPROFILE: parentHome,
      EVOLVER_HOME: path.join(parentHome, '.evomap'),
      EVOLVER_SETTINGS_DIR: path.join(parentHome, '.evolver'),
      EVOLVER_TEST_PARENT_HOME: parentHome,
    };
    delete childEnv.NODE_TEST_CONTEXT;

    const result = spawnSync(process.execPath, [
      '--require',
      path.join(repoRoot, 'test', 'setup.js'),
      '--test',
      path.join(repoRoot, 'test', 'fixtures', 'homeIsolationProbe.test.js'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: childEnv,
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(parentHome, '.evomap')), false);
    assert.equal(fs.existsSync(path.join(parentHome, '.evolver')), false);
  } finally {
    fs.rmSync(parentHome, { recursive: true, force: true });
  }
});
