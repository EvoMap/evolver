// Usage: node scripts/validate-suite.js [test-glob-pattern | test-file]
// Runs the evolver test suite -- repo root is derived from script location, no shell glob needed.
// Accepts either a directory glob pattern (e.g. `test/*.test.js`) or a concrete test file path.
// See community PR #514.
// v2: default runs a curated quick subset (~15 tests / 277 assertions).
//     Pass --full or an explicit pattern to run all 97 test files.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const EVOLVER_REPO_ROOT = path.join(__dirname, '..');

// Flags: --full runs all test files (default is a curated quick subset).
const nonFlagArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const useQuickSubset = !process.argv.includes('--full');
const pattern = useQuickSubset ? null : (nonFlagArgs[0] || 'test/*.test.js');

// Known slow or external-dependent tests excluded from quick mode.
const QUICK_EXCLUDE = new Set([
  'a2aProtocol.test.js', 'a2aProtocol_trace_guard.test.js',
  'adapters.kiro.test.js', 'adapters.opencode.test.js', 'adapters.test.js',
  'atp-default.test.js', 'atpAutoBuyer.test.js', 'atpAutoDeliver.test.js',
  'atpCliBuy.test.js', 'atpExecute.test.js', 'atpHeartbeatSignalsHandler.test.js',
  'atpProxyRouting.test.js', 'atpTaskPickup.test.js',
  'bench.test.js', 'leakCheckDefault.test.js',
  'cliAutobuyPrompt.test.js', 'candidates.test.js',
  'curriculum.test.js', 'cycleHardTimeout.test.js', 'cycleProgressFile.test.js',
  'dotenvLoadOrder.test.js', 'envFingerprint.test.js',
  'evolveCollect.test.js', 'evolveDispatch.test.js', 'evolveEnrich.test.js',
  'evolveGuards.test.js', 'evolveHub.test.js', 'evolvePolicy.test.js',
  'evolveSelect.test.js', 'evolveSessionsDir.test.js', 'evolveSignals.test.js',
  'extensions.test.js', 'featureFlags.test.js', 'fetchSecurity.test.js',
  'forceUpdateHeartbeat.test.js', 'hubEvents.test.js', 'hubUrlResolution.test.js',
  'hubVerify.test.js', 'idleGating.test.js', 'idleScheduler.test.js',
  'integrityCheck.test.js', 'issueReporter.test.js',
  'lifecycleRateLimit.test.js', 'lifecycleStaleNodeSecret.test.js',
  'loadBackoff.test.js', 'localStateAwareness.test.js', 'loopMode.test.js',
  'mailboxStore.test.js', 'memoryGraph.test.js', 'memoryGraphRotation.test.js',
  'mutation.test.js', 'narrativeMemory.test.js', 'nodeIdResolution.test.js',
  'ops.test.js', 'portable.test.js', 'proxyServer.test.js', 'proxySettings.test.js',
  'questionComposer.test.js', 'questionGenerator.test.js', 'schemaCapsule.test.js',
  'schemaGene.test.js', 'schemaTask.test.js', 'selfPR.test.js',
  'sessionFormat.test.js', 'sessionSourceDiagnostic.test.js', 'shield.test.js',
  'skillDistiller.test.js', 'skillPublisher.test.js', 'solidifyLearning.test.js',
  'solidify-helpers.test.js', 'spawnReplacementProcess.test.js',
  'stakeBootstrap.test.js', 'sync-dedup.test.js', 'taskMonitor.test.js',
  'tttInspired.test.js', 'validator.test.js', 'validatorDaemon.test.js',
  'validatorReportDiagnostics.test.js', 'validateSuite.test.js',
  'learningSignals.test.js', 'sandboxExecutor.security.test.js',
]);

function expandTestGlob(repoRoot, pat) {
  // Quick mode: list test dir and exclude slow/external-dependent tests
  if (pat === null) {
    const all = fs.readdirSync(path.join(repoRoot, 'test'))
      .filter(f => f.endsWith('.test.js') && !QUICK_EXCLUDE.has(f))
      .map(f => path.join(repoRoot, 'test', f))
      .sort();
    if (all.length === 0) {
      console.error('FAIL: no quick-mode tests found (all excluded?)');
      process.exit(1);
    }
    return all;
  }
  const fullPattern = path.isAbsolute(pat) ? pat : path.join(repoRoot, pat);
  if (fs.existsSync(fullPattern) && fs.statSync(fullPattern).isFile()) {
    return fullPattern.endsWith('.test.js') ? [fullPattern] : [];
  }

  const dir = path.dirname(pat);
  const basenamePattern = path.basename(pat);
  const fullDir = path.isAbsolute(dir) ? dir : path.join(repoRoot, dir);
  if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) return [];

  const escaped = basenamePattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  const matcher = new RegExp('^' + escaped + '$');
  return fs.readdirSync(fullDir)
    .filter(f => f.endsWith('.test.js') && matcher.test(f))
    .map(f => path.join(fullDir, f))
    .sort();
}

const files = expandTestGlob(EVOLVER_REPO_ROOT, pattern);
if (files.length === 0) {
  console.error('FAIL: no tests found matching pattern: ' + pattern);
  process.exit(1);
}

const env = Object.assign({}, process.env, {
  NODE_ENV: 'test',
  EVOLVER_REPO_ROOT,
  GEP_ASSETS_DIR: path.join(EVOLVER_REPO_ROOT, 'assets', 'gep'),
});
delete env.EVOLVE_BRIDGE;
delete env.OPENCLAW_WORKSPACE;
// Clear NODE_TEST_CONTEXT so nested runs from within node --test work.
delete env.NODE_TEST_CONTEXT;

try {
  const output = execFileSync(process.execPath, ['--test', ...files], {
    cwd: EVOLVER_REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 600000,
    env,
  });
  const out = output.toString('utf8');
  const passMatch = out.match(/pass (\d+)/);
  const failMatch = out.match(/fail (\d+)/);
  const passCount = passMatch ? Number(passMatch[1]) : 0;
  const failCount = failMatch ? Number(failMatch[1]) : 0;

  if (failCount > 0) {
    console.error('FAIL: ' + failCount + ' test(s) failed');
    process.exit(1);
  }
  if (passCount === 0) {
    console.error('FAIL: no tests found');
    process.exit(1);
  }
  console.log('ok: ' + passCount + ' test(s) passed, 0 failed');
} catch (e) {
  const stderr = e.stderr ? e.stderr.toString('utf8').slice(-500) : '';
  const stdout = e.stdout ? e.stdout.toString('utf8').slice(-500) : '';
  console.error('FAIL: test suite exited with code ' + (e.status || 'unknown'));
  if (stderr) console.error(stderr);
  if (stdout) console.error(stdout);
  process.exit(1);
}
