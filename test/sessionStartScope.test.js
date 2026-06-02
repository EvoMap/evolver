const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'src', 'adapters', 'scripts', 'evolver-session-start.js');

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-sstart-scope-')));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Build a memory graph file with the given entries (one JSON object per line).
function writeGraph(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
}

// A "good" recent successful outcome that passes filterRelevantOutcomes
// (status success, score >= 0.5, timestamped now), tagged with a workspace.
function outcome(note, { workspace_id, cwd } = {}) {
  const e = {
    timestamp: new Date().toISOString(),
    gene_id: 'ad_hoc',
    signals: ['stable_success_plateau'],
    outcome: { status: 'success', score: 0.8, note },
  };
  if (workspace_id !== undefined) e.workspace_id = workspace_id;
  if (cwd !== undefined) e.cwd = cwd;
  return e;
}

function runStart(env) {
  const out = execFileSync('node', [scriptPath], {
    env: { PATH: process.env.PATH, ...env },
    input: '{}',
    encoding: 'utf8',
    timeout: 15000,
  });
  try { return JSON.parse(out); } catch { return null; }
}

function baseEnv(extra) {
  return {
    HOME: extra.HOME,
    EVOLVER_ROOT: repoRoot,
    // Force dedup off (default) so every run injects.
    EVOLVER_SESSION_START_DEDUP: '',
    ...extra,
  };
}

describe('evolver-session-start workspace scoping', () => {
  it('injects only the current workspace\'s outcomes, not other projects\'', () => {
    const home = makeTmpDir();
    try {
      const graph = path.join(home, '.evolver', 'memory', 'evolution', 'memory_graph.jsonl');
      // 6 entries from "other" workspace, then 1 from "mine". A tail-5 read
      // would miss "mine" entirely; scope-first must surface it.
      const entries = [];
      for (let i = 0; i < 6; i++) entries.push(outcome(`other-${i}`, { workspace_id: 'ws-other' }));
      entries.push(outcome('mine-1', { workspace_id: 'ws-mine' }));
      writeGraph(graph, entries);

      const env = baseEnv({
        HOME: home,
        MEMORY_GRAPH_PATH: graph,
        EVOLVER_WORKSPACE_ID: 'ws-mine',
      });
      const result = runStart(env);
      assert.ok(result && typeof result.additionalContext === 'string',
        `expected an injection, got ${JSON.stringify(result)}`);
      assert.match(result.additionalContext, /mine-1/, 'must include current workspace outcome');
      assert.doesNotMatch(result.additionalContext, /other-/,
        'must NOT leak other workspace outcomes');
    } finally { cleanup(home); }
  });

  it('surfaces this workspace\'s recent entries even behind many newer other-workspace entries', () => {
    const home = makeTmpDir();
    try {
      const graph = path.join(home, '.evolver', 'memory', 'evolution', 'memory_graph.jsonl');
      // This workspace's entries come FIRST (older), then a large run of other-
      // workspace entries (newer). A tail-N read would see only 'other'; the
      // bounded scan-from-end must walk past them to collect ours — without
      // parsing being capped at N total (it stops at N *matches*, not N lines).
      const entries = [];
      entries.push(outcome('mine-old', { workspace_id: 'ws-mine' }));
      for (let i = 0; i < 200; i++) entries.push(outcome(`other-${i}`, { workspace_id: 'ws-other' }));
      entries.push(outcome('mine-new', { workspace_id: 'ws-mine' }));
      writeGraph(graph, entries);

      const env = baseEnv({ HOME: home, MEMORY_GRAPH_PATH: graph, EVOLVER_WORKSPACE_ID: 'ws-mine' });
      const result = runStart(env);
      assert.ok(result && typeof result.additionalContext === 'string',
        `expected an injection, got ${JSON.stringify(result)}`);
      assert.match(result.additionalContext, /mine-new/, 'most recent own entry must show');
      assert.doesNotMatch(result.additionalContext, /other-/, 'no other-workspace leak');
    } finally { cleanup(home); }
  });

  it('emits nothing when only other workspaces have outcomes', () => {
    const home = makeTmpDir();
    try {
      const graph = path.join(home, '.evolver', 'memory', 'evolution', 'memory_graph.jsonl');
      writeGraph(graph, [outcome('other', { workspace_id: 'ws-other' })]);
      const env = baseEnv({ HOME: home, MEMORY_GRAPH_PATH: graph, EVOLVER_WORKSPACE_ID: 'ws-mine' });
      const result = runStart(env);
      assert.deepEqual(result, {}, `expected empty (no own outcomes), got ${JSON.stringify(result)}`);
    } finally { cleanup(home); }
  });

  // belongsToWorkspace is the scoping predicate. Unit-test its branches
  // directly (deterministic) — the end-to-end tests above cover the wired path.
  describe('belongsToWorkspace predicate', () => {
    const { belongsToWorkspace } = require('../src/adapters/scripts/evolver-session-start');

    it('unresolved current id -> tagged entries are NOT hidden (no regression)', () => {
      assert.equal(belongsToWorkspace({ workspace_id: 'ws-other' }, null, null), true);
    });
    it('resolved id -> exact match required', () => {
      assert.equal(belongsToWorkspace({ workspace_id: 'ws-mine' }, 'ws-mine', null), true);
      assert.equal(belongsToWorkspace({ workspace_id: 'ws-other' }, 'ws-mine', null), false);
    });
    it('untagged legacy entry -> always included', () => {
      assert.equal(belongsToWorkspace({}, 'ws-mine', '/some/dir'), true);
    });
    it('cwd fallback when no workspace_id', () => {
      assert.equal(belongsToWorkspace({ cwd: '/p' }, null, '/p'), true);
      assert.equal(belongsToWorkspace({ cwd: '/q' }, null, '/p'), false);
    });
  });

  it('passes through legacy entries that carry no workspace tag', () => {
    const home = makeTmpDir();
    try {
      const graph = path.join(home, '.evolver', 'memory', 'evolution', 'memory_graph.jsonl');
      // Untagged legacy entry (pre-hardening) + a tagged other-workspace one.
      writeGraph(graph, [outcome('legacy'), outcome('other', { workspace_id: 'ws-other' })]);
      const env = baseEnv({ HOME: home, MEMORY_GRAPH_PATH: graph, EVOLVER_WORKSPACE_ID: 'ws-mine' });
      const result = runStart(env);
      assert.ok(result && typeof result.additionalContext === 'string');
      assert.match(result.additionalContext, /legacy/, 'untagged legacy entries must not be hidden');
      assert.doesNotMatch(result.additionalContext, /other/, 'tagged other-workspace entry still excluded');
    } finally { cleanup(home); }
  });

  it('matches on cwd when an entry has cwd but no workspace_id', () => {
    const home = makeTmpDir();
    const projectDir = makeTmpDir();
    try {
      const graph = path.join(home, '.evolver', 'memory', 'evolution', 'memory_graph.jsonl');
      writeGraph(graph, [
        outcome('mine-cwd', { cwd: projectDir }),
        outcome('other-cwd', { cwd: path.join(projectDir, 'nope') }),
      ]);
      const env = baseEnv({
        HOME: home,
        MEMORY_GRAPH_PATH: graph,
        // id unresolved -> falls to cwd matching; point project dir at ours
        CURSOR_PROJECT_DIR: projectDir,
      });
      delete env.EVOLVER_WORKSPACE_ID;
      const result = runStart(env);
      // currentId is null here, so workspace_id-less entries are matched by cwd
      // only when currentId is null AND we have currentDir. Both entries lack
      // workspace_id; belongsToWorkspace falls to cwd compare against projectDir.
      assert.ok(result && typeof result.additionalContext === 'string');
      assert.match(result.additionalContext, /mine-cwd/);
      assert.doesNotMatch(result.additionalContext, /other-cwd/);
    } finally { cleanup(home); cleanup(projectDir); }
  });
});

describe('evolver-session-start non-git notice', () => {
  const { execFileSync: x } = require('child_process');
  const gitInit = (d) => x('git', ['init', '-q'], { cwd: d });

  it('surfaces a notice in a non-git folder (first time)', () => {
    const home = makeTmpDir(); const proj = makeTmpDir();
    try {
      const env = baseEnv({ HOME: home, CURSOR_PROJECT_DIR: proj,
        MEMORY_GRAPH_PATH: path.join(home, 'g.jsonl') });
      const r = runStart(env);
      assert.ok(r && typeof r.additionalContext === 'string', 'expected a notice');
      assert.match(r.additionalContext, /not a git repository/);
    } finally { cleanup(home); cleanup(proj); }
  });

  it('throttles the notice on the second run in the same folder', () => {
    const home = makeTmpDir(); const proj = makeTmpDir();
    try {
      const env = baseEnv({ HOME: home, CURSOR_PROJECT_DIR: proj,
        MEMORY_GRAPH_PATH: path.join(home, 'g.jsonl') });
      const first = runStart(env);
      assert.match(first.additionalContext, /not a git repository/);
      const second = runStart(env);
      assert.deepEqual(second, {}, 'second run within TTL must be silent');
    } finally { cleanup(home); cleanup(proj); }
  });

  it('does NOT show the notice in a git workspace', () => {
    const home = makeTmpDir(); const proj = makeTmpDir();
    try {
      gitInit(proj);
      const env = baseEnv({ HOME: home, CURSOR_PROJECT_DIR: proj,
        MEMORY_GRAPH_PATH: path.join(home, 'g.jsonl') });
      const r = runStart(env);
      // No memory + git repo -> empty; in any case never the non-git notice.
      if (r && r.additionalContext) {
        assert.doesNotMatch(r.additionalContext, /not a git repository/);
      }
    } finally { cleanup(home); cleanup(proj); }
  });

  it('shows BOTH the notice and memory when a non-git folder has cwd-tagged outcomes', () => {
    const home = makeTmpDir(); const proj = makeTmpDir();
    try {
      const graph = path.join(home, '.evolver', 'memory', 'evolution', 'memory_graph.jsonl');
      // cwd-tagged success outcome for this non-git folder (workspace_id null).
      writeGraph(graph, [outcome('nongit-mem', { cwd: proj })]);
      const env = baseEnv({ HOME: home, CURSOR_PROJECT_DIR: proj, MEMORY_GRAPH_PATH: graph });
      delete env.EVOLVER_WORKSPACE_ID;
      const r = runStart(env);
      assert.ok(r && typeof r.additionalContext === 'string');
      assert.match(r.additionalContext, /not a git repository/, 'notice present');
      assert.match(r.additionalContext, /nongit-mem/, 'memory still injected');
    } finally { cleanup(home); cleanup(proj); }
  });
});
