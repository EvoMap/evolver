'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

test('runs with isolated user state', () => {
  const parentHome = process.env.EVOLVER_TEST_PARENT_HOME;
  assert.ok(parentHome);
  assert.notEqual(process.env.HOME, parentHome);
  assert.notEqual(process.env.USERPROFILE, parentHome);
  assert.notEqual(process.env.EVOLVER_HOME, path.join(parentHome, '.evomap'));
  assert.notEqual(process.env.EVOLVER_SETTINGS_DIR, path.join(parentHome, '.evolver'));

  fs.mkdirSync(process.env.EVOLVER_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVOLVER_HOME, 'node_secret'), 'test-only');
});
