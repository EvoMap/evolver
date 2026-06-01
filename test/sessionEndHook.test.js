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

describe('evolver-session-end no-changes log breadcrumb', () => {
  // A non-git workspace has no diff -> no signal source -> nothing is recorded
  // (recording an empty outcome would pollute the memory graph). But the hook
  // must not be fully silent: it logs a one-line skip notice so a user can tell
  // "ran but had nothing to record" from "never fired".
  it('logs a "not a git workspace" skip notice and records no outcome', () => {
    const nongit = makeTmpDir(); // plain dir, no git init
    const home = makeTmpDir();
    try {
      const logDir = path.join(home, 'logs');
      const env = baseEnv({ HOME: home, EVOLVER_HOOK_LOG_DIR: logDir, TERM_PROGRAM: 'xterm' });
      delete env.CURSOR_TRACE_ID;
      delete env.CURSOR_SESSION_ID;

      const result = runHook(env, nongit);
      assert.deepEqual(result, {}, 'no outcome should be emitted in a non-git workspace');

      const logFile = path.join(logDir, 'evolution.log');
      assert.ok(fs.existsSync(logFile), 'a skip breadcrumb must be logged');
      const log = fs.readFileSync(logFile, 'utf8');
      assert.match(log, /nothing recorded \(not a git workspace\)/);
      // And it must NOT have written a memory-graph entry.
      const graph = path.join(home, '.evolver', 'memory', 'evolution', 'memory_graph.jsonl');
      assert.ok(!fs.existsSync(graph) || fs.readFileSync(graph, 'utf8').trim() === '',
        'no memory-graph entry should be written when there are no changes');
    } finally { cleanup(nongit); cleanup(home); }
  });

  it('logs a "no changes detected" notice in a clean git repo', () => {
    const repo = makeTmpDir();
    const home = makeTmpDir();
    try {
      // git repo with a committed file but NO uncommitted change this session.
      execSync('git init -q', { cwd: repo });
      execSync('git config user.email test@example.com', { cwd: repo });
      execSync('git config user.name test', { cwd: repo });
      fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
      execSync('git add a.txt', { cwd: repo });
      execSync('git commit -q -m initial', { cwd: repo });
      // No second commit and no edit -> diff HEAD~1 fails, working tree clean.

      const logDir = path.join(home, 'logs');
      const env = baseEnv({ HOME: home, EVOLVER_HOOK_LOG_DIR: logDir, TERM_PROGRAM: 'xterm' });
      delete env.CURSOR_TRACE_ID;
      delete env.CURSOR_SESSION_ID;

      const result = runHook(env, repo);
      assert.deepEqual(result, {});
      const log = fs.readFileSync(path.join(logDir, 'evolution.log'), 'utf8');
      assert.match(log, /nothing recorded \(no changes detected this session\)/);
    } finally { cleanup(repo); cleanup(home); }
  });
});

describe('evolver-session-end cwd tag consistency (reader/writer match)', () => {
  // Regression (Bugbot PR #555 round-2): the writer must stamp the entry's
  // `cwd` with resolveProjectDir() — the SAME resolver the session-start
  // reader uses for its cwd fallback — not raw process.cwd(). Under Cursor the
  // hook's process.cwd() is the plugin install dir, so a raw-cwd tag would
  // never equal the reader's project-dir-derived currentDir, silently hiding
  // every cwd-only entry. Force Hub off so the entry lands in local memory.
  it('tags entry.cwd with CURSOR_PROJECT_DIR, not the hook process cwd', () => {
    const repo = makeTmpDir();      // user's project, where the diff lives
    const elsewhere = makeTmpDir(); // simulate Cursor's plugin-dir cwd
    const home = makeTmpDir();
    try {
      initRepoWithDiff(repo);
      const graph = path.join(home, '.evolver', 'memory', 'evolution', 'memory_graph.jsonl');
      // recordToLocal appends to MEMORY_GRAPH_PATH but does not mkdir for an
      // explicit path — create the parent the way a real install would.
      fs.mkdirSync(path.dirname(graph), { recursive: true });
      const env = baseEnv({
        HOME: home,
        EVOLVER_HOOK_LOG_DIR: path.join(home, 'logs'),
        MEMORY_GRAPH_PATH: graph,
        TERM_PROGRAM: 'cursor',         // Cursor host
        CURSOR_PROJECT_DIR: repo,       // real project dir
        // Hub off so recordToLocal runs and we can inspect the entry.
        EVOMAP_API_KEY: '', A2A_NODE_SECRET: '', EVOMAP_NODE_ID: '', A2A_NODE_ID: '',
      });

      const result = runHook(env, elsewhere); // process.cwd() = plugin-ish dir
      assert.deepEqual(result, {}, 'Cursor host suppresses systemMessage');

      assert.ok(fs.existsSync(graph), 'a local memory entry should be written');
      const last = fs.readFileSync(graph, 'utf8').trim().split('\n').filter(Boolean).pop();
      const entry = JSON.parse(last);
      assert.equal(entry.cwd, repo,
        `entry.cwd must be the project dir (${repo}), got ${entry.cwd}`);
      assert.notEqual(entry.cwd, elsewhere,
        'entry.cwd must NOT be the hook process cwd (the plugin dir under Cursor)');
    } finally { cleanup(repo); cleanup(elsewhere); cleanup(home); }
  });
});
