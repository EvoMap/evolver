/** Parse `git diff --shortstat` output, e.g. " 3 files changed, 12 insertions(+), 4 deletions(-)". */
export function parseGitShortstat(out) {
    const files = /(\d+)\s+files?\s+changed/.exec(out)?.[1];
    const ins = /(\d+)\s+insertions?\(\+\)/.exec(out)?.[1];
    const del = /(\d+)\s+deletions?\(-\)/.exec(out)?.[1];
    return { files: Number(files ?? 0), lines: Number(ins ?? 0) + Number(del ?? 0) };
}
/** Build a git_diff ProofOfWork from a parsed diff stat. */
export function gitDiffProof(stat, patchRef) {
    return { kind: 'git_diff', gitDiff: { files: stat.files, lines: stat.lines, ...(patchRef ? { patchRef } : {}) } };
}