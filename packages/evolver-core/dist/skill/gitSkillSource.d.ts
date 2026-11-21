import { type BranchSkillRef, type PinnedSkillRef, type Result, type SkillFile } from './requiredSkills.js';
type SkillSource = Pick<PinnedSkillRef, 'repo' | 'commit' | 'path'> | Pick<BranchSkillRef, 'repo' | 'branch' | 'path'>;
/** A skill directory as read from git, with the commit it was read from: the pinned one, or the branch's tip at fetch time. */
export interface FetchedSkill {
    commit: string;
    files: SkillFile[];
}
/**
 * Fetch one commit of a public https repository, or the current tip of one of its branches, and read a skill
 * directory out of it. Nothing is checked out: files are read from git objects, so repository filters, hooks,
 * symlinks and submodules never touch the disk. Asynchronous, so a long fetch never stalls the process that waits on
 * it (the MCP server keeps serving).
 */
export declare function fetchSkillFiles(source: SkillSource): Promise<Result<FetchedSkill>>;
/** Read the regular files under `path` at `commit` from a local repository that already has the commit. */
export declare function readSkillTree(repoDir: string, commit: string, path: string): Promise<Result<SkillFile[]>>;
export declare function forwardedGitConfig(cwd: string): Promise<Record<string, string>>;
export {};