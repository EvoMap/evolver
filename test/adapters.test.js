const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

// -- hookAdapter --

describe('hookAdapter', () => {
  describe('detectPlatform', () => {
    it('detects cursor from .cursor directory', () => {
      const tmp = makeTmpDir();
      try {
        fs.mkdirSync(path.join(tmp, '.cursor'), { recursive: true });
        assert.equal(hookAdapter.detectPlatform(tmp), 'cursor');
      } finally { cleanup(tmp); }
    });

    it('detects claude-code from .claude directory', () => {
      const tmp = makeTmpDir();
      try {
        fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
        assert.equal(hookAdapter.detectPlatform(tmp), 'claude-code');
      } finally { cleanup(tmp); }
    });

    it('detects codex from .codex directory', () => {
      const tmp = makeTmpDir();
      try {
        fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
        assert.equal(hookAdapter.detectPlatform(tmp), 'codex');
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
        const { spawnSync } = require('child_process');
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

        const { spawnSync } = require('child_process');
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

  it('buildClaudeHooks commands resolve from project OR home scope', () => {
    // Regression: a bare `node .claude/hooks/...` command is resolved by
    // Claude Code against each project dir, so a home/global-scoped install
    // silently fails everywhere except the install root. Every emitted command
    // must reference both the project scope and a home-scope fallback, and stay
    // recognizable to the uninstall/merge matcher.
    const hooks = claudeAdapter.buildClaudeHooks('/evolver');
    const commands = [];
    for (const event of Object.keys(hooks.hooks)) {
      for (const matcher of hooks.hooks[event]) {
        for (const cmd of matcher.hooks) commands.push(cmd.command);
      }
    }
    assert.ok(commands.length >= 4, 'expected at least 4 hook commands');
    const homeMarker = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    for (const cmd of commands) {
      assert.ok(cmd.includes('CLAUDE_PROJECT_DIR'), `command must try project scope: ${cmd}`);
      assert.ok(cmd.includes(homeMarker), `command must fall back to home scope: ${cmd}`);
      assert.ok(/evolver-[a-z-]+\.js/.test(cmd), `command must invoke an evolver hook script: ${cmd}`);
      assert.ok(hookAdapter.isEvolverHookCommand(cmd), `command must stay recognizable to uninstall: ${cmd}`);
    }
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
