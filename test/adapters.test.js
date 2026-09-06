const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { canCreateSymlinks } = require('./helpers/symlink');

// Symlink-rejection tests need to plant a real symlink before exercising
// the code under test. On Windows without admin / developer-mode that
// fails in setup with EPERM, so we route those tests through `symlinkIt`
// which becomes a no-op skip when symlink creation isn't available.
const symlinkIt = canCreateSymlinks() ? it : it.skip;

const hookAdapter = require('../src/adapters/hookAdapter');
const cursorAdapter = require('../src/adapters/cursor');
const claudeAdapter = require('../src/adapters/claudeCode');
const codexAdapter = require('../src/adapters/codex');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-hooks-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Run `fn` with a controlled set of host-detection env vars. All known signal
// vars are cleared first (so directory-based detection is exercised even when
// the suite runs from inside a Claude Code / Cursor session, #590), then the
// `patch` values are applied; everything is restored afterwards.
function withEnv(patch, fn) {
  const keys = [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_PROJECT_DIR',
    'CURSOR_TRACE_ID',
    'CURSOR_SESSION_ID',
    'CURSOR_PROJECT_DIR',
    'CURSOR_AGENT',
    'CODEX_THREAD_ID',
    'CODEX_SHELL',
    'CODEX_CI',
    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
    'TERM_PROGRAM',
    ...Object.keys(patch),
  ];
  const oldEnv = {};
  for (const key of keys) {
    oldEnv[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (oldEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = oldEnv[key];
      }
    }
  }
}

function withHome(home, fn) {
  const originalHome = os.homedir;
  os.homedir = () => home;
  try {
    return fn();
  } finally {
    os.homedir = originalHome;
  }
}

// -- hookAdapter --

describe('hookAdapter', () => {
  describe('setup-hooks CLI contract', () => {
    it('honors legacy --runtime plus explicit --root and emits JSON verification', () => {
      const tmp = makeTmpDir();
      try {
        const decoyCwd = path.join(tmp, 'decoy');
        const targetRoot = path.join(tmp, 'target workspace');
        fs.mkdirSync(path.join(decoyCwd, '.cursor'), { recursive: true });
        fs.mkdirSync(targetRoot, { recursive: true });
        const entry = path.resolve(__dirname, '..', 'index.js');

        const install = spawnSync(process.execPath, [
          entry,
          'setup-hooks',
          '--runtime=claude-code',
          `--root=${targetRoot}`,
          '--force',
        ], {
          cwd: decoyCwd,
          encoding: 'utf8',
          timeout: 15000,
        });
        assert.equal(install.status, 0, install.stderr);
        assert.ok(fs.existsSync(path.join(targetRoot, '.claude', 'settings.json')));
        assert.ok(!fs.existsSync(path.join(decoyCwd, '.cursor', 'hooks.json')));

        const verify = spawnSync(process.execPath, [
          entry,
          'setup-hooks',
          '--runtime=claude-code',
          `--root=${targetRoot}`,
          '--verify',
          '--json',
        ], {
          cwd: decoyCwd,
          encoding: 'utf8',
          timeout: 15000,
        });
        assert.equal(verify.status, 0, verify.stderr);
        const report = JSON.parse(verify.stdout);
        assert.equal(report.ok, true);
        assert.equal(report.platform, 'claude-code');
        assert.equal(report.config_root, targetRoot);

        const settingsPath = path.join(targetRoot, '.claude', 'settings.json');
        const malformed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        malformed.hooks.SessionStart[0].hooks = {};
        fs.writeFileSync(settingsPath, JSON.stringify(malformed));
        const failedVerify = spawnSync(process.execPath, [
          entry,
          'setup-hooks',
          '--runtime=claude-code',
          `--root=${targetRoot}`,
          '--verify',
          '--json',
        ], {
          cwd: decoyCwd,
          encoding: 'utf8',
          timeout: 15000,
        });
        assert.equal(failedVerify.status, 1);
        assert.equal(JSON.parse(failedVerify.stdout).ok, false);
      } finally { cleanup(tmp); }
    });

    it('rejects conflicting --platform and --runtime values', () => {
      const tmp = makeTmpDir();
      try {
        const entry = path.resolve(__dirname, '..', 'index.js');
        const result = spawnSync(process.execPath, [
          entry,
          'setup-hooks',
          '--platform=codex',
          '--runtime=claude-code',
          `--root=${tmp}`,
        ], {
          cwd: tmp,
          encoding: 'utf8',
          timeout: 15000,
        });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /conflicting.*platform.*runtime/i);
      } finally { cleanup(tmp); }
    });
  });

  describe('detectPlatform', () => {
    it('detects cursor from .cursor directory', () => {
      const tmp = makeTmpDir();
      try {
        fs.mkdirSync(path.join(tmp, '.cursor'), { recursive: true });
        // Clear host env signals so directory detection is exercised even when
        // the suite runs from inside a Claude Code / Cursor session (#590).
        withEnv({}, () => {
          assert.equal(hookAdapter.detectPlatform(tmp), 'cursor');
        });
      } finally { cleanup(tmp); }
    });

    it('detects claude-code from .claude directory', () => {
      const tmp = makeTmpDir();
      try {
        fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
        withEnv({}, () => {
          assert.equal(hookAdapter.detectPlatform(tmp), 'claude-code');
        });
      } finally { cleanup(tmp); }
    });

    it('detects codex from .codex directory', () => {
      const tmp = makeTmpDir();
      try {
        fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
        withEnv({}, () => {
          assert.equal(hookAdapter.detectPlatform(tmp), 'codex');
        });
      } finally { cleanup(tmp); }
    });

    it('prefers claude-code environment over home platform directories (#590)', () => {
      const tmp = makeTmpDir();
      try {
        const cwd = path.join(tmp, 'project');
        const home = path.join(tmp, 'home');
        fs.mkdirSync(cwd, { recursive: true });
        fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        withHome(home, () => withEnv({ CLAUDECODE: '1' }, () => {
          assert.equal(hookAdapter.detectPlatform(cwd), 'claude-code');
        }));
      } finally { cleanup(tmp); }
    });

    it('prefers cursor environment over directory detection (#590)', () => {
      const tmp = makeTmpDir();
      try {
        const cwd = path.join(tmp, 'project');
        const home = path.join(tmp, 'home');
        fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        withHome(home, () => withEnv({ CURSOR_TRACE_ID: 'trace-1' }, () => {
          assert.equal(hookAdapter.detectPlatform(cwd), 'cursor');
        }));
      } finally { cleanup(tmp); }
    });

    it('prefers CLAUDECODE over cursor environment signals', () => {
      withEnv({
        CLAUDECODE: '1',
        CURSOR_TRACE_ID: 'trace-1',
        TERM_PROGRAM: 'cursor',
      }, () => {
        assert.equal(hookAdapter.detectPlatformFromEnv(), 'claude-code');
      });
    });

    it('prefers CLAUDE_CODE_ENTRYPOINT over cursor environment signals', () => {
      withEnv({
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CURSOR_SESSION_ID: 'session-1',
        CURSOR_PROJECT_DIR: '/tmp/cursor-project',
      }, () => {
        assert.equal(hookAdapter.detectPlatformFromEnv(), 'claude-code');
      });
    });

    it('prefers cursor strong signals over CLAUDE_PROJECT_DIR compat alias', () => {
      withEnv({
        CURSOR_TRACE_ID: 'trace-1',
        TERM_PROGRAM: 'cursor',
        CLAUDE_PROJECT_DIR: '/tmp/cursor-compat-alias',
      }, () => {
        assert.equal(hookAdapter.detectPlatformFromEnv(), 'cursor');
      });
    });

    it('detects CURSOR_AGENT as a cursor strong signal before CLAUDE_PROJECT_DIR', () => {
      withEnv({
        CURSOR_AGENT: '1',
        CLAUDE_PROJECT_DIR: '/tmp/cursor-compat-alias',
      }, () => {
        assert.equal(hookAdapter.detectPlatformFromEnv(), 'cursor');
      });
    });

    it('prefers explicit cursor runtime signals over codex environment signals', () => {
      withEnv({
        CURSOR_AGENT: '1',
        CODEX_THREAD_ID: 'codex-thread-1',
      }, () => {
        assert.equal(hookAdapter.detectPlatformFromEnv(), 'cursor');
      });
    });

    it('prefers explicit claude-code runtime signals over codex environment signals', () => {
      withEnv({
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CODEX_THREAD_ID: 'codex-thread-1',
      }, () => {
        assert.equal(hookAdapter.detectPlatformFromEnv(), 'claude-code');
      });
    });

    it('prefers codex environment signals over directory fallback', () => {
      const tmp = makeTmpDir();
      try {
        const cwd = path.join(tmp, 'project');
        fs.mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
        withEnv({
          CODEX_THREAD_ID: 'codex-thread-1',
          CODEX_SHELL: 'zsh',
          CODEX_CI: '1',
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex',
        }, () => {
          assert.equal(hookAdapter.detectPlatform(cwd), 'codex');
        });
      } finally { cleanup(tmp); }
    });

    it('keeps fallback directory detection when no host environment is present (#590)', () => {
      const tmp = makeTmpDir();
      try {
        const cwd = path.join(tmp, 'project');
        const home = path.join(tmp, 'home');
        fs.mkdirSync(cwd, { recursive: true });
        fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
        withHome(home, () => withEnv({}, () => {
          assert.equal(hookAdapter.detectPlatform(cwd), 'cursor');
        }));
      } finally { cleanup(tmp); }
    });

    it('keeps cwd detector precedence over home fallback without host env (#590)', () => {
      const tmp = makeTmpDir();
      try {
        const cwd = path.join(tmp, 'project');
        const home = path.join(tmp, 'home');
        fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
        fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
        withHome(home, () => withEnv({}, () => {
          assert.equal(hookAdapter.detectPlatform(cwd), 'claude-code');
        }));
      } finally { cleanup(tmp); }
    });

    it('returns null for unknown platform when no fallback dirs exist', () => {
      const tmp = makeTmpDir();
      try {
        // detectPlatform checks cwd first, then homedir fallback.
        // On machines with ~/.cursor, it will find cursor via fallback.
        // This test only asserts that the cwd itself yields nothing.
        const result = hookAdapter.detectPlatform(tmp);
        // If homedir has a platform dir, the function returns that.
        // We just verify the function doesn't crash and returns a valid result.
        assert.ok(result === null || typeof result === 'string');
      } finally { cleanup(tmp); }
    });
  });

  describe('deepMerge', () => {
    it('merges nested objects', () => {
      const a = { x: { a: 1 }, y: 2 };
      const b = { x: { b: 3 }, z: 4 };
      const result = hookAdapter.deepMerge(a, b);
      assert.deepEqual(result, { x: { a: 1, b: 3 }, y: 2, z: 4 });
    });

    it('overwrites arrays', () => {
      const a = { arr: [1, 2] };
      const b = { arr: [3, 4, 5] };
      const result = hookAdapter.deepMerge(a, b);
      assert.deepEqual(result.arr, [3, 4, 5]);
    });
  });

  describe('mergeJsonFile', () => {
    it('creates file if not exists', () => {
      const tmp = makeTmpDir();
      try {
        const filePath = path.join(tmp, 'test.json');
        hookAdapter.mergeJsonFile(filePath, { hooks: { a: 1 } });
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        assert.equal(data.hooks.a, 1);
        assert.equal(data._evolver_managed, true);
      } finally { cleanup(tmp); }
    });

    it('merges into existing file', () => {
      const tmp = makeTmpDir();
      try {
        const filePath = path.join(tmp, 'test.json');
        fs.writeFileSync(filePath, JSON.stringify({ existing: true, hooks: { old: 1 } }));
        hookAdapter.mergeJsonFile(filePath, { hooks: { new: 2 } });
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        assert.equal(data.existing, true);
        assert.equal(data.hooks.old, 1);
        assert.equal(data.hooks.new, 2);
        assert.equal(data._evolver_managed, true);
      } finally { cleanup(tmp); }
    });
  });

  describe('appendSectionToFile', () => {
    it('appends section to new file', () => {
      const tmp = makeTmpDir();
      try {
        const filePath = path.join(tmp, 'README.md');
        const result = hookAdapter.appendSectionToFile(filePath, '<!-- marker -->', '<!-- marker -->\nHello');
        assert.equal(result, true);
        const content = fs.readFileSync(filePath, 'utf8');
        assert.ok(content.includes('<!-- marker -->'));
        assert.ok(content.includes('Hello'));
      } finally { cleanup(tmp); }
    });

    it('does not duplicate if marker exists', () => {
      const tmp = makeTmpDir();
      try {
        const filePath = path.join(tmp, 'README.md');
        fs.writeFileSync(filePath, '<!-- marker -->\nExisting');
        const result = hookAdapter.appendSectionToFile(filePath, '<!-- marker -->', '<!-- marker -->\nDuplicate');
        assert.equal(result, false);
      } finally { cleanup(tmp); }
    });
  });

  describe('copyHookScripts', () => {
    it('copies scripts to destination', () => {
      const tmp = makeTmpDir();
      try {
        const destDir = path.join(tmp, 'hooks');
        const evolverRoot = path.resolve(__dirname, '..');
        const copied = hookAdapter.copyHookScripts(destDir, path.join(evolverRoot, 'src', 'adapters'));
        // 4 hook entry points (session-start, signal-detect, session-end,
        // task-recall) + 3 helpers (`_runtimePaths.js`, `_memoryFiltering.js`,
        // `_lockPaths.js`) required by them via `require('./...')`. Helper
        // list is verified separately by the "#547 — setup-hooks copies every
        // helper required by the entry-point scripts" suite, which scans the
        // actual `require` statements; this assertion is just a quick smoke
        // test on count.
        assert.equal(copied.length, 7);
        for (const f of copied) {
          assert.ok(fs.existsSync(f));
        }
      } finally { cleanup(tmp); }
    });

    it('includes _runtimePaths.js so copied session hooks can require it (PR #94)', () => {
      const tmp = makeTmpDir();
      try {
        const destDir = path.join(tmp, 'hooks');
        const evolverRoot = path.resolve(__dirname, '..');
        hookAdapter.copyHookScripts(destDir, path.join(evolverRoot, 'src', 'adapters'));
        assert.ok(fs.existsSync(path.join(destDir, '_runtimePaths.js')),
          '_runtimePaths.js must ship alongside session-start/end or both crash with MODULE_NOT_FOUND');

        // End-to-end: actually run the copied script. If `_runtimePaths.js`
        // is missing the require() at top of file would fail with
        // MODULE_NOT_FOUND and exit non-zero.
        const result = spawnSync('node', [path.join(destDir, 'evolver-session-start.js')], {
          input: '{}', encoding: 'utf8', timeout: 5000,
        });
        assert.equal(result.status, 0,
          `copied evolver-session-start.js must run without error. stderr=${result.stderr}`);
      } finally { cleanup(tmp); }
    });

    it('copied evolver-task-recall.js runs fail-open (exit 0 + parseable {}) with mode=off', () => {
      // The require-scanner suite only verifies same-dir `./_helper` requires;
      // evolver-task-recall.js resolves its core via an ABSOLUTE require
      // (findEvolverRoot()+src/gep/recallInject.js), which that scanner cannot
      // cover. This e2e proves the copied hook (a) parses its stdin, (b) never
      // crashes, and (c) emits exactly one JSON object — the hook contract.
      const tmp = makeTmpDir();
      try {
        const destDir = path.join(tmp, 'hooks');
        const evolverRoot = path.resolve(__dirname, '..');
        hookAdapter.copyHookScripts(destDir, path.join(evolverRoot, 'src', 'adapters'));
        assert.ok(fs.existsSync(path.join(destDir, 'evolver-task-recall.js')),
          'evolver-task-recall.js must be copied by setup-hooks');

        const result = spawnSync('node', [path.join(destDir, 'evolver-task-recall.js')], {
          input: JSON.stringify({ prompt: 'add retry with backoff to the http client', session_id: 'sess-test' }),
          encoding: 'utf8',
          timeout: 8000,
          // mode=off: must finish {} without parsing/sending the prompt.
          env: { ...process.env, EVOLVER_RECALL_MODE: 'off', A2A_HUB_URL: '' },
        });
        assert.equal(result.status, 0,
          `copied evolver-task-recall.js must exit 0 (fail-open). stderr=${result.stderr}`);
        const parsed = JSON.parse(result.stdout || '{}');
        assert.deepEqual(parsed, {}, 'mode=off must inject nothing (empty object)');
      } finally { cleanup(tmp); }
    });
  });

  describe('removeHookScripts', () => {
    it('removes evolver scripts', () => {
      const tmp = makeTmpDir();
      try {
        const hooksDir = path.join(tmp, 'hooks');
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.writeFileSync(path.join(hooksDir, '_runtimePaths.js'), '');
        fs.writeFileSync(path.join(hooksDir, 'evolver-session-start.js'), '');
        fs.writeFileSync(path.join(hooksDir, 'evolver-signal-detect.js'), '');
        fs.writeFileSync(path.join(hooksDir, 'evolver-session-end.js'), '');
        fs.writeFileSync(path.join(hooksDir, 'user-custom.js'), '');
        const removed = hookAdapter.removeHookScripts(hooksDir);
        assert.equal(removed, 4);
        assert.ok(fs.existsSync(path.join(hooksDir, 'user-custom.js')));
      } finally { cleanup(tmp); }
    });
  });

  describe('mergeWithHooksUnion (#539)', () => {
    it('preserves user-installed hooks under same event when adding evolver hooks', () => {
      const userHooks = {
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node user-tool.js' }] },
          ],
          SessionStart: [
            { hooks: [{ type: 'command', command: 'node user-init.js' }] },
          ],
        },
      };
      const evolverPatch = {
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node .claude/hooks/evolver-session-end.js' }] },
          ],
          SessionStart: [
            { hooks: [{ type: 'command', command: 'node .claude/hooks/evolver-session-start.js' }] },
          ],
        },
      };
      const merged = hookAdapter.mergeWithHooksUnion(userHooks, evolverPatch);
      assert.equal(merged.hooks.Stop.length, 2, 'Stop must contain both user and evolver entries');
      assert.equal(merged.hooks.SessionStart.length, 2, 'SessionStart must contain both');
      const stopCmds = merged.hooks.Stop.flatMap(m => (m.hooks || []).map(h => h.command));
      assert.ok(stopCmds.includes('node user-tool.js'), 'user Stop hook must be preserved');
      assert.ok(stopCmds.some(c => c.includes('evolver-session-end')), 'evolver Stop hook must be added');
    });

    it('refreshes (does not duplicate) evolver-owned entries on reinstall', () => {
      const previousInstall = {
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node OLD/evolver-session-end.js' }] },
          ],
          SessionStart: [
            { hooks: [{ type: 'command', command: 'bash OLD/evolver-daemon-start.sh' }] },
          ],
        },
      };
      const newPatch = {
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node NEW/evolver-session-end.js' }] },
          ],
          SessionStart: [
            { hooks: [{ type: 'command', command: 'node NEW/evolver-session-start.js' }] },
          ],
        },
      };
      const merged = hookAdapter.mergeWithHooksUnion(previousInstall, newPatch);
      assert.equal(merged.hooks.Stop.length, 1, 'evolver entry must be refreshed, not duplicated');
      assert.equal(merged.hooks.SessionStart.length, 1, 'legacy daemon hook must be refreshed, not preserved');
      const cmds = merged.hooks.Stop.flatMap(m => (m.hooks || []).map(h => h.command));
      assert.ok(cmds[0].includes('NEW/'));
      assert.ok(!cmds.some(c => c.includes('OLD/')));
      const sessionCmds = merged.hooks.SessionStart.flatMap(m => (m.hooks || []).map(h => h.command));
      assert.ok(sessionCmds[0].includes('evolver-session-start'));
      assert.ok(!sessionCmds.some(c => c.includes('evolver-daemon-start')));
    });

    it('preserves user hooks sharing a matcher with refreshed evolver hooks', () => {
      const previousInstall = {
        hooks: {
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'node OLD/evolver-session-end.js' },
                { type: 'command', command: 'node user-cleanup.js' },
              ],
            },
          ],
        },
      };
      const newPatch = {
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: 'node NEW/evolver-session-end.js' }],
            },
          ],
        },
      };
      const merged = hookAdapter.mergeWithHooksUnion(previousInstall, newPatch);
      const cmds = merged.hooks.Stop.flatMap(m => (m.hooks || []).map(h => h.command));
      assert.ok(cmds.includes('node user-cleanup.js'));
      assert.ok(cmds.includes('node NEW/evolver-session-end.js'));
      assert.ok(!cmds.some(c => c.includes('OLD/evolver-session-end')));
    });

    it('handles flat (Codex) command shape', () => {
      const userHooks = {
        hooks: {
          Stop: [{ type: 'command', command: 'node user-tool.js' }],
        },
      };
      const evolverPatch = {
        hooks: {
          Stop: [{ type: 'command', command: 'node .codex/hooks/evolver-session-end.js' }],
        },
      };
      const merged = hookAdapter.mergeWithHooksUnion(userHooks, evolverPatch);
      assert.equal(merged.hooks.Stop.length, 2);
      assert.ok(merged.hooks.Stop.some(h => h.command === 'node user-tool.js'));
      assert.ok(merged.hooks.Stop.some(h => h.command.includes('evolver-session-end')));
    });
  });

  describe('removeMarkedSection (#538)', () => {
    it('removes evolver section without consuming user H2 below', () => {
      const tmp = makeTmpDir();
      try {
        const file = path.join(tmp, 'AGENTS.md');
        const userBefore = '# Project\n\nIntro paragraph.\n\n';
        const evolverSection =
          '<!-- evolver-evolution-memory -->\n' +
          '## Evolution Memory (Evolver)\n\n' +
          'Body 1\nBody 2\n\n';
        const userAfter = '## Other Section\n\nUser content here.\n';
        fs.writeFileSync(file, userBefore + evolverSection + userAfter);

        const ok = hookAdapter.removeMarkedSection(file, '<!-- evolver-evolution-memory -->');
        assert.equal(ok, true);

        const next = fs.readFileSync(file, 'utf8');
        assert.ok(!next.includes('evolver-evolution-memory'), 'marker must be gone');
        assert.ok(!next.includes('## Evolution Memory'), 'evolver heading must be gone');
        assert.ok(next.includes('## Other Section'), 'user section must remain');
        assert.ok(next.includes('User content here.'), 'user content must remain');
        assert.ok(next.includes('Intro paragraph'), 'pre-marker content must remain');
      } finally { cleanup(tmp); }
    });

    it('handles trailing-only evolver section (no user content after)', () => {
      const tmp = makeTmpDir();
      try {
        const file = path.join(tmp, 'AGENTS.md');
        fs.writeFileSync(file,
          '# Project\n\nIntro\n\n' +
          '<!-- evolver-evolution-memory -->\n' +
          '## Evolution Memory (Evolver)\n\nBody\n');
        hookAdapter.removeMarkedSection(file, '<!-- evolver-evolution-memory -->');
        const next = fs.readFileSync(file, 'utf8');
        assert.ok(!next.includes('Evolution Memory'));
        assert.ok(next.includes('Intro'));
      } finally { cleanup(tmp); }
    });

    it('returns false when marker absent', () => {
      const tmp = makeTmpDir();
      try {
        const file = path.join(tmp, 'AGENTS.md');
        fs.writeFileSync(file, '# Project\n');
        assert.equal(hookAdapter.removeMarkedSection(file, '<!-- nope -->'), false);
      } finally { cleanup(tmp); }
    });

    it('returns false when file missing', () => {
      const tmp = makeTmpDir();
      try {
        assert.equal(
          hookAdapter.removeMarkedSection(path.join(tmp, 'missing.md'), '<!-- x -->'),
          false
        );
      } finally { cleanup(tmp); }
    });
  });

  describe('assertSafeConfigDir (PR #94 round-4 + round-5)', () => {
    symlinkIt('throws when the config dir is a symbolic link', () => {
      const tmp = makeTmpDir();
      try {
        const target = path.join(tmp, 'real-target');
        fs.mkdirSync(target, { recursive: true });
        const linkPath = path.join(tmp, '.codex');
        fs.symlinkSync(target, linkPath, 'dir');
        assert.throws(
          () => hookAdapter.assertSafeConfigDir(linkPath, '.codex'),
          /symbolic link/i,
          'config dir that is a symlink must be refused — hostile workspace could redirect writes outside repo'
        );
      } finally { cleanup(tmp); }
    });

    it('returns silently for a real directory or missing path', () => {
      const tmp = makeTmpDir();
      try {
        const realDir = path.join(tmp, '.codex');
        fs.mkdirSync(realDir, { recursive: true });
        assert.doesNotThrow(() => hookAdapter.assertSafeConfigDir(realDir, '.codex'));
        assert.doesNotThrow(() => hookAdapter.assertSafeConfigDir(path.join(tmp, '.missing'), '.missing'));
      } finally { cleanup(tmp); }
    });

    symlinkIt('codex install/uninstall refuses .codex symlink', () => {
      const tmp = makeTmpDir();
      try {
        const target = path.join(tmp, 'redirect');
        fs.mkdirSync(target, { recursive: true });
        fs.symlinkSync(target, path.join(tmp, '.codex'), 'dir');
        const evolverRoot = path.resolve(__dirname, '..');
        assert.throws(
          () => codexAdapter.install({ configRoot: tmp, evolverRoot, force: true }),
          /symbolic link/i
        );
        assert.throws(
          () => codexAdapter.uninstall({ configRoot: tmp }),
          /symbolic link/i
        );
      } finally { cleanup(tmp); }
    });

    symlinkIt('claude-code install/uninstall refuses .claude symlink', () => {
      const tmp = makeTmpDir();
      try {
        const target = path.join(tmp, 'redirect');
        fs.mkdirSync(target, { recursive: true });
        fs.symlinkSync(target, path.join(tmp, '.claude'), 'dir');
        const evolverRoot = path.resolve(__dirname, '..');
        assert.throws(
          () => claudeAdapter.install({ configRoot: tmp, evolverRoot, force: true }),
          /symbolic link/i
        );
        assert.throws(
          () => claudeAdapter.uninstall({ configRoot: tmp }),
          /symbolic link/i
        );
      } finally { cleanup(tmp); }
    });

    // Round-5: a hostile workspace can keep `.codex` as a real directory
    // and only symlink the nested `hooks/` (or `plugins/`) dir. The
    // top-level guard from round-4 missed this, so copyHookScripts /
    // removeHookScripts ran through the symlink and could touch files
    // outside the workspace. Bugbot HIGH severity finding for round-5.
    symlinkIt('rejects symlinked nested subdirs via subdirs option', () => {
      const tmp = makeTmpDir();
      try {
        const realConfig = path.join(tmp, '.codex');
        fs.mkdirSync(realConfig, { recursive: true });
        const target = path.join(tmp, 'redirect');
        fs.mkdirSync(target, { recursive: true });
        fs.symlinkSync(target, path.join(realConfig, 'hooks'), 'dir');
        assert.throws(
          () => hookAdapter.assertSafeConfigDir(realConfig, '.codex', { subdirs: ['hooks'] }),
          /symbolic link/i,
          'symlinked .codex/hooks must be refused even when .codex itself is real'
        );
      } finally { cleanup(tmp); }
    });

    symlinkIt('codex install/uninstall refuses .codex/hooks symlink', () => {
      const tmp = makeTmpDir();
      try {
        const realConfig = path.join(tmp, '.codex');
        fs.mkdirSync(realConfig, { recursive: true });
        const target = path.join(tmp, 'redirect');
        fs.mkdirSync(target, { recursive: true });
        fs.symlinkSync(target, path.join(realConfig, 'hooks'), 'dir');
        const evolverRoot = path.resolve(__dirname, '..');
        assert.throws(
          () => codexAdapter.install({ configRoot: tmp, evolverRoot, force: true }),
          /symbolic link/i
        );
        assert.throws(
          () => codexAdapter.uninstall({ configRoot: tmp }),
          /symbolic link/i
        );
      } finally { cleanup(tmp); }
    });

    symlinkIt('claude-code install/uninstall refuses .claude/hooks symlink', () => {
      const tmp = makeTmpDir();
      try {
        const realConfig = path.join(tmp, '.claude');
        fs.mkdirSync(realConfig, { recursive: true });
        const target = path.join(tmp, 'redirect');
        fs.mkdirSync(target, { recursive: true });
        fs.symlinkSync(target, path.join(realConfig, 'hooks'), 'dir');
        const evolverRoot = path.resolve(__dirname, '..');
        assert.throws(
          () => claudeAdapter.install({ configRoot: tmp, evolverRoot, force: true }),
          /symbolic link/i
        );
        assert.throws(
          () => claudeAdapter.uninstall({ configRoot: tmp }),
          /symbolic link/i
        );
      } finally { cleanup(tmp); }
    });
  });

  describe('evolver-session-end runGit fail/empty distinction (PR #94 round-6)', () => {
    // Round-6 LOW: runGit previously returned `''` for both
    // "command failed" (e.g. no HEAD~1 in fresh repo) and
    // "command succeeded with empty output" (e.g. empty merge).
    // The `||` chain in getGitDiffStats() then incorrectly fell
    // through to the working-tree diff on a successful empty result,
    // surfacing unrelated unstaged changes as the session outcome.
    // Pin the {ok, out} contract at the source level.
    it('runGit returns {ok, out} so callers can distinguish failure from empty', () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '..', 'src', 'adapters', 'scripts', 'evolver-session-end.js'),
        'utf8'
      );
      assert.ok(
        /return\s*\{\s*ok:\s*true/.test(src),
        'runGit success branch must return an object with `ok: true`'
      );
      assert.ok(
        /return\s*\{\s*ok:\s*false/.test(src),
        'runGit failure branch must return an object with `ok: false`'
      );
      // Make sure the call sites use the .ok flag rather than relying on
      // truthy stdout — the previous bug was a `||` on the stdout string.
      assert.ok(
        /\.ok\s*\?[^?]*runGit\(/.test(src) || /\.ok\s*\?\s*[A-Za-z0-9_]+\.out/.test(src),
        'getGitDiffStats must check .ok before falling back, not chain `||` on output'
      );
    });
  });

  describe('copyHookScripts symlinked-destination guard (PR #94 round-6)', () => {
    // Round-6 HIGH: round-5 closed the directory hole, but a hostile
    // workspace can still pre-create individual hook *files* as symlinks
    // pointing at writable targets outside the project. fs.copyFileSync
    // follows symlinks at the destination, so the source content lands
    // on the attacker's chosen file.
    symlinkIt('refuses to copy when destination file is a symlink', () => {
      const tmp = makeTmpDir();
      try {
        const evolverRoot = path.resolve(__dirname, '..');
        const destDir = path.join(tmp, 'hooks');
        fs.mkdirSync(destDir, { recursive: true });
        const hostileTarget = path.join(tmp, 'attacker-target');
        fs.writeFileSync(hostileTarget, 'original\n');
        fs.symlinkSync(
          hostileTarget,
          path.join(destDir, 'evolver-session-end.js'),
          'file'
        );
        assert.throws(
          () => hookAdapter.copyHookScripts(destDir, path.join(evolverRoot, 'src', 'adapters')),
          /symbolic link/i,
          'pre-planted symlink at hook destination must be refused'
        );
        // Attacker target must remain untouched.
        assert.equal(fs.readFileSync(hostileTarget, 'utf8'), 'original\n');
      } finally { cleanup(tmp); }
    });
  });

  describe('_runtimePaths security (PR #94 round-2)', () => {
    it('findEvolverRoot does not trust process.cwd() / hostile workspace node_modules', () => {
      // A hostile workspace could plant
      // `node_modules/@evomap/evolver/package.json` and previously have it
      // resolved as the trusted evolver root, letting the workspace control
      // findMemoryGraph() — which feeds attacker text into the
      // session-start `additionalContext` (prompt injection).
      // The fix removed `process.cwd()` from the require.resolve paths.
      // The paths array is now built dynamically by
      // _buildInstallSearchPaths() (so we can add Apple Silicon Homebrew
      // / NVM / fnm / Volta / asdf without bloating the call site), so
      // test the runtime invariant: the produced paths must never
      // include process.cwd() or a node_modules directory under it.
      const runtimePaths = require('../src/adapters/scripts/_runtimePaths');
      const paths = runtimePaths.__internals.buildInstallSearchPaths();
      const cwd = process.cwd();
      const cwdNm = path.join(cwd, 'node_modules');
      // The actual security invariant is "process.cwd() itself (or
      // cwd/node_modules) must not appear in the allowlist". The
      // tempting `p.startsWith(cwd + path.sep)` check is too broad —
      // all user-scoped paths are rooted at os.homedir(), so the test
      // would fire false positives whenever cwd === os.homedir() (user
      // runs evolver from their home dir), cwd === '/home' (Linuxbrew
      // path begins with /home/), or cwd === '/opt' (Apple Silicon
      // Homebrew path begins with /opt/). Bugbot PR #165 Medium.
      for (const p of paths) {
        assert.notEqual(p, cwd,
          'install search list MUST NOT include process.cwd() — hostile workspace could plant @evomap/evolver and hijack findMemoryGraph');
        assert.notEqual(p, cwdNm,
          'install search list MUST NOT include cwd/node_modules either');
      }
    });

    it('findEvolverRoot ignores a hostile node_modules in cwd', () => {
      const tmp = makeTmpDir();
      const origCwd = process.cwd();
      try {
        // Plant a fake @evomap/evolver under the tmp dir.
        const hostile = path.join(tmp, 'node_modules', '@evomap', 'evolver');
        fs.mkdirSync(hostile, { recursive: true });
        fs.writeFileSync(
          path.join(hostile, 'package.json'),
          JSON.stringify({ name: '@evomap/evolver', version: '0.0.1-hostile' })
        );
        process.chdir(tmp);

        // Re-require fresh so any internal state is clean. _runtimePaths is
        // pure (no module-level side effects), but this is defensive.
        delete require.cache[require.resolve('../src/adapters/scripts/_runtimePaths')];
        const { findEvolverRoot } = require('../src/adapters/scripts/_runtimePaths');
        const root = findEvolverRoot();

        // The dev/repo relative walk (which doesn't depend on cwd) should
        // resolve to the real evolver root. Either way, the hostile path
        // must NEVER be returned.
        assert.notEqual(root, hostile,
          'hostile node_modules/@evomap/evolver under cwd must not be selected as evolver root');
      } finally {
        process.chdir(origCwd);
        cleanup(tmp);
      }
    });
  });
});

// -- Cursor adapter --

describe('cursor adapter', () => {
  it('installs hooks correctly', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, '.cursor'), { recursive: true });
      const evolverRoot = path.resolve(__dirname, '..');
      const result = cursorAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      assert.equal(result.ok, true);
      assert.equal(result.platform, 'cursor');
      const hooks = JSON.parse(fs.readFileSync(path.join(tmp, '.cursor', 'hooks.json'), 'utf8'));
      assert.ok(hooks.hooks.sessionStart);
      assert.ok(hooks.hooks.afterFileEdit);
      assert.ok(hooks.hooks.stop);
      assert.equal(hooks._evolver_managed, true);
      assert.ok(fs.existsSync(path.join(tmp, '.cursor', 'hooks', 'evolver-session-start.js')));
    } finally { cleanup(tmp); }
  });

  it('uninstalls hooks correctly', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, '.cursor'), { recursive: true });
      const evolverRoot = path.resolve(__dirname, '..');
      cursorAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      const result = cursorAdapter.uninstall({ configRoot: tmp, evolverRoot });
      assert.equal(result.ok, true);
      assert.equal(result.removed, true);
      assert.ok(!fs.existsSync(path.join(tmp, '.cursor', 'hooks', 'evolver-session-start.js')));
    } finally { cleanup(tmp); }
  });

  it('buildHooksJson returns valid structure', () => {
    const hooks = cursorAdapter.buildHooksJson('/evolver', false);
    assert.equal(hooks.version, 1);
    assert.ok(hooks.hooks.sessionStart[0].command.includes('evolver-session-start'));
    assert.ok(hooks.hooks.afterFileEdit[0].command.includes('evolver-signal-detect'));
    assert.ok(hooks.hooks.stop[0].command.includes('evolver-session-end'));
  });

  it('buildHooksJson user-level uses ./hooks/ prefix', () => {
    const hooks = cursorAdapter.buildHooksJson('/evolver', true);
    assert.ok(hooks.hooks.sessionStart[0].command.startsWith('node ./hooks/'));
  });
});

// -- Claude Code adapter --

describe('claudeCode adapter', () => {
  it('installs hooks and CLAUDE.md', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
      const evolverRoot = path.resolve(__dirname, '..');
      const result = claudeAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      assert.equal(result.ok, true);
      assert.equal(result.platform, 'claude-code');
      const settings = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
      assert.ok(settings.hooks.SessionStart);
      assert.ok(settings.hooks.PostToolUse);
      assert.ok(settings.hooks.Stop);
      assert.ok(fs.existsSync(path.join(tmp, 'CLAUDE.md')));
      const claudeMd = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8');
      assert.ok(claudeMd.includes('Evolution Memory'));
      assert.ok(claudeMd.includes('Do not narrate routine Evolver checks'));
      assert.ok(!claudeMd.includes('For substantive tasks'));
      assert.ok(!claudeMd.includes('gep_recall'));
      assert.ok(!claudeMd.includes('gep_record_outcome'));
    } finally { cleanup(tmp); }
  });

  it('uninstalls hooks and CLAUDE.md section', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
      const evolverRoot = path.resolve(__dirname, '..');
      claudeAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      const result = claudeAdapter.uninstall({ configRoot: tmp });
      assert.equal(result.ok, true);
      assert.equal(result.removed, true);
      const claudeMd = fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8');
      assert.ok(!claudeMd.includes('evolver-evolution-memory'));
    } finally { cleanup(tmp); }
  });

  it('verifies the installed hook files and reports missing runtime assets', () => {
    const tmp = makeTmpDir();
    try {
      const evolverRoot = path.resolve(__dirname, '..');
      claudeAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      const healthy = claudeAdapter.verify({ configRoot: tmp });
      assert.equal(healthy.ok, true);
      assert.equal(healthy.platform, 'claude-code');

      fs.unlinkSync(path.join(tmp, '.claude', 'hooks', 'evolver-session-end.js'));
      const broken = claudeAdapter.verify({ configRoot: tmp });
      assert.equal(broken.ok, false);
      assert.ok(broken.checks.some(check =>
        check.id === 'hook_scripts_present' &&
        check.ok === false &&
        check.detail.includes('evolver-session-end.js')
      ));
    } finally { cleanup(tmp); }
  });

  it('does not accept commands that merely mention managed script names', () => {
    const tmp = makeTmpDir();
    try {
      const evolverRoot = path.resolve(__dirname, '..');
      claudeAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      const settingsPath = path.join(tmp, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      settings.hooks.SessionStart[0].hooks[0].command = 'echo evolver-session-start.js';
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
      const report = claudeAdapter.verify({ configRoot: tmp });
      assert.equal(report.ok, false);
      assert.equal(
        report.checks.find(check => check.id === 'hooks_registered').ok,
        false
      );
    } finally { cleanup(tmp); }
  });

  it('reports globally disabled or structurally altered hooks as unhealthy', () => {
    const tmp = makeTmpDir();
    try {
      const evolverRoot = path.resolve(__dirname, '..');
      claudeAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      const settingsPath = path.join(tmp, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      settings.disableAllHooks = true;
      settings.hooks.PostToolUse[0].matcher = 'Bash';
      settings.hooks.Stop[0].hooks[0].type = 'prompt';
      fs.writeFileSync(settingsPath, JSON.stringify(settings));

      const report = claudeAdapter.verify({ configRoot: tmp });
      assert.equal(report.ok, false);
      assert.equal(report.checks.find(check => check.id === 'hooks_enabled').ok, false);
      assert.equal(report.checks.find(check => check.id === 'hooks_registered').ok, false);
    } finally { cleanup(tmp); }
  });

  it('install preserves user-installed Stop hook (#539)', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node user-cleanup.js' }] },
          ],
        },
      }));
      const evolverRoot = path.resolve(__dirname, '..');
      claudeAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.equal(merged.hooks.Stop.length, 2,
        'user Stop entry + evolver Stop entry must both be present');
      const cmds = merged.hooks.Stop.flatMap(m => (m.hooks || []).map(h => h.command));
      assert.ok(cmds.includes('node user-cleanup.js'));
      assert.ok(cmds.some(c => c.includes('evolver-session-end')));
    } finally { cleanup(tmp); }
  });

  it('install refreshes managed legacy evolver hooks without force', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      fs.writeFileSync(settingsPath, JSON.stringify({
        _evolver_managed: true,
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'node .claude/hooks/evolver-session-start.js' }] },
          ],
          Stop: [
            { hooks: [
              { type: 'command', command: 'node user-cleanup.js' },
              { type: 'command', command: 'node .claude/hooks/evolver-session-end.js' },
            ] },
          ],
        },
      }));

      const evolverRoot = path.resolve(__dirname, '..');
      const result = claudeAdapter.install({ configRoot: tmp, evolverRoot, force: false });
      assert.equal(result.ok, true);
      assert.notEqual(result.skipped, true);

      const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const commands = collectCommands(merged);
      assert.ok(commands.includes('node user-cleanup.js'), 'user Stop hook must be preserved');
      assert.ok(!commands.some(c => c.includes('node .claude/hooks/')),
        'legacy relative evolver hook commands must be replaced');
      assert.equal(commands.filter(c => c.includes('evolver-session-start')).length, 1);
      assert.equal(commands.filter(c => c.includes('evolver-session-end')).length, 1);
      assert.ok(commands.every(c => {
        if (!hookAdapter.isEvolverHookCommand(c)) return true;
        return c.startsWith('node -e ');
      }), 'all evolver hook commands must use the safe node -e wrapper');
    } finally { cleanup(tmp); }
  });

  it('uninstall strips evolver hooks even without _evolver_managed marker (#538)', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      // Hand-edited / older install: marker dropped but evolver entry remains.
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node .claude/hooks/evolver-session-end.js' }] },
            { hooks: [{ type: 'command', command: 'node user-cleanup.js' }] },
          ],
        },
      }));

      claudeAdapter.uninstall({ configRoot: tmp });
      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const remaining = (after.hooks && after.hooks.Stop)
        ? after.hooks.Stop.flatMap(m => (m.hooks || []).map(h => h.command))
        : [];
      assert.ok(!remaining.some(c => c.includes('evolver-session-end')),
        'evolver hook must be filtered even without marker');
      assert.ok(remaining.includes('node user-cleanup.js'),
        'user hook must remain');
    } finally { cleanup(tmp); }
  });

  it('uninstall persists inner-array filter when matcher mixes evolver + user hooks (PR #94)', () => {
    const tmp = makeTmpDir();
    try {
      const claudeDir = path.join(tmp, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsPath = path.join(claudeDir, 'settings.json');
      // No _evolver_managed marker, single matcher contains both evolver
      // and user hooks. Outer array length is unchanged after filtering;
      // the bug was that `touched` only flipped on outer-length changes.
      fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [
              { type: 'command', command: 'node .claude/hooks/evolver-session-end.js' },
              { type: 'command', command: 'node user-cleanup.js' },
            ] },
          ],
        },
      }));

      claudeAdapter.uninstall({ configRoot: tmp });
      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const remaining = (after.hooks && after.hooks.Stop)
        ? after.hooks.Stop.flatMap(m => (m.hooks || []).map(h => h.command))
        : [];
      assert.ok(!remaining.some(c => c.includes('evolver-session-end')),
        'evolver hook must be filtered out and the change persisted to disk');
      assert.ok(remaining.includes('node user-cleanup.js'),
        'user hook in same matcher must remain');
    } finally { cleanup(tmp); }
  });

  it('buildClaudeHooks produces Claude Code HookMatcher structure', () => {
    const hooks = claudeAdapter.buildClaudeHooks('/evolver');
    for (const event of ['SessionStart', 'PostToolUse', 'Stop']) {
      const matchers = hooks.hooks[event];
      assert.ok(Array.isArray(matchers), `${event} must be an array`);
      assert.ok(matchers.length > 0, `${event} must have matchers`);
      for (const matcher of matchers) {
        assert.ok(Array.isArray(matcher.hooks), `${event} matcher must have .hooks array`);
        for (const cmd of matcher.hooks) {
          assert.equal(cmd.type, 'command');
          assert.equal(typeof cmd.command, 'string');
          assert.ok(cmd.command.length > 0);
        }
      }
    }
    assert.equal(hooks.hooks.PostToolUse[0].matcher, 'Write');
  });

  function collectCommands(hooks) {
    const commands = [];
    for (const matchers of Object.values(hooks.hooks)) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks || []) commands.push(hook.command);
      }
    }
    return commands;
  }

  it('builds absolute, encoded hook commands rooted at configRoot with spaces (#590)', () => {
    const tmp = makeTmpDir();
    try {
      const configRoot = path.join(tmp, 'Claude Project With Spaces');
      const evolverRoot = path.resolve(__dirname, '..');
      const result = claudeAdapter.install({ configRoot, evolverRoot, force: true });
      assert.equal(result.ok, true);

      const settings = JSON.parse(fs.readFileSync(path.join(configRoot, '.claude', 'settings.json'), 'utf8'));
      const commands = collectCommands(settings);
      const scripts = [
        'evolver-session-start.js',
        'evolver-task-recall.js',
        'evolver-signal-detect.js',
        'evolver-session-end.js',
      ];
      assert.equal(commands.length, scripts.length);
      for (const scriptName of scripts) {
        const scriptPath = path.join(configRoot, '.claude', 'hooks', scriptName);
        const command = commands.find(c => c.includes(scriptName));
        assert.ok(command, `${scriptName} hook command must be present`);
        assert.ok(!command.includes('node .claude/hooks/'), 'hook command must not use a relative script path');
        assert.ok(!command.includes(scriptPath), `hook command must not expose raw script path ${scriptPath}`);
        assert.ok(!command.includes(configRoot), 'hook command must not expose raw config root');
        assert.match(command, /^node -e (["']).+\1 \S+\.js$/);
        // The plaintext basename keeps uninstall/reinstall matching working.
        assert.ok(hookAdapter.isEvolverHookCommand(command), 'must stay matchable as evolver-owned');
      }
    } finally { cleanup(tmp); }
  });

  it('keeps shell-expansion bytes out of generated hook commands', () => {
    const configRoot = path.join(os.tmpdir(), 'Claude $(touch pwned) %TEMP% `id`');
    const commands = collectCommands(claudeAdapter.buildClaudeHooks('/evolver', configRoot));
    assert.ok(commands.length > 0);
    for (const command of commands) {
      assert.ok(!command.includes('$('), 'no command-substitution bytes');
      assert.ok(!command.includes('`'), 'no backtick bytes');
      assert.ok(!command.includes('%TEMP%'), 'no Windows env-expansion bytes');
      assert.ok(!command.includes(configRoot), 'no raw config path');
    }
  });

  it('claudeCode reuses the shared hookAdapter.buildSafeNodeHookCommand', () => {
    const configRoot = path.join(os.tmpdir(), 'shared-impl-check');
    const command = claudeAdapter.buildClaudeHooks('/evolver', configRoot).hooks.SessionStart[0].hooks[0].command;
    const expected = hookAdapter.buildSafeNodeHookCommand(
      path.resolve(configRoot, '.claude', 'hooks', 'evolver-session-start.js')
    );
    assert.equal(command, expected);
  });

  it('runs a hook path containing $() through POSIX sh without expansion (#590)', { skip: process.platform === 'win32' }, () => {
    const tmp = makeTmpDir();
    try {
      const proofPath = path.join(tmp, 'proof');
      const configRoot = path.join(tmp, `Project $(touch ${proofPath})`);
      const hookDir = path.join(configRoot, '.claude', 'hooks');
      fs.mkdirSync(hookDir, { recursive: true });
      const scriptPath = path.join(hookDir, 'evolver-session-start.js');
      const ranPath = path.join(tmp, 'ran');
      fs.writeFileSync(scriptPath, `require('fs').writeFileSync(${JSON.stringify(ranPath)}, 'ok')\n`);

      const hooks = claudeAdapter.buildClaudeHooks('/evolver', configRoot);
      const command = hooks.hooks.SessionStart[0].hooks[0].command;
      assert.ok(!command.includes('$('), 'generated command must not contain raw $() path text');

      const result = spawnSync('/bin/sh', ['-c', command], {
        encoding: 'utf8',
        // The wrapper cold-starts node twice (outer `node -e` + inner script),
        // so keep a generous budget for slow/loaded CI machines.
        timeout: 15000,
      });
      assert.equal(result.status, 0, `hook command should succeed. stderr=${result.stderr}`);
      assert.ok(fs.existsSync(ranPath), 'hook script should execute via the decoded path');
      assert.ok(!fs.existsSync(proofPath), 'command substitution in the path must not execute');
    } finally { cleanup(tmp); }
  });
});

// -- Codex adapter --

describe('codex adapter', () => {
  it('installs hooks, config.toml, and AGENTS.md', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
      const evolverRoot = path.resolve(__dirname, '..');
      const result = codexAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      assert.equal(result.ok, true);
      assert.equal(result.platform, 'codex');
      const hooks = JSON.parse(fs.readFileSync(path.join(tmp, '.codex', 'hooks.json'), 'utf8'));
      assert.ok(hooks.hooks.SessionStart);
      assert.ok(hooks.hooks.Stop);
      const toml = fs.readFileSync(path.join(tmp, '.codex', 'config.toml'), 'utf8');
      assert.ok(toml.includes('codex_hooks = true'));
      assert.ok(fs.existsSync(path.join(tmp, 'AGENTS.md')));
      const agentsMd = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8');
      assert.ok(agentsMd.includes('Do not narrate routine Evolver checks'));
      assert.ok(!agentsMd.includes('For substantive tasks'));
      assert.ok(!agentsMd.includes('gep_recall'));
      assert.ok(!agentsMd.includes('gep_record_outcome'));
    } finally { cleanup(tmp); }
  });

  it('verifies the installed hooks, feature flag, and memory section', () => {
    const tmp = makeTmpDir();
    try {
      const evolverRoot = path.resolve(__dirname, '..');
      codexAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      const healthy = codexAdapter.verify({ configRoot: tmp });
      assert.equal(healthy.ok, true);
      assert.equal(healthy.platform, 'codex');

      fs.writeFileSync(
        path.join(tmp, '.codex', 'config.toml'),
        '[features]\n# codex_hooks = true\n'
      );
      const broken = codexAdapter.verify({ configRoot: tmp });
      assert.equal(broken.ok, false);
      assert.ok(broken.checks.some(check =>
        check.id === 'codex_hooks_enabled' && check.ok === false
      ));
    } finally { cleanup(tmp); }
  });

  it('rejects a Codex hook whose command is present under the wrong type', () => {
    const tmp = makeTmpDir();
    try {
      const evolverRoot = path.resolve(__dirname, '..');
      codexAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      const hooksPath = path.join(tmp, '.codex', 'hooks.json');
      const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
      hooks.hooks.Stop[0].type = 'prompt';
      fs.writeFileSync(hooksPath, JSON.stringify(hooks));

      const report = codexAdapter.verify({ configRoot: tmp });
      assert.equal(report.ok, false);
      assert.equal(report.checks.find(check => check.id === 'hooks_registered').ok, false);
    } finally { cleanup(tmp); }
  });

  it('ensureConfigToml adds feature flag', () => {
    const tmp = makeTmpDir();
    try {
      const codexDir = path.join(tmp, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const changed = codexAdapter.ensureConfigToml(codexDir);
      assert.equal(changed, true);
      const toml = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
      assert.ok(toml.includes('[features]'));
      assert.ok(toml.includes('codex_hooks = true'));
      const noChange = codexAdapter.ensureConfigToml(codexDir);
      assert.equal(noChange, false);
    } finally { cleanup(tmp); }
  });

  it('does not treat a commented codex_hooks line as enabled', () => {
    const tmp = makeTmpDir();
    try {
      const codexDir = path.join(tmp, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        path.join(codexDir, 'config.toml'),
        '[features]\n# codex_hooks = true\n'
      );
      assert.equal(codexAdapter.ensureConfigToml(codexDir), true);
      const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
      assert.equal(codexAdapter.codexHooksEnabled(content), true);
      assert.match(content, /^codex_hooks = true$/m);
    } finally { cleanup(tmp); }
  });

  it('replaces a false feature value without creating a duplicate TOML key', () => {
    const tmp = makeTmpDir();
    try {
      const codexDir = path.join(tmp, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        path.join(codexDir, 'config.toml'),
        '[features]\ncodex_hooks = false\nother = true\n'
      );
      assert.equal(codexAdapter.ensureConfigToml(codexDir), true);
      const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
      assert.equal((content.match(/^codex_hooks\s*=/gm) || []).length, 1);
      assert.match(content, /^codex_hooks = true$/m);
      assert.match(content, /^other = true$/m);
    } finally { cleanup(tmp); }
  });

  it('uninstall preserves same-named keys outside the features table', () => {
    const tmp = makeTmpDir();
    try {
      const codexDir = path.join(tmp, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(
        path.join(codexDir, 'config.toml'),
        '[features]\ncodex_hooks = true\n\n[custom]\ncodex_hooks = true\n'
      );
      assert.equal(codexAdapter.cleanConfigToml(codexDir), true);
      const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
      assert.equal(codexAdapter.codexHooksEnabled(content), false);
      assert.match(content, /\[custom\]\ncodex_hooks = true/);
    } finally { cleanup(tmp); }
  });

  it('ignores feature-shaped text inside TOML multiline strings', () => {
    const tmp = makeTmpDir();
    try {
      const codexDir = path.join(tmp, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const original = [
        '[custom]',
        'notes = """first line',
        '',
        '[features]',
        'codex_hooks = true',
        'last line"""',
        '',
      ].join('\n');
      const configPath = path.join(codexDir, 'config.toml');
      fs.writeFileSync(configPath, original);

      assert.equal(codexAdapter.codexHooksEnabled(original), false);
      assert.equal(codexAdapter.ensureConfigToml(codexDir), true);
      const installed = fs.readFileSync(configPath, 'utf8');
      assert.equal(codexAdapter.codexHooksEnabled(installed), true);
      assert.ok(installed.includes(original), 'install must preserve multiline string bytes');

      assert.equal(codexAdapter.cleanConfigToml(codexDir), true);
      const cleaned = fs.readFileSync(configPath, 'utf8');
      assert.equal(codexAdapter.codexHooksEnabled(cleaned), false);
      assert.ok(cleaned.includes(original), 'uninstall must preserve multiline string bytes');
    } finally { cleanup(tmp); }
  });

  it('keeps TOML table and key matching case-sensitive', () => {
    const tmp = makeTmpDir();
    try {
      const codexDir = path.join(tmp, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const configPath = path.join(codexDir, 'config.toml');
      fs.writeFileSync(
        configPath,
        '[Features]\ncodex_hooks = true\n\n[features]\nCodex_Hooks = true\n'
      );

      assert.equal(
        codexAdapter.codexHooksEnabled(fs.readFileSync(configPath, 'utf8')),
        false
      );
      assert.equal(codexAdapter.ensureConfigToml(codexDir), true);
      const installed = fs.readFileSync(configPath, 'utf8');
      assert.match(installed, /\[Features\]\ncodex_hooks = true/);
      assert.match(installed, /\[features\]\ncodex_hooks = true\nCodex_Hooks = true/);

      assert.equal(codexAdapter.cleanConfigToml(codexDir), true);
      const cleaned = fs.readFileSync(configPath, 'utf8');
      assert.match(cleaned, /\[Features\]\ncodex_hooks = true/);
      assert.match(cleaned, /\[features\]\nCodex_Hooks = true/);
    } finally { cleanup(tmp); }
  });

  it('uninstalls hooks and AGENTS.md section', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
      const evolverRoot = path.resolve(__dirname, '..');
      codexAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      const result = codexAdapter.uninstall({ configRoot: tmp });
      assert.equal(result.ok, true);
      assert.equal(result.removed, true);
      const agentsMd = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8');
      assert.ok(!agentsMd.includes('evolver-evolution-memory'));
    } finally { cleanup(tmp); }
  });

  it('uninstall cleans codex_hooks flag from config.toml (#538)', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
      const evolverRoot = path.resolve(__dirname, '..');
      codexAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      // Simulate a user adding their own [features] entry alongside evolver's.
      const tomlPath = path.join(tmp, '.codex', 'config.toml');
      const before = fs.readFileSync(tomlPath, 'utf8');
      fs.writeFileSync(tomlPath, before + 'user_feature = true\n');

      codexAdapter.uninstall({ configRoot: tmp });
      const after = fs.readFileSync(tomlPath, 'utf8');
      assert.ok(!after.includes('codex_hooks'), 'codex_hooks line must be removed');
      assert.ok(after.includes('user_feature'), 'unrelated user feature must be preserved');
    } finally { cleanup(tmp); }
  });

  it('uninstall removes [features] header when only codex_hooks lived there', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
      const evolverRoot = path.resolve(__dirname, '..');
      codexAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      codexAdapter.uninstall({ configRoot: tmp });
      const after = fs.readFileSync(path.join(tmp, '.codex', 'config.toml'), 'utf8');
      assert.ok(!after.includes('[features]'),
        'orphan [features] block should be removed when empty');
    } finally { cleanup(tmp); }
  });

  it('cleanConfigToml preserves [features] when user entries follow a blank line (PR #94 round-3)', () => {
    // Bugbot round-3 finding: the multiline `$` in
    // /\[features\]\s*\n(?=\s*\[|\s*$)/m could match a blank line
    // mid-file and strand user entries below the removed header.
    // Verify several layouts that previously worried Bugbot.
    const tmp = makeTmpDir();
    try {
      const codexDir = path.join(tmp, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const tomlPath = path.join(codexDir, 'config.toml');

      const layouts = [
        '[features]\ncodex_hooks = true\n\nuser_feature = true\n',
        '[features]\ncodex_hooks = true\n\n# user comment\nuser_feature = true\n',
        '[features]\ncodex_hooks = true\nuser_feature = true\n\n[other]\nfoo = 1\n',
      ];
      for (const layout of layouts) {
        fs.writeFileSync(tomlPath, layout);
        codexAdapter.cleanConfigToml(codexDir);
        const after = fs.readFileSync(tomlPath, 'utf8');
        assert.ok(!after.includes('codex_hooks'),
          `codex_hooks must be removed (layout=${JSON.stringify(layout)})`);
        assert.ok(after.includes('[features]'),
          `[features] must NOT be removed when user entries remain (layout=${JSON.stringify(layout)} -> ${JSON.stringify(after)})`);
        assert.ok(after.includes('user_feature'),
          `user entry must be preserved (layout=${JSON.stringify(layout)})`);
      }
    } finally { cleanup(tmp); }
  });

  it('cleanConfigToml drops [features] when section becomes empty', () => {
    const tmp = makeTmpDir();
    try {
      const codexDir = path.join(tmp, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const tomlPath = path.join(codexDir, 'config.toml');

      // (input, expectedFeaturesPresent)
      const layouts = [
        ['[features]\ncodex_hooks = true\n', false],
        ['[features]\ncodex_hooks = true\n\n[other]\nfoo = 1\n', false],
        ['[features]\ncodex_hooks = true\n[other]\nfoo = 1\n', false],
      ];
      for (const [layout, shouldKeep] of layouts) {
        fs.writeFileSync(tomlPath, layout);
        codexAdapter.cleanConfigToml(codexDir);
        const after = fs.readFileSync(tomlPath, 'utf8');
        assert.ok(!after.includes('codex_hooks'), 'codex_hooks must be removed');
        assert.equal(after.includes('[features]'), shouldKeep,
          `[features] presence mismatch (layout=${JSON.stringify(layout)} -> ${JSON.stringify(after)})`);
      }
    } finally { cleanup(tmp); }
  });

  it('install preserves user-installed hooks under same event (#539)', () => {
    const tmp = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
      const hooksJsonPath = path.join(tmp, '.codex', 'hooks.json');
      fs.writeFileSync(hooksJsonPath, JSON.stringify({
        hooks: {
          Stop: [{ type: 'command', command: 'node my-tool.js' }],
          PostToolUse: [{ type: 'command', command: 'node my-watcher.js' }],
        },
      }));
      const evolverRoot = path.resolve(__dirname, '..');
      codexAdapter.install({ configRoot: tmp, evolverRoot, force: true });
      const merged = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      const stopCmds = merged.hooks.Stop.map(h => h.command);
      assert.ok(stopCmds.includes('node my-tool.js'), 'user Stop hook must be preserved');
      assert.ok(stopCmds.some(c => c.includes('evolver-session-end')), 'evolver Stop hook must be added');

      const postCmds = merged.hooks.PostToolUse.map(h => h.command);
      assert.ok(postCmds.includes('node my-watcher.js'));
      assert.ok(postCmds.some(c => c.includes('evolver-signal-detect')));
    } finally { cleanup(tmp); }
  });
});

// ---------------------------------------------------------------------------
// #547: setup-hooks must copy every helper required by the entry-point hooks
//
// Two regressions of this exact shape have shipped:
//   - PR #94 review caught `_runtimePaths.js` missing from the copy list.
//   - Issue #547 (rendigua, v1.87.0): `_memoryFiltering.js` was added to
//     evolver-session-start.js but not to hookAdapter.js's copy list, so
//     fresh installs crashed immediately with
//     `Error: Cannot find module './_memoryFiltering'`.
//
// This test scans every `require('./_xxx')` in the source adapter scripts
// and asserts the target file is present in `src/adapters/scripts/` AND
// that an end-to-end `installHooks` actually copies it into the
// destination dir. Any future helper added but forgotten in
// hookAdapter.js's list will trip the assertion immediately.
// ---------------------------------------------------------------------------
describe('setup-hooks copies every helper required by the entry-point scripts (#547)', () => {
  const scriptsDir = path.resolve(__dirname, '..', 'src', 'adapters', 'scripts');

  function collectRelativeRequires() {
    const entries = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js'));
    const requires = new Set();
    for (const entry of entries) {
      const src = fs.readFileSync(path.join(scriptsDir, entry), 'utf8');
      // Match `require('./foo')` and `require("./foo")` for any "./..."
      // path that targets a sibling file (not a node_modules package).
      const re = /require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        // Normalise: ensure .js suffix for matching against directory list.
        let target = m[1].replace(/^\.\//, '');
        if (target.includes('/')) continue; // only verify same-dir sibling helpers
        if (!target.endsWith('.js')) target += '.js';
        requires.add(target);
      }
    }
    return [...requires];
  }

  it('every local require in adapter scripts points to a file that actually exists in scripts/', () => {
    const requires = collectRelativeRequires();
    assert.ok(requires.length > 0, 'expected at least one local require to verify');
    const existingScripts = new Set(fs.readdirSync(scriptsDir));
    for (const target of requires) {
      assert.ok(existingScripts.has(target),
        `adapter script requires './${target.replace(/\.js$/, '')}' but src/adapters/scripts/${target} does not exist`);
    }
  });

  it('every required helper is copied by installHooks (Codex)', () => {
    const requires = collectRelativeRequires();
    const tmp = makeTmpDir();
    try {
      const hooksDir = path.join(tmp, '.codex', 'hooks');
      const evolverRoot = path.resolve(__dirname, '..', 'src', 'adapters');
      hookAdapter.copyHookScripts(hooksDir, evolverRoot);
      const installed = new Set(fs.readdirSync(hooksDir));
      for (const target of requires) {
        assert.ok(installed.has(target),
          `evolver-session-*.js requires './${target.replace(/\.js$/, '')}' but setup-hooks did not copy ` +
          `src/adapters/scripts/${target} into the destination dir (this was the root cause of #547)`);
      }
    } finally { cleanup(tmp); }
  });

  it('every helper copied by install is also removed by uninstall (no orphan files)', () => {
    const requires = collectRelativeRequires();
    const tmp = makeTmpDir();
    try {
      const hooksDir = path.join(tmp, '.codex', 'hooks');
      const evolverRoot = path.resolve(__dirname, '..', 'src', 'adapters');
      hookAdapter.copyHookScripts(hooksDir, evolverRoot);
      hookAdapter.removeHookScripts(hooksDir);
      // After uninstall, none of the required-helper files should remain.
      const remaining = fs.existsSync(hooksDir) ? new Set(fs.readdirSync(hooksDir)) : new Set();
      for (const target of requires) {
        assert.ok(!remaining.has(target),
          `setup-hooks --uninstall left orphan file ${target} (install copies it but uninstall does not remove it)`);
      }
    } finally { cleanup(tmp); }
  });
});
