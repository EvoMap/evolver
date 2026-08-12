'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.env.NODE_TEST_CONTEXT) {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-test-home-'));

  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.EVOLVER_HOME = path.join(testHome, '.evomap');
  process.env.EVOLVER_SETTINGS_DIR = path.join(testHome, '.evolver');

  process.on('exit', () => {
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch {}
  });
}
