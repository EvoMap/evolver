/**
 * A skill a Gene needs, as one `preconditions` entry, so it is covered by the Gene's asset_id and needs no
 * wire-schema field. It either pins a git commit and the content of the skill directory, or follows a branch and
 * takes whatever the branch holds when it is installed:
 *
 *   skill:git+https://github.com/owner/repo@<commit>#sha256=<digest>&path=<dir inside the repo>
 *   skill:git+https://github.com/owner/repo@<branch>#path=<dir inside the repo>
 */
export type RequiredSkillRef = PinnedSkillRef | BranchSkillRef;
interface SkillLocation {
    /** Directory the skill is installed under: `skills/<name>/`. */
    name: string;
    repo: string;
    /** Skill directory inside the repository, POSIX separators; empty for the repository root. */
    path: string;
}
export interface PinnedSkillRef extends SkillLocation {
    commit: string;
    sha256: string;
}
export interface BranchSkillRef extends SkillLocation {
    branch: string;
}
/** A required skill as installed: the commit it came from and the digest of its content, whichever kind the Gene declared. */
export interface ResolvedSkill extends SkillLocation {
    commit: string;
    sha256: string;
    /** The branch the Gene follows, when it does not pin a commit. */
    branch?: string;
}
/** One file of a skill, with its path relative to the skill directory (POSIX separators). */
export interface SkillFile {
    path: string;
    content: Uint8Array;
}
/** One `git ls-tree -r -l` row, with its path relative to the skill directory. */
export interface SkillTreeEntry {
    mode: string;
    type: string;
    size: number;
    path: string;
}
export type Result<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    message: string;
};
/**
 * Read the skills a Gene requires from its `preconditions`. Only entries that start with `skill:git+` are
 * references; everything else, other `skill:` text included, stays an ordinary precondition. A reference that
 * cannot be honoured in full is an error, not a shorter list: installing some of what a Gene needs would hand the
 * agent a broken strategy.
 */
export declare function requiredSkillsOf(gene: Record<string, unknown>): Result<RequiredSkillRef[]>;
/** The `preconditions` entry that pins a skill directory with this content, or follows a branch. */
export declare function formatRequiredSkill(ref: Omit<PinnedSkillRef, 'name'> | Omit<BranchSkillRef, 'name'>): string;
/**
 * Content digest of a skill directory: SHA-256 over one `<sha256 of the file>  <path>\n` line per file, sorted by
 * path. It is the output of `sha256sum` over the sorted files, so an author can reproduce it without this tool.
 */
export declare function digestOfSkillFiles(files: readonly SkillFile[]): string;
/** Decide from the tree listing alone, before any file content is read, whether this directory may be installed. */
export declare function checkSkillTree(entries: readonly SkillTreeEntry[]): Result<true>;
export {};