const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// resolveWorkspaceId resolves the forge-resistant workspace_id tag. When the
// @evomap/evolver package is unreachable (plugin-only installs), it must still
// produce a stable id via the FS-only fallback — writing the SAME secret file
// (<workspaceRoot>/.evolver/workspace-id) that src/gep/paths.js#getWorkspaceId
// uses, so an installed package picks up the identical id. Regression for the
// real-Cursor finding where plugin installs got workspace_id=null and scoping
// silently degraded to cwd matching.
const { resolveWorkspaceId } = require('../src/adapters/scripts/_runtimePaths');
const NO_PKG = '/nonexistent-evolver-root-xyz'; // forces the FS-only path

// git-init each tmp dir so it is its OWN workspace root. Without this, the
// repo-root walk in _fsWorkspaceRoot climbs past the tmp dir to any ancestor
// .git — and Aurora's /tmp carries a stray /tmp/.git that would otherwise
// capture the secret (see memory: paths.test.js /tmp/.git flake). A real user
// project is a git repo anyway, so this matches reality.
function makeTmpDir() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-wsid-test-')));
  execSync('git init -q', { cwd: d });
  return d;
}
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

describe('resolveWorkspaceId FS-only fallback', () => {
  let saved;
  beforeEach(() => {
    saved = { id: process.env.EVOLVER_WORKSPACE_ID, ws: process.env.OPENCLAW_WORKSPACE };
    delete process.env.EVOLVER_WORKSPACE_ID;
    delete process.env.OPENCLAW_WORKSPACE;
  });
  afterEach(() => {
    for (const [k, v] of [['EVOLVER_WORKSPACE_ID', saved.id], ['OPENCLAW_WORKSPACE', saved.ws]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it('EVOLVER_WORKSPACE_ID override wins, no file written', () => {
    const proj = makeTmpDir();
    try {
      process.env.EVOLVER_WORKSPACE_ID = 'override-id-123';
      assert.equal(resolveWorkspaceId(NO_PKG, proj), 'override-id-123');
      assert.ok(!fs.existsSync(path.join(proj, '.evolver', 'workspace-id')),
        'override must not trigger a file write');
    } finally { cleanup(proj); }
  });

  it('generates a stable hex id and persists it at <root>/.evolver/workspace-id', () => {
    const proj = makeTmpDir();
    try {
      const id1 = resolveWorkspaceId(NO_PKG, proj);
      assert.match(id1, /^[a-f0-9]{32,}$/i, `id must be hex, got ${id1}`);
      const file = path.join(proj, '.evolver', 'workspace-id');
      assert.ok(fs.existsSync(file), 'secret file must be created');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'secret file must be 0600');
      // Second call re-reads the same id (lazy create is stable).
      assert.equal(resolveWorkspaceId(NO_PKG, proj), id1, 'id must be stable across calls');
    } finally { cleanup(proj); }
  });

  it('two different project dirs get different ids (isolation)', () => {
    const a = makeTmpDir(); const b = makeTmpDir();
    try {
      assert.notEqual(resolveWorkspaceId(NO_PKG, a), resolveWorkspaceId(NO_PKG, b));
    } finally { cleanup(a); cleanup(b); }
  });

  it('resolves the git repo ROOT, not a subdir (matches paths.js getWorkspaceRoot)', () => {
    const repo = makeTmpDir();
    try {
      execSync('git init -q', { cwd: repo });
      const sub = path.join(repo, 'src', 'deep');
      fs.mkdirSync(sub, { recursive: true });
      // Called from a subdir, the secret must land at the repo root.
      const id = resolveWorkspaceId(NO_PKG, sub);
      assert.match(id, /^[a-f0-9]{32,}$/i);
      assert.ok(fs.existsSync(path.join(repo, '.evolver', 'workspace-id')),
        'secret must be at the git repo root, not the subdir');
      assert.ok(!fs.existsSync(path.join(sub, '.evolver', 'workspace-id')),
        'secret must NOT be created in the subdir');
    } finally { cleanup(repo); }
  });

  it('OPENCLAW_WORKSPACE overrides the workspace root', () => {
    const ws = makeTmpDir(); const proj = makeTmpDir();
    try {
      process.env.OPENCLAW_WORKSPACE = ws;
      resolveWorkspaceId(NO_PKG, proj);
      assert.ok(fs.existsSync(path.join(ws, '.evolver', 'workspace-id')),
        'secret must land at OPENCLAW_WORKSPACE root');
    } finally { cleanup(ws); cleanup(proj); }
  });

  it('lands the secret under <repoRoot>/workspace when that subdir exists (paths.js parity)', () => {
    // paths.js getWorkspaceRoot() returns <repoRoot>/workspace if present, so
    // the fallback must too — otherwise an installed package reads a different
    // file and the "read back identically" guarantee breaks (Bugbot PR #557).
    const repo = makeTmpDir();
    try {
      fs.mkdirSync(path.join(repo, 'workspace'), { recursive: true });
      const id = resolveWorkspaceId(NO_PKG, repo);
      assert.match(id, /^[a-f0-9]{32,}$/i);
      assert.ok(fs.existsSync(path.join(repo, 'workspace', '.evolver', 'workspace-id')),
        'secret must live under <repoRoot>/workspace/.evolver');
      assert.ok(!fs.existsSync(path.join(repo, '.evolver', 'workspace-id')),
        'secret must NOT be written at <repoRoot>/.evolver when workspace/ exists');
    } finally { cleanup(repo); }
  });

  it('refuses a pre-existing symlinked id FILE rather than following it', () => {
    const proj = makeTmpDir(); const evil = makeTmpDir();
    try {
      const evoDir = path.join(proj, '.evolver');
      fs.mkdirSync(evoDir, { recursive: true });
      const target = path.join(evil, 'attacker-id');
      fs.writeFileSync(target, 'deadbeef'.repeat(4) + '\n');
      fs.symlinkSync(target, path.join(evoDir, 'workspace-id'));
      assert.equal(resolveWorkspaceId(NO_PKG, proj), null,
        'a symlinked workspace-id file must be refused, not followed');
    } finally { cleanup(proj); cleanup(evil); }
  });

  it('refuses a symlinked .evolver dir (returns null, no write through link)', () => {
    const proj = makeTmpDir(); const evil = makeTmpDir();
    try {
      fs.symlinkSync(evil, path.join(proj, '.evolver'));
      assert.equal(resolveWorkspaceId(NO_PKG, proj), null,
        'must refuse to resolve through a symlinked .evolver dir');
      assert.ok(!fs.existsSync(path.join(evil, 'workspace-id')),
        'must not write the secret into the symlink target');
    } finally { cleanup(proj); cleanup(evil); }
  });

  // root ignores file permissions, so the EACCES path can't be provoked there.
  const denyIt = (typeof process.getuid === 'function' && process.getuid() === 0) ? it.skip : it;
  denyIt('returns null (does not throw) on a filesystem error like EACCES', () => {
    const repo = makeTmpDir();
    const evo = path.join(repo, '.evolver');
    try {
      // An unreadable/untraversable .evolver makes lstat on the id file throw
      // EACCES (not ENOENT). The contract is "return null on any error" so the
      // hook degrades instead of crashing (Bugbot PR #557 round-2 Medium).
      fs.mkdirSync(evo, { recursive: true });
      fs.writeFileSync(path.join(evo, 'workspace-id'), 'x');
      fs.chmodSync(evo, 0o000);
      let result, threw = false;
      try { result = resolveWorkspaceId(NO_PKG, repo); } catch { threw = true; }
      assert.equal(threw, false, 'must not throw on EACCES');
      assert.equal(result, null, 'must return null on EACCES');
    } finally {
      try { fs.chmodSync(evo, 0o755); } catch {}
      cleanup(repo);
    }
  });
});
