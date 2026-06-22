// Issue #528: Windows-friendly spawn-replacement policy.
//
// On Windows, child_process.spawn(detached: true, windowsHide: true) opens a
// new conhost window every restart, so the v1.78.x and v1.79.0 daemon
// suicide-respawn produced cmd popups whenever a Windows daemon hit
// EVOLVER_MAX_CYCLES (100) or EVOLVER_MAX_RSS_MB (500). v1.79.1 makes the
// in-process respawn opt-in on Windows and falls back to "exit non-zero +
// let the supervisor restart us".

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

// Keep this VM slice instead of require('..'): loading the full daemon entrypoint
// would run top-level bootstrapping and can start long-lived proxy/evolver side
// effects before these helper-only assertions execute.
function loadSpawnReplacementProcess() {
  const indexPath = path.resolve(__dirname, '..', 'index.js');
  const source = fs.readFileSync(indexPath, 'utf8');
  const start = source.indexOf('function parseBoolEnv(');
  const end = source.indexOf('\n// Atomic write of the cycle_progress.json file', start);
  assert.ok(start > 0, 'expected parseBoolEnv declaration');
  assert.ok(end > start, 'expected spawnReplacementProcess helper block');
  const script = [
    'const fs = require("fs");',
    'const { spawn } = require("child_process");',
    source.slice(start, end),
    'module.exports = { spawnReplacementProcess };',
  ].join('\n');
  const context = {
    module: { exports: {} },
    exports: {},
    require,
    process,
    console,
    __filename: indexPath,
  };
  vm.runInNewContext(script, context, { filename: indexPath });
  return context.module.exports.spawnReplacementProcess;
}

const spawnReplacementProcess = loadSpawnReplacementProcess();

// Helper: temporarily override process.platform without leaking state.
function withPlatform(value, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', desc);
  }
}

function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  }
}

describe('spawnReplacementProcess on Windows by default', () => {
  it('returns windows_default_skip without invoking spawn', () => {
    const result = withPlatform('win32', () =>
      withEnv('EVOLVER_SUICIDE_WINDOWS', undefined, () =>
        spawnReplacementProcess({
          reason: 'unit-test',
          args: ['--loop'],
          logPath: '/no/such/log/should-not-be-touched.log',
        })
      )
    );
    assert.equal(result.spawned, false);
    assert.equal(result.reason, 'windows_default_skip');
  });

  it('also skips when EVOLVER_SUICIDE_WINDOWS=false (explicit opt-out)', () => {
    const result = withPlatform('win32', () =>
      withEnv('EVOLVER_SUICIDE_WINDOWS', 'false', () =>
        spawnReplacementProcess({
          reason: 'unit-test',
          args: ['--loop'],
          logPath: '/no/such/log/should-not-be-touched.log',
        })
      )
    );
    assert.equal(result.spawned, false);
    assert.equal(result.reason, 'windows_default_skip');
  });
});

describe('spawnReplacementProcess on Windows with EVOLVER_SUICIDE_WINDOWS=true', () => {
  it('crosses the gate and reaches the spawn try-block (escape hatch)', () => {
    // We force fs.openSync to fail by passing a non-existent dir, which
    // makes the helper return spawned:false reason:spawn_error WITHOUT
    // actually starting a child process. That is enough to prove the
    // env opt-in works -- if the gate were still rejecting we'd see
    // windows_default_skip instead.
    const result = withPlatform('win32', () =>
      withEnv('EVOLVER_SUICIDE_WINDOWS', 'true', () =>
        spawnReplacementProcess({
          reason: 'unit-test',
          args: ['--loop'],
          logPath: '/definitely-not-a-real-dir-for-this-test/log.txt',
        })
      )
    );
    assert.equal(result.spawned, false);
    assert.equal(result.reason, 'spawn_error');
    assert.ok(result.error, 'should surface the spawn-side error');
  });
});

describe('spawnReplacementProcess on non-Windows platforms', () => {
  it('skips the Windows gate (fs.openSync becomes the only failure point here)', () => {
    const result = withPlatform('linux', () =>
      withEnv('EVOLVER_SUICIDE_WINDOWS', undefined, () =>
        spawnReplacementProcess({
          reason: 'unit-test',
          args: ['--loop'],
          logPath: '/definitely-not-a-real-dir-for-this-test/log.txt',
        })
      )
    );
    assert.equal(result.spawned, false);
    assert.equal(result.reason, 'spawn_error',
      'on Linux the gate must not reject; only the spawn side should fail');
  });

  it('also lets darwin through the gate', () => {
    const result = withPlatform('darwin', () =>
      withEnv('EVOLVER_SUICIDE_WINDOWS', undefined, () =>
        spawnReplacementProcess({
          reason: 'unit-test',
          args: ['--loop'],
          logPath: '/definitely-not-a-real-dir-for-this-test/log.txt',
        })
      )
    );
    assert.equal(result.spawned, false);
    assert.equal(result.reason, 'spawn_error');
  });
});

describe('index.js source-level guards (Issue #528 regression)', () => {
  const indexPath = path.resolve(__dirname, '..', 'index.js');
  const source = fs.readFileSync(indexPath, 'utf8');

  it('no longer hand-rolls spawn(process.execPath, [__filename, ...args]) anywhere', () => {
    // The only acceptable place for spawn(process.execPath, ...) is INSIDE
    // spawnReplacementProcess(). We spot the helper's body by looking for
    // the function declaration line, then assert no other occurrence of the
    // raw spawn call exists outside it.
    const helperStart = source.indexOf('function spawnReplacementProcess(');
    assert.ok(helperStart > 0, 'expected spawnReplacementProcess function declaration');
    const helperEnd = source.indexOf('\nfunction ', helperStart + 1);
    assert.ok(helperEnd > helperStart, 'expected helper to be followed by another top-level function');
    const before = source.slice(0, helperStart);
    const after = source.slice(helperEnd);
    const offending = (before + after).match(/spawn\(process\.execPath,\s*\[__filename/g);
    assert.equal(offending, null,
      'every detached respawn must go through spawnReplacementProcess; ' +
      'found a raw spawn(process.execPath, [__filename, ...args]) outside the helper');
  });

  it('cycle hard-timeout branch goes through spawnReplacementProcess', () => {
    assert.match(source,
      /CYCLE_TIMEOUT[\s\S]*?spawnReplacementProcess\(\{[\s\S]*?reason: 'cycle_hard_timeout'/,
      'CYCLE_TIMEOUT branch must call spawnReplacementProcess with reason cycle_hard_timeout');
  });

  it('cycles>=max / RSS branch goes through spawnReplacementProcess', () => {
    assert.match(source,
      /Restarting self[\s\S]*?spawnReplacementProcess\(\{[\s\S]*?reason: 'max_cycles_or_rss'/,
      'max_cycles branch must call spawnReplacementProcess with reason max_cycles_or_rss');
  });

  it('windows_default_skip branch exits with code 1 (so supervisor respawns)', () => {
    assert.match(source,
      /result\.reason === 'windows_default_skip'[\s\S]*?process\.exit\(1\)/,
      'when helper returns windows_default_skip the daemon must exit(1)');
  });

  it('helper documents EVOLVER_SUICIDE_WINDOWS escape hatch', () => {
    assert.match(source, /EVOLVER_SUICIDE_WINDOWS/,
      'env var name must be referenced in source for discoverability');
  });
});

describe('Windows no-console process launch guards', () => {
  it('idle scheduler runs PowerShell without shelling through a visible console host', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'gep', 'idleScheduler.js'), 'utf8');
    assert.doesNotMatch(source, /execSync\('powershell\b/,
      'Windows idle detection must not use execSync("powershell ..."), which shells through cmd.exe');
    assert.match(source, /execFileSync\('powershell',\s*\[[\s\S]*?windowsHide:\s*true/,
      'Windows idle detection must use execFileSync(..., windowsHide: true)');
  });

  it('ops lifecycle hides Windows process scans, daemon start, and taskkill', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ops', 'lifecycle.js'), 'utf8');
    assert.doesNotMatch(source, /execText\('powershell\b/,
      'Windows process scans must not shell through cmd.exe');
    assert.match(source, /function execFileText\(file, args\)[\s\S]*?execFileSync\(file, args,[\s\S]*?windowsHide:\s*true/,
      'Windows process scans must use execFileSync(..., windowsHide: true)');
    assert.match(source, /spawn\(process\.execPath,\s*\[script, '--loop'\],[\s\S]*?windowsHide:\s*true/,
      'detached lifecycle start must hide any Windows child window');
    assert.match(source, /execFileSync\('taskkill',\s*\['\/F', '\/PID', String\(remaining\[j\]\)\],[\s\S]*?windowsHide:\s*true/,
      'Windows taskkill fallback must hide the child window');
  });

  it('session-start auto-restart does not spawn a visible Windows child', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'adapters', 'scripts', 'evolver-session-start.js'), 'utf8');
    assert.match(source, /spawn\(\s*process\.execPath,\s*\[lifecyclePath, 'start'\],[\s\S]*?windowsHide:\s*true/,
      'session-start daemon auto-restart must pass windowsHide: true');
  });

  it('adapter git probes hide child windows on Windows', () => {
    const sessionEnd = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'adapters', 'scripts', 'evolver-session-end.js'), 'utf8');
    const runtimePaths = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'adapters', 'scripts', '_runtimePaths.js'), 'utf8');
    assert.match(sessionEnd, /spawnSync\('git', args,[\s\S]*?shell:\s*false,[\s\S]*?windowsHide:\s*true/);
    assert.match(runtimePaths, /spawnSync\('git', \['rev-parse', '--is-inside-work-tree'\],[\s\S]*?shell:\s*false,[\s\S]*?windowsHide:\s*true/);
  });

  it('daemon loop git probes hide child windows on Windows', () => {
    const indexSource = fs.readFileSync(path.resolve(__dirname, '..', 'index.js'), 'utf8');
    const gitOpsSource = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'gep', 'gitOps.js'), 'utf8');
    assert.match(indexSource, /execSync\('git --version'[\s\S]*?windowsHide:\s*true/);
    assert.match(indexSource, /execSync\('git diff'[\s\S]*?windowsHide:\s*true/);
    assert.match(indexSource, /execSync\('git ls-files --others --exclude-standard'[\s\S]*?windowsHide:\s*true/);
    assert.match(gitOpsSource, /function runCmd[\s\S]*?execSync\(cmd,[\s\S]*?windowsHide:\s*true/);
    assert.match(gitOpsSource, /execSync\('git rev-parse --git-dir'[\s\S]*?windowsHide:\s*true/);
  });
});
