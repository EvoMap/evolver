const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// resolveProjectDir lives in the hook runtime helper. It decides which
// directory the session-end hook runs `git diff` in. The bug it fixes:
// Cursor invokes hooks with cwd set to the plugin install dir, so a hook
// that trusted process.cwd() found no changes and silently recorded nothing.
const { resolveProjectDir } = require('../src/adapters/scripts/_runtimePaths');

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-projdir-test-')));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe('resolveProjectDir', () => {
  // Snapshot and restore the env vars + cwd we mutate, so tests are isolated
  // and we never leak a chdir into sibling suites.
  let saved;
  const origCwd = process.cwd();
  beforeEach(() => {
    saved = {
      CURSOR_PROJECT_DIR: process.env.CURSOR_PROJECT_DIR,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    };
    delete process.env.CURSOR_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });
  afterEach(() => {
    for (const k of ['CURSOR_PROJECT_DIR', 'CLAUDE_PROJECT_DIR']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    try { process.chdir(origCwd); } catch {}
  });

  it('falls back to process.cwd() when no host env var is set (Codex / opencode / Kiro / CLI)', () => {
    const tmp = makeTmpDir();
    try {
      process.chdir(tmp);
      assert.equal(resolveProjectDir(), tmp);
    } finally { cleanup(tmp); }
  });

  it('honors CURSOR_PROJECT_DIR over cwd (Cursor: cwd is the plugin dir)', () => {
    const project = makeTmpDir();
    const pluginCwd = makeTmpDir();
    try {
      process.chdir(pluginCwd);            // simulate Cursor's plugin-dir cwd
      process.env.CURSOR_PROJECT_DIR = project;
      assert.equal(resolveProjectDir(), project);
    } finally { cleanup(project); cleanup(pluginCwd); }
  });

  it('honors CLAUDE_PROJECT_DIR (Claude Code, and Cursor compat alias)', () => {
    const project = makeTmpDir();
    const otherCwd = makeTmpDir();
    try {
      process.chdir(otherCwd);
      process.env.CLAUDE_PROJECT_DIR = project;
      assert.equal(resolveProjectDir(), project);
    } finally { cleanup(project); cleanup(otherCwd); }
  });

  it('prefers CURSOR_PROJECT_DIR when both are set', () => {
    const cursorDir = makeTmpDir();
    const claudeDir = makeTmpDir();
    try {
      process.env.CURSOR_PROJECT_DIR = cursorDir;
      process.env.CLAUDE_PROJECT_DIR = claudeDir;
      assert.equal(resolveProjectDir(), cursorDir);
    } finally { cleanup(cursorDir); cleanup(claudeDir); }
  });

  it('ignores a stale env value pointing at a non-existent dir and falls back to cwd', () => {
    const tmp = makeTmpDir();
    try {
      process.chdir(tmp);
      process.env.CURSOR_PROJECT_DIR = path.join(tmp, 'does-not-exist');
      assert.equal(resolveProjectDir(), tmp);
    } finally { cleanup(tmp); }
  });

  it('ignores an env value pointing at a file (not a directory)', () => {
    const tmp = makeTmpDir();
    try {
      process.chdir(tmp);
      const f = path.join(tmp, 'afile');
      fs.writeFileSync(f, 'x');
      process.env.CLAUDE_PROJECT_DIR = f;
      assert.equal(resolveProjectDir(), tmp);
    } finally { cleanup(tmp); }
  });

  it('ignores an empty / whitespace env value', () => {
    const tmp = makeTmpDir();
    try {
      process.chdir(tmp);
      process.env.CURSOR_PROJECT_DIR = '   ';
      assert.equal(resolveProjectDir(), tmp);
    } finally { cleanup(tmp); }
  });
});
