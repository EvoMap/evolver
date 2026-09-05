'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const testDir = path.join(repoRoot, 'test');
const setupFile = path.join(testDir, 'setup.js');
const skipped = new Set([
  'solidifyIntegration.test.js',
  'proxyTracePlatformInstall.test.js',
  'spawnReplacementProcess.test.js',
]);

const testFiles = fs.readdirSync(testDir)
  .filter((file) => file.endsWith('.test.js') && !skipped.has(file))
  .sort()
  .map((file) => path.join('test', file));

const result = spawnSync(process.execPath, [
  '--require',
  setupFile,
  '--test',
  ...testFiles,
], {
  cwd: repoRoot,
  env: { ...process.env, NODE_ENV: 'test' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.signal) {
  console.error(`Test process terminated by ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status === null ? 1 : result.status;
}
