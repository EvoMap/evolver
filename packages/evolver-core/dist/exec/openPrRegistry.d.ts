export interface OpenPr {
    number: number;
    title: string;
    headRefName: string;
    files: readonly string[];
}
export interface FileOverlap {
    overlap: true;
    prNumber: number;
    prTitle: string;
    headRefName: string;
    /** |shared| / |changedFiles| — what fraction of MY change is the PR already doing. */
    overlapRatio: number;
    sharedFiles: string[];
}
export type FileOverlapResult = FileOverlap | {
    overlap: false;
    reason: string;
};
export interface SignalHint {
    number: number;
    title: string;
    headRefName: string;
    files: readonly string[];
    /** |shared signal tokens| / |signal tokens| — how much of the task's vocabulary the PR already covers. */
    tokenOverlap: number;
}
/** List the repo's open PRs. Default = `gh pr list`; inject a fake in tests. cwd selects the repo. */
export type OpenPrLister = (cwd?: string) => Promise<OpenPr[]>;
/**
 * Strongest file overlap by ratio = |shared| / |changedFiles|. We use the CYCLE's changed-file count as the
 * denominator (not the PR's): the question is "is this cycle re-doing work the PR already does?" — so a daemon
 * that changes 4 files, 3 of which are in a PR's 11-file diff, scores 0.75 (re-doing most of its own work)
 * even though that's only 0.27 of the PR. Returns { overlap:false, reason } when there's nothing to compare.
 */
export declare function findFileOverlap(changedFiles: readonly string[], prs: readonly OpenPr[]): FileOverlapResult;
/**
 * Token overlap between a task's signals and each PR's title + branch name — the pre-exec dedup signal, used
 * before any files exist. Returns the top-N PRs whose token overlap meets `threshold` (default 0.5), strongest
 * first. Denominator is the signal-token set, so this asks "how much of what I'm about to work on does this PR
 * already mention?".
 */
export declare function findSignalHints(signals: readonly string[], prs: readonly OpenPr[], opts?: {
    threshold?: number;
    topN?: number;
}): SignalHint[];
/**
 * Default lister: `gh pr list --state=open --json number,title,headRefName,files --limit 50`. Graceful —
 * returns [] on any failure (gh missing, unauthenticated, timeout, bad JSON) so dedup just turns off. gh is a
 * trusted infra tool, so its own auth (GH_TOKEN/GITHUB_TOKEN, or the gh config under $HOME) is passed through.
 */
export declare function makeGhPrLister(): OpenPrLister;
/**
 * Wrap a lister with a TTL cache + single-flight: a resident daemon polls often, but the open-PR set changes
 * slowly — don't shell `gh` every tick. Concurrent callers within the window share one in-flight fetch.
 */
export declare function makeCachedPrLister(lister: OpenPrLister, opts?: {
    ttlMs?: number;
    now?: () => number;
}): OpenPrLister;