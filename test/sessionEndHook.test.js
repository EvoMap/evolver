const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'src', 'adapters', 'scripts', 'evolver-session-end.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-session-end-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Spin up a minimal git repo with a staged diff so the hook detects "changes"
// and proceeds past the `hasChanges` early-return.
function initRepoWithDiff(dir) {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email test@example.com', { cwd: dir });
  execSync('git config user.name test', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  execSync('git add a.txt', { cwd: dir });
  execSync('git commit -q -m initial', { cwd: dir });
  // Modify the file so `git diff --stat` is non-empty.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\n');
}

function baseEnv(extra) {
  return {
    PATH: process.env.PATH,
    HOME: extra.HOME,
    // Pin EVOLVER_ROOT so _runtimePaths.findEvolverRoot picks our repo
    // package.json deterministically even from a tmp cwd.
    EVOLVER_ROOT: repoRoot,
    // Force Hub off — we only care about the local-memory path here.
    EVOMAP_HUB_URL: '',
    A2A_HUB_URL: '',
    ...extra,
  };
}

function runHook(env, cwd) {
  const out = execFileSync('node', [scriptPath], {
    cwd,
    env,
    input: '{}',
    encoding: 'utf8',
    timeout: 15000,
  });
  try { return JSON.parse(out); } catch { return null; }
}

describe('evolver-session-end Cursor compatibility', () => {
  it('emits systemMessage on non-Cursor hosts', () => {
    const tmp = makeTmpDir();
    try {
      initRepoWithDiff(tmp);
      const logDir = path.join(tmp, 'evolver-logs');
      const env = baseEnv({
        HOME: tmp,
        EVOLVER_HOOK_LOG_DIR: logDir,
        // explicitly clear any Cursor markers inherited from parent shell
        TERM_PROGRAM: 'xterm',
        EVOLVER_HOOK_HOST: '',
      });
      delete env.CURSOR_TRACE_ID;
      delete env.CURSOR_SESSION_ID;

      const result = runHook(env, tmp);
      assert.ok(result && typeof result.systemMessage === 'string',
        `expected systemMessage on non-Cursor, got ${JSON.stringify(result)}`);
      assert.match(result.systemMessage, /\[Evolution\]/);
      assert.equal(result.followup_message, undefined,
        'must not emit followup_message — that field re-injects the receipt as a user prompt');
      assert.ok(fs.existsSync(path.join(logDir, 'evolution.log')),
        'evolution.log must be appended even on non-Cursor hosts');
    } finally { cleanup(tmp); }
  });

  it('suppresses systemMessage when TERM_PROGRAM=cursor', () => {
    const tmp = makeTmpDir();
    try {
      initRepoWithDiff(tmp);
      const logDir = path.join(tmp, 'evolver-logs');
      const env = baseEnv({
        HOME: tmp,
        EVOLVER_HOOK_LOG_DIR: logDir,
        TERM_PROGRAM: 'cursor',
      });

      const result = runHook(env, tmp);
      assert.deepEqual(result, {},
        `expected empty object on Cursor, got ${JSON.stringify(result)}`);
      assert.ok(fs.existsSync(path.join(logDir, 'evolution.log')),
        'evolution.log must still be appended so the user can find the receipt');
    } finally { cleanup(tmp); }
  });

  it('suppresses systemMessage when CURSOR_TRACE_ID is set', () => {
    const tmp = makeTmpDir();
    try {
      initRepoWithDiff(tmp);
      const env = baseEnv({
        HOME: tmp,
        EVOLVER_HOOK_LOG_DIR: path.join(tmp, 'logs'),
        TERM_PROGRAM: 'xterm',
        CURSOR_TRACE_ID: 'abc-123',
      });
      const result = runHook(env, tmp);
      assert.deepEqual(result, {});
    } finally { cleanup(tmp); }
  });

  it('respects EVOLVER_HOOK_VERBOSE=1 escape hatch on Cursor', () => {
    const tmp = makeTmpDir();
    try {
      initRepoWithDiff(tmp);
      const env = baseEnv({
        HOME: tmp,
        EVOLVER_HOOK_LOG_DIR: path.join(tmp, 'logs'),
        TERM_PROGRAM: 'cursor',
        EVOLVER_HOOK_VERBOSE: '1',
      });
      const result = runHook(env, tmp);
      assert.ok(result && typeof result.systemMessage === 'string',
        `EVOLVER_HOOK_VERBOSE=1 must force systemMessage on, got ${JSON.stringify(result)}`);
    } finally { cleanup(tmp); }
  });

  it('respects manual EVOLVER_HOOK_HOST=cursor override', () => {
    const tmp = makeTmpDir();
    try {
      initRepoWithDiff(tmp);
      const env = baseEnv({
        HOME: tmp,
        EVOLVER_HOOK_LOG_DIR: path.join(tmp, 'logs'),
        TERM_PROGRAM: 'xterm',
        EVOLVER_HOOK_HOST: 'cursor',
      });
      const result = runHook(env, tmp);
      assert.deepEqual(result, {});
    } finally { cleanup(tmp); }
  });
});

describe('evolver-session-end project-dir resolution', () => {
  // Regression: Cursor runs hooks with cwd set to the plugin install dir, not
  // the user's repo. The hook must read CURSOR_PROJECT_DIR / CLAUDE_PROJECT_DIR
  // to find the repo and collect a real diff — otherwise it records nothing.
  it('records the diff from CURSOR_PROJECT_DIR even when cwd is elsewhere', () => {
    const repo = makeTmpDir();      // the user's actual project (has the diff)
    const elsewhere = makeTmpDir(); // simulate Cursor's plugin-dir cwd (no repo)
    const home = makeTmpDir();
    try {
      initRepoWithDiff(repo);
      const logDir = path.join(home, 'logs');
      const env = baseEnv({
        HOME: home,
        EVOLVER_HOOK_LOG_DIR: logDir,
        TERM_PROGRAM: 'xterm',          // non-Cursor → emits systemMessage so we can assert
        EVOLVER_HOOK_HOST: '',
        CURSOR_PROJECT_DIR: repo,       // host points us at the real repo
      });
      delete env.CURSOR_TRACE_ID;
      delete env.CURSOR_SESSION_ID;

      const result = runHook(env, elsewhere); // cwd = wrong dir, like Cursor
      assert.ok(result && typeof result.systemMessage === 'string',
        `expected a recorded outcome via CURSOR_PROJECT_DIR, got ${JSON.stringify(result)}`);
      assert.match(result.systemMessage, /file/, 'should report changed files from the repo');
    } finally { cleanup(repo); cleanup(elsewhere); cleanup(home); }
  });

  it('CLAUDE_PROJECT_DIR alias also resolves the repo', () => {
    const repo = makeTmpDir();
    const elsewhere = makeTmpDir();
    const home = makeTmpDir();
    try {
      initRepoWithDiff(repo);
      const env = baseEnv({
        HOME: home,
        EVOLVER_HOOK_LOG_DIR: path.join(home, 'logs'),
        TERM_PROGRAM: 'xterm',
        EVOLVER_HOOK_HOST: '',
        CLAUDE_PROJECT_DIR: repo,
      });
      delete env.CURSOR_TRACE_ID;
      delete env.CURSOR_SESSION_ID;

      const result = runHook(env, elsewhere);
      assert.ok(result && typeof result.systemMessage === 'string',
        `expected a recorded outcome via CLAUDE_PROJECT_DIR, got ${JSON.stringify(result)}`);
    } finally { cleanup(repo); cleanup(elsewhere); cleanup(home); }
  });
});
