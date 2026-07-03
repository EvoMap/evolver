import type { ProofOfWork } from '../schema/proofOfWork.js';
export interface DiffStat {
    files: number;
    lines: number;
}
/** Parse `git diff --shortstat` output, e.g. " 3 files changed, 12 insertions(+), 4 deletions(-)". */
export declare function parseGitShortstat(out: string): DiffStat;
/** Build a git_diff ProofOfWork from a parsed diff stat. */
export declare function gitDiffProof(stat: DiffStat, patchRef?: string): ProofOfWork;