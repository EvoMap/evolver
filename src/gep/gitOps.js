// Git operations extracted from solidify.js for maintainability.
// All functions that directly invoke git CLI or manage rollback live here.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getRepoRoot } = require('./paths');

// 10 MB — prevents RangeError: stdout maxBuffer length exceeded on large
// `git diff` / `git log` outputs. The default is ~1 MB which triggers ENOBUFS
// on repos with large refactors (see GHSA reports / issue #451).
const MAX_EXEC_BUFFER = 10 * 1024 * 1024;

function runCmd(cmd, opts = {}) {
  const cwd = opts.cwd || getRepoRoot();
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 120000;
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: MAX_EXEC_BUFFER, windowsHide: true });
}

function tryRunCmd(cmd, opts = {}) {
  try {
    return { ok: true, out: runCmd(cmd, opts), err: '' };
  } catch (e) {
    const stderr = e && e.stderr ? String(e.stderr) : '';
    const stdout = e && e.stdout ? String(e.stdout) : '';
    const msg = e && e.message ? String(e.message) : 'command_failed';
    return { ok: false, out: stdout, err: stderr || msg };
  }
}

function normalizeRelPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '').trim();
}

function countFileLines(absPath) {
  try {
    if (!fs.existsSync(absPath)) return 0;
    const buf = fs.readFileSync(absPath);
    if (!buf || buf.length === 0) return 0;
    let n = 1;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n;
  } catch {
    return 0;
  }
}

function gitListChangedFiles({ repoRoot }) {
  const files = new Set();
  const s1 = tryRunCmd('git diff --name-only', { cwd: repoRoot, timeoutMs: 60000 });
  if (s1.ok) for (const line of String(s1.out).split('\n').map(l => l.trim()).filter(Boolean)) files.add(line);
  const s2 = tryRunCmd('git diff --cached --name-only', { cwd: repoRoot, timeoutMs: 60000 });
  if (s2.ok) for (const line of String(s2.out).split('\n').map(l => l.trim()).filter(Boolean)) files.add(line);
  const s3 = tryRunCmd('git ls-files --others --exclude-standard', { cwd: repoRoot, timeoutMs: 60000 });
  if (s3.ok) for (const line of String(s3.out).split('\n').map(l => l.trim()).filter(Boolean)) files.add(line);
  return Array.from(files);
}

function gitListUntrackedFiles(repoRoot) {
  const r = tryRunCmd('git ls-files --others --exclude-standard', { cwd: repoRoot, timeoutMs: 60000 });
  if (!r.ok) return [];
  return String(r.out).split('\n').map(l => l.trim()).filter(Boolean);
}

const DIFF_SNAPSHOT_MAX_CHARS = 8000;

function captureDiffSnapshot(repoRoot) {
  const parts = [];
  const unstaged = tryRunCmd('git diff', { cwd: repoRoot, timeoutMs: 30000 });
  if (unstaged.ok && unstaged.out) parts.push(String(unstaged.out));
  const staged = tryRunCmd('git diff --cached', { cwd: repoRoot, timeoutMs: 30000 });
  if (staged.ok && staged.out) parts.push(String(staged.out));
  let combined = parts.join('\n');
  if (combined.length > DIFF_SNAPSHOT_MAX_CHARS) {
    combined = combined.slice(0, DIFF_SNAPSHOT_MAX_CHARS) + '\n... [TRUNCATED]';
  }
  return combined || '';
}

function isGitRepo(dir) {
  try {
    execSync('git rev-parse --git-dir', {
      cwd: dir, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: MAX_EXEC_BUFFER,
      windowsHide: true,
    });
    return true;
  } catch (_) {
    return false;
  }
}

const CRITICAL_PROTECTED_PREFIXES = [
  'skills/skill-tools/',
  'skills/git-sync/',
  'skills/evolver/',
];

const CRITICAL_PROTECTED_FILES = [
  'MEMORY.md',
  'SOUL.md',
  'IDENTITY.md',
  'AGENTS.md',
  'USER.md',
  'HEARTBEAT.md',
  'RECENT_EVENTS.md',
  'TOOLS.md',
  'TROUBLESHOOTING.md',
  'openclaw.json',
  'evolver.json',
  '.env',
  'package.json',
];

function isCriticalProtectedPath(relPath) {
  const rel = normalizeRelPath(relPath);
  if (!rel) return false;
  for (const prefix of CRITICAL_PROTECTED_PREFIXES) {
    const p = prefix.replace(/\/+$/, '');
    if (rel === p || rel.startsWith(p + '/')) return true;
  }
  for (const f of CRITICAL_PROTECTED_FILES) {
    if (rel === f) return true;
  }
  return false;
}

function rollbackTracked(repoRoot) {
  // Default 'stash' (was 'hard' through 1.80.7): a failed solidify cycle should
  // preserve the user's working-tree state in `git stash` so it can be recovered
  // via `git stash pop`, rather than discarding it via `git reset --hard`. The
  // hard-reset path remains available with explicit `EVOLVER_ROLLBACK_MODE=hard`.
  const mode = String(process.env.EVOLVER_ROLLBACK_MODE || 'stash').toLowerCase();

  if (mode === 'none') {
    console.log('[Rollback] EVOLVER_ROLLBACK_MODE=none, skipping rollback');
    return;
  }

  if (mode === 'stash') {
    const stashRef = 'evolver-rollback-' + Date.now();
    const result = tryRunCmd('git stash push -m "' + stashRef + '" --include-untracked', { cwd: repoRoot, timeoutMs: 60000 });
    if (result.ok) {
      console.log('[Rollback] Changes stashed with ref: ' + stashRef + '. Recover with "git stash list" and "git stash pop".');
    } else {
      console.log('[Rollback] Stash failed or no changes, using hard reset');
      tryRunCmd('git restore --staged --worktree .', { cwd: repoRoot, timeoutMs: 60000 });
      tryRunCmd('git reset --hard', { cwd: repoRoot, timeoutMs: 60000 });
    }
    return;
  }

  console.log('[Rollback] EVOLVER_ROLLBACK_MODE=hard, resetting tracked files in: ' + repoRoot);
  tryRunCmd('git restore --staged --worktree .', { cwd: repoRoot, timeoutMs: 60000 });
  tryRunCmd('git reset --hard', { cwd: repoRoot, timeoutMs: 60000 });
}

function rollbackNewUntrackedFiles({ repoRoot, baselineUntracked, cycleStartedAt }) {
  const baseline = new Set((Array.isArray(baselineUntracked) ? baselineUntracked : []).map(String));
  const current = gitListUntrackedFiles(repoRoot);
  // mtime guard: only delete files whose mtime is at-or-after the cycle start.
  // This protects files the user created/touched concurrently from another
  // editor between baseline capture and rollback. Without this guard, a parallel
  // unrelated edit landing in this window would be silently deleted.
  // `cycleStartedAt` accepts ISO string (e.g. last_run.created_at) or epoch ms.
  // When unset (legacy callers, tests), behaviour falls back to the prior
  // baseline-only filter.
  const cycleStartMs = (function () {
    if (cycleStartedAt == null) return 0;
    if (typeof cycleStartedAt === 'number' && Number.isFinite(cycleStartedAt)) return cycleStartedAt;
    const parsed = Date.parse(String(cycleStartedAt));
    return Number.isFinite(parsed) ? parsed : 0;
  })();
  const toDelete = current.filter(f => {
    if (baseline.has(String(f))) return false;
    if (!cycleStartMs) return true; // no guard available -> preserve old behaviour
    try {
      const abs = path.resolve(repoRoot, String(f));
      const st = fs.statSync(abs);
      // -1 ms tolerance for filesystem mtime resolution boundary.
      return st.mtimeMs >= cycleStartMs - 1;
    } catch {
      // Can't stat (race, permissions, broken symlink): err on the side of
      // not deleting. The file will appear again on the next cleanup if
      // it really is garbage.
      return false;
    }
  });
  const skipped = [];
  const deleted = [];
  for (const rel of toDelete) {
    const safeRel = String(rel || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!safeRel) continue;
    if (isCriticalProtectedPath(safeRel)) {
      skipped.push(safeRel);
      continue;
    }
    const abs = path.join(repoRoot, safeRel);
    const normRepo = path.resolve(repoRoot);
    const normAbs = path.resolve(abs);
    if (!normAbs.startsWith(normRepo + path.sep) && normAbs !== normRepo) continue;
    try {
      if (fs.existsSync(normAbs) && fs.statSync(normAbs).isFile()) {
        fs.unlinkSync(normAbs);
        deleted.push(safeRel);
      }
    } catch (e) {
      console.warn('[evolver] rollbackNewUntrackedFiles unlink failed:', safeRel, e && e.message || e);
    }
  }
  if (skipped.length > 0) {
    console.log(`[Rollback] Skipped ${skipped.length} critical protected file(s): ${skipped.slice(0, 5).join(', ')}`);
  }
  const dirsToCheck = new Set();
  for (let di = 0; di < deleted.length; di++) {
    let dir = path.dirname(deleted[di]);
    // path.dirname eventually returns '.' (relative) or a filesystem root.
    // On Windows the root is a drive letter like 'C:\', not '/'.
    // Detect stagnation: if dirname(x) === x we have hit the root on any platform.
    while (dir && dir !== '.') {
      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root reached (e.g. 'C:\' on Windows, '/' on Unix)
      const normalized = dir.replace(/\\/g, '/');
      if (!normalized.includes('/')) break;
      dirsToCheck.add(dir);
      dir = parent;
    }
  }
  const sortedDirs = Array.from(dirsToCheck).sort(function (a, b) { return b.length - a.length; });
  const removedDirs = [];
  for (let si = 0; si < sortedDirs.length; si++) {
    if (isCriticalProtectedPath(sortedDirs[si] + '/')) continue;
    const dirAbs = path.join(repoRoot, sortedDirs[si]);
    try {
      const entries = fs.readdirSync(dirAbs);
      if (entries.length === 0) {
        fs.rmdirSync(dirAbs);
        removedDirs.push(sortedDirs[si]);
      }
    } catch (e) {
      console.warn('[evolver] rollbackNewUntrackedFiles rmdir failed:', sortedDirs[si], e && e.message || e);
    }
  }
  if (removedDirs.length > 0) {
    console.log('[Rollback] Removed ' + removedDirs.length + ' empty director' + (removedDirs.length === 1 ? 'y' : 'ies') + ': ' + removedDirs.slice(0, 5).join(', '));
  }

  return { deleted, skipped, removedDirs };
}

module.exports = {
  runCmd,
  tryRunCmd,
  normalizeRelPath,
  countFileLines,
  gitListChangedFiles,
  gitListUntrackedFiles,
  captureDiffSnapshot,
  DIFF_SNAPSHOT_MAX_CHARS,
  isGitRepo,
  isCriticalProtectedPath,
  CRITICAL_PROTECTED_PREFIXES,
  CRITICAL_PROTECTED_FILES,
  rollbackTracked,
  rollbackNewUntrackedFiles,
};
