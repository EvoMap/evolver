/**
 * A skill a Gene needs, pinned to a git commit and to the content of the skill directory. It travels as one
 * `preconditions` entry, so it is covered by the Gene's asset_id and needs no wire-schema field:
 *
 *   skill:git+https://github.com/owner/repo@<commit>#sha256=<digest>&path=<dir inside the repo>
 */
export interface RequiredSkillRef {
    /** Directory the skill is installed under: `skills/<name>/`. */
    name: string;
    repo: string;
    commit: string;
    /** Skill directory inside the repository, POSIX separators; empty for the repository root. */
    path: string;
    sha256: string;
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
/** The `preconditions` entry that pins a skill directory with this content. */
export declare function formatRequiredSkill(ref: Pick<RequiredSkillRef, 'repo' | 'commit' | 'path' | 'sha256'>): string;
/**
 * Content digest of a skill directory: SHA-256 over one `<sha256 of the file>  <path>\n` line per file, sorted by
 * path. It is the output of `sha256sum` over the sorted files, so an author can reproduce it without this tool.
 */
export declare function digestOfSkillFiles(files: readonly SkillFile[]): string;
/** Decide from the tree listing alone, before any file content is read, whether this directory may be installed. */
export declare function checkSkillTree(entries: readonly SkillTreeEntry[]): Result<true>;