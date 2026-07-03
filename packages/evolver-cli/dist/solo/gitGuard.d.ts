/** True if the repo has any staged/unstaged/untracked changes. */
export declare function hasUncommittedChanges(repoDir: string): boolean;
/**
 * Capture a rollback point for the current cycle. Returns the HEAD sha, or null
 * if the repo can't be snapshotted (not a git repo, no commits, git missing).
 * A null snapshot disables rollback for that cycle rather than throwing — solo
 * must not crash because the target isn't a git repo.
 */
export declare function snapshot(repoDir: string): string | null;
/**
 * Roll the target repo back to a snapshot sha: discard tracked-file edits
 * (reset --hard) AND remove new files the cycle created (clean -fd), so the
 * working tree matches the pre-cycle state. No-op when sha is null. Returns true
 * on success, false if the rollback itself failed (surfaced by the caller so a
 * wedged repo doesn't masquerade as a clean recovery).
 */
export declare function rollbackTo(repoDir: string, sha: string | null): boolean;