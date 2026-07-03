// Solo-mode git safety net (--solo), TypeScript port of the v1 gitGuard.
//
// The wild Mad Dog loop self-modifies its target project every cycle with no
// undo. Solo trades the human-review gate for a mechanical one: snapshot the
// target repo before each cycle, and on a failed cycle hard-reset back to that
// snapshot so a broken self-edit cannot accumulate. This guards the TARGET
// project repo (autoexec's first allowlisted root), NOT evolver's own source.
//
// All git calls go through execFileSync (never a shell) so a repo path or
// branch name can't be interpreted as a command. Pure and dependency-free so
// solo/gitGuard.test.ts can exercise it against a throwaway repo.
import { execFileSync } from 'node:child_process';
function git(repoDir, args) {
    return execFileSync('git', ['-C', repoDir, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}
/** True if the repo has any staged/unstaged/untracked changes. */
export function hasUncommittedChanges(repoDir) {
    try {
        return git(repoDir, ['status', '--porcelain']).trim().length > 0;
    }
    catch {
        // Not a git repo / git missing: treat as "can't tell" → no clean baseline.
        return false;
    }
}
/**
 * Capture a rollback point for the current cycle. Returns the HEAD sha, or null
 * if the repo can't be snapshotted (not a git repo, no commits, git missing).
 * A null snapshot disables rollback for that cycle rather than throwing — solo
 * must not crash because the target isn't a git repo.
 */
export function snapshot(repoDir) {
    try {
        const sha = git(repoDir, ['rev-parse', 'HEAD']).trim();
        return sha || null;
    }
    catch {
        return null;
    }
}
/**
 * Roll the target repo back to a snapshot sha: discard tracked-file edits
 * (reset --hard) AND remove new files the cycle created (clean -fd), so the
 * working tree matches the pre-cycle state. No-op when sha is null. Returns true
 * on success, false if the rollback itself failed (surfaced by the caller so a
 * wedged repo doesn't masquerade as a clean recovery).
 */
export function rollbackTo(repoDir, sha) {
    if (!sha)
        return false;
    try {
        git(repoDir, ['reset', '--hard', sha]);
        git(repoDir, ['clean', '-fd']);
        return true;
    }
    catch {
        return false;
    }
}