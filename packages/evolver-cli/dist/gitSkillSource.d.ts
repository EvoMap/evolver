import { type RequiredSkillRef, type Result, type SkillFile } from './requiredSkills.js';
type SkillSource = Pick<RequiredSkillRef, 'repo' | 'commit' | 'path'>;
/**
 * Fetch one commit of a public https repository and read a skill directory out of it. Nothing is checked out:
 * files are read from git objects, so repository filters, hooks, symlinks and submodules never touch the disk.
 */
export declare function fetchSkillFiles(source: SkillSource): Result<SkillFile[]>;
/** Read the regular files under `path` at `commit` from a local repository that already has the commit. */
export declare function readSkillTree(repoDir: string, commit: string, path: string): Result<SkillFile[]>;
export {};