// _runtimePaths.js
// Shared path resolution for evolver hook scripts.
//
// Two responsibilities:
//   1. Locate the evolver package root, supporting:
//      - $EVOLVER_ROOT explicit override
//      - The "scripts colocated with src" layout used during dev (../../..)
//      - The npm-global install layout, where the hook script lives under
//        `<prefix>/lib/node_modules/<host>/.../hooks/` and `..` walks lead
//        somewhere outside the evolver package. We resolve via
//        `require.resolve('@evomap/evolver/package.json')` instead.
//      - The `~/skills/evolver` fallback (some users symlink there).
//
//   2. Locate (or pick a writable default for) the evolution memory graph,
//      so that hook scripts in environments without an evolver-managed
//      project directory still record outcomes somewhere instead of
//      reporting "nowhere (no Hub or local path)" (#536).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

function isEvolverPackageJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const pkg = JSON.parse(raw);
    return pkg && (pkg.name === '@evomap/evolver' || pkg.name === 'evolver');
  } catch {
    return false;
  }
}

function findEvolverRoot() {
  if (process.env.EVOLVER_ROOT) {
    const explicit = process.env.EVOLVER_ROOT;
    if (fs.existsSync(path.join(explicit, 'package.json')) &&
        isEvolverPackageJson(path.join(explicit, 'package.json'))) {
      return explicit;
    }
  }

  // Dev/repo layout: this file lives at src/adapters/scripts/_runtimePaths.js,
  // so `../../..` is the package root.
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  if (fs.existsSync(path.join(repoRoot, 'package.json')) &&
      isEvolverPackageJson(path.join(repoRoot, 'package.json'))) {
    return repoRoot;
  }

  // npm-global / npm-local install layout. The hook script may have been
  // copied out of the package into `.claude/hooks/` etc., breaking relative
  // walks. Use require.resolve to find the installed package authoritatively.
  //
  // SECURITY: do NOT include `process.cwd()` here. A hostile workspace can
  // place its own `node_modules/@evomap/evolver/package.json`, which would
  // be selected here and control `findMemoryGraph()` -> the memory graph
  // contents become attacker-controlled prompt-injection material in
  // `evolver-session-start.js`'s `additionalContext`. Restrict to trusted,
  // user/system-scoped install roots.
  try {
    const pkgJson = require.resolve('@evomap/evolver/package.json', {
      paths: [
        path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'),
        path.join(os.homedir(), '.local', 'lib', 'node_modules'),
        '/usr/lib/node_modules',
        '/usr/local/lib/node_modules',
      ],
    });
    if (pkgJson && isEvolverPackageJson(pkgJson)) {
      return path.dirname(pkgJson);
    }
  } catch { /* not installed via npm */ }

  const homeSkills = path.join(os.homedir(), 'skills', 'evolver');
  if (fs.existsSync(path.join(homeSkills, 'package.json')) &&
      isEvolverPackageJson(path.join(homeSkills, 'package.json'))) {
    return homeSkills;
  }

  return null;
}

// Resolve the user's PROJECT directory — the workspace the agent is actually
// working in — for git-diff collection and workspace tagging.
//
// Why this exists: hook scripts must NOT assume `process.cwd()` is the project
// root. Cursor invokes some hook events (e.g. afterFileEdit) with the working
// directory set to the *plugin* install dir (`~/.cursor/plugins/local/<name>`),
// not the opened workspace. A hook that runs `git diff` in cwd would then look
// for changes in the plugin directory and find none — silently recording
// nothing for every task. Hosts expose the real workspace root via an env var:
//   - Cursor sets CURSOR_PROJECT_DIR (and a CLAUDE_PROJECT_DIR compat alias)
//   - Claude Code sets CLAUDE_PROJECT_DIR
// Codex / opencode / Kiro and direct CLI usage leave both unset, in which case
// `process.cwd()` is already the project root and remains the fallback — so
// this change is a no-op on those platforms.
//
// SECURITY: only honor an env value that points at an existing directory. A
// stale or empty value must not redirect git collection to a bogus path; we
// fall through to cwd instead. We intentionally do NOT recurse into evolver
// package discovery here — this is purely "where is the user's code".
function resolveProjectDir() {
  for (const key of ['CURSOR_PROJECT_DIR', 'CLAUDE_PROJECT_DIR']) {
    const v = process.env[key];
    if (typeof v === 'string' && v.trim()) {
      try {
        if (fs.statSync(v).isDirectory()) return v;
      } catch { /* not a usable dir — try next / fall back to cwd */ }
    }
  }
  return process.cwd();
}

// Determine the workspace ROOT for a project, mirroring src/gep/paths.js
// getWorkspaceRoot() step-for-step so the FS-only fallback lands its secret at
// the SAME path paths.js would (what lets an installed @evomap/evolver read the
// very same id):
//   1. OPENCLAW_WORKSPACE override.
//   2. else the git repo root at/above projectDir, BUT if that repo root has a
//      `workspace/` subdirectory, paths.js returns <repoRoot>/workspace — so we
//      must too, or the two land on different .evolver/workspace-id files (the
//      "read back identically" guarantee would break for such projects).
//   3. else projectDir.
function _fsWorkspaceRoot(projectDir) {
  if (process.env.OPENCLAW_WORKSPACE) return process.env.OPENCLAW_WORKSPACE;
  // Walk up from projectDir looking for a .git entry (file or dir) = repo root.
  let repoRoot = null;
  let dir = projectDir;
  while (dir) {
    if (fs.existsSync(path.join(dir, '.git'))) { repoRoot = dir; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!repoRoot) return projectDir;
  // Mirror getWorkspaceRoot()'s workspace/ subdir step.
  const workspaceDir = path.join(repoRoot, 'workspace');
  if (fs.existsSync(workspaceDir)) return workspaceDir;
  return repoRoot;
}

// FS-only re-implementation of src/gep/paths.js getWorkspaceId() for the case
// where the evolver package is not installed (plugin-only installs). It reads
// — and lazily, atomically creates — the per-workspace secret at
// <workspaceRoot>/.evolver/workspace-id. The format (16-byte hex), the path,
// the 0600 mode, the O_EXCL|O_NOFOLLOW atomic create, and the symlink
// rejection all match paths.js exactly, so a workspace seeded by this fallback
// is transparently picked up by paths.getWorkspaceId() once the package is
// present, and vice-versa. Returns null on any read/write error (caller then
// falls back to legacy cwd-tag matching — no regression).
// Read <dir>/workspace-id with the same symlink guards paths.js'
// _readWorkspaceIdFromFs uses: reject a symlinked .evolver dir, reject a
// symlinked / non-regular id file, and require hex format. Returns the id, or
// null on any error / missing file. Used for BOTH the initial read and the
// EEXIST race re-read so a symlink swapped in between our lstat and openSync
// can never be followed (Bugbot PR #557).
function _readWsIdGuarded(dir, file) {
  try {
    const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (dirStat && dirStat.isSymbolicLink()) return null;
    const fileStat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!fileStat) return null;
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw && /^[a-f0-9]{32,}$/i.test(raw) ? raw : null;
  } catch { return null; }
}

function _fsWorkspaceId(projectDir) {
  // Whole body is wrapped: the documented contract is "returns null on ANY
  // read/write error" so the session-start/-end hooks degrade gracefully
  // rather than crash. throwIfNoEntry:false only suppresses ENOENT; EACCES/EIO
  // and friends still throw, so a bare lstat/mkdir here must not escape
  // (Bugbot PR #557 round-2 — an unguarded lstat could crash the hook).
  try {
    const dir = path.join(_fsWorkspaceRoot(projectDir), '.evolver');
    const file = path.join(dir, 'workspace-id');
    // Read first, with symlink guards.
    const existing = _readWsIdGuarded(dir, file);
    if (existing) return existing;
    // If the file exists but the guards rejected it (symlink / bad format),
    // refuse rather than create over it.
    if (fs.lstatSync(file, { throwIfNoEntry: false })) return null;
    // Missing — create atomically. Refuse a symlinked .evolver dir (O_NOFOLLOW
    // only guards the final component, not intermediate dirs).
    const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (dirStat && dirStat.isSymbolicLink()) return null;
    fs.mkdirSync(dir, { recursive: true });
    const payload = require('crypto').randomBytes(16).toString('hex');
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0);
    let fd;
    try {
      fd = fs.openSync(file, flags, 0o600);
    } catch (e) {
      // Lost a race — re-read WITH the same symlink guards (paths.js does the
      // same). A bare readFileSync here would follow a symlink swapped in
      // after our dir lstat (Bugbot PR #557).
      if (e && e.code === 'EEXIST') return _readWsIdGuarded(dir, file);
      return null; // ELOOP/EMLINK from O_NOFOLLOW hitting a symlink — refuse.
    }
    try { fs.writeSync(fd, payload + '\n', 0, 'utf8'); } finally { fs.closeSync(fd); }
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
    return payload;
  } catch { return null; }
}

// Resolve the current workspace id — the forge-resistant tag the session-end
// writer stamps on every memory-graph entry (`workspace_id`). This is the
// SINGLE source of that resolution: the session-end writer stamps it and the
// session-start reader scopes by it, so both call this one function. Keeping
// it here (rather than a copy per hook) is what guarantees reader and writer
// can never drift apart — if they resolved different ids, no entry would ever
// match the reader's filter and workspace scoping would silently break.
// Resolution order:
//   1. EVOLVER_WORKSPACE_ID env override
//   2. paths.getWorkspaceId() loaded from the resolved evolver root (this is
//      the richer path — it can additionally back the secret with the OS
//      keychain when @napi-rs/keyring is installed).
//   3. FS-only fallback for plugin-only installs where the evolver package is
//      not reachable. Without this, plugin users got workspace_id=null and the
//      forge-resistant scoping silently degraded to cwd-tag matching (found
//      via real-Cursor end-to-end testing). The fallback writes the same
//      secret file paths.js uses, so installing the package later is seamless.
// Still returns null if even the FS write fails — callers must then NOT filter
// (show everything), preserving prior behavior rather than hiding all memory.
function resolveWorkspaceId(evolverRoot, projectDir) {
  if (process.env.EVOLVER_WORKSPACE_ID) return String(process.env.EVOLVER_WORKSPACE_ID);
  const root = evolverRoot || findEvolverRoot();
  if (root) {
    try {
      const paths = require(path.join(root, 'src', 'gep', 'paths.js'));
      if (typeof paths.getWorkspaceId === 'function') return paths.getWorkspaceId();
    } catch { /* paths.js unreachable — fall through to FS-only */ }
  }
  return _fsWorkspaceId(projectDir || resolveProjectDir());
}

// Returns a path to the evolution memory graph, or a fallback location that
// is guaranteed to be writable. Never returns null — when no evolver root is
// available, we fall back to `~/.evolver/memory/evolution/memory_graph.jsonl`
// so npm-global installs without a project-local evolver still capture
// outcomes (#536). Callers that need a "does the file already exist" check
// should use `fs.existsSync()` separately.
function findMemoryGraph(evolverRoot) {
  if (process.env.MEMORY_GRAPH_PATH) {
    return process.env.MEMORY_GRAPH_PATH;
  }
  if (evolverRoot) {
    const lower = path.join(evolverRoot, 'memory', 'evolution', 'memory_graph.jsonl');
    if (fs.existsSync(lower)) return lower;
    const upper = path.join(evolverRoot, 'MEMORY', 'evolution', 'memory_graph.jsonl');
    if (fs.existsSync(upper)) return upper;
    // Neither exists yet — prefer lowercase under the evolver root if the
    // root itself is writable (dev/local install case).
    try {
      fs.accessSync(evolverRoot, fs.constants.W_OK);
      const dir = path.dirname(lower);
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* fall through */ }
      return lower;
    } catch { /* not writable, fall through to user-level */ }
  }

  // User-level fallback. Always writable, consistent across platforms.
  const userDir = path.join(os.homedir(), '.evolver', 'memory', 'evolution');
  try { fs.mkdirSync(userDir, { recursive: true }); } catch { /* best-effort */ }
  return path.join(userDir, 'memory_graph.jsonl');
}

// Is `dir` inside a git work tree? Cheap, no-shell `git rev-parse`. Returns
// false on any error (git missing, not a repo, timeout) and never throws — the
// session-start hook uses this only to decide whether to surface a one-line
// "evolver needs a git workspace" notice, so a false negative just suppresses
// the notice rather than breaking anything.
function isGitWorkspace(dir) {
  try {
    const res = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    return res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

module.exports = { findEvolverRoot, findMemoryGraph, resolveProjectDir, resolveWorkspaceId, isGitWorkspace };
