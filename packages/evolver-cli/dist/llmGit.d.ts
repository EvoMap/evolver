import { exec } from '@evomap/evolver-core';
/**
 * Trusted host Git composition for the bounded file executor. Repository configuration is
 * rechecked for each invocation, including worktree creation before model dispatch. This is
 * not a sandbox for custom Git runners: an injected runner and patch writer are trusted seams.
 */
export declare function createLlmGit(repo: string, acceptancePaths?: readonly string[]): {
    git: exec.GitRunner;
    gitPatchWriter: exec.GitPatchWriter;
};