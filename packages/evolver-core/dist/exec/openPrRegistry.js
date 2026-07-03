// Open-PR dedup (ported from v1 src/gep/openPRRegistry.js). An autonomous loop has been observed to
// independently re-implement work already in flight on an open PR — wasting a full agent run and dirtying
// the tree with a near-duplicate diff. This module lets the daemon ask, cheaply and BEFORE spawning an
// agent, "is an open PR already doing this?" (token overlap of the task's signals against PR titles/branches),
// and AFTER a diff, "does my change substantially overlap an open PR's files?" (file-set overlap).
//
// Seam-based like the rest of exec: the PR list is an injected OpenPrLister (default shells `gh pr list`).
// Graceful + opt-in: the default lister returns [] if gh is missing/unauthenticated/errors, so dedup simply
// turns itself off rather than failing a run; the daemon only consults it when a lister is wired in.
import { spawnCapture, scrubAgentEnv } from './claudeBridge.js';
// ── pure logic (fully testable, no subprocess) ─────────────────────────────
/**
 * Strongest file overlap by ratio = |shared| / |changedFiles|. We use the CYCLE's changed-file count as the
 * denominator (not the PR's): the question is "is this cycle re-doing work the PR already does?" — so a daemon
 * that changes 4 files, 3 of which are in a PR's 11-file diff, scores 0.75 (re-doing most of its own work)
 * even though that's only 0.27 of the PR. Returns { overlap:false, reason } when there's nothing to compare.
 */
export function findFileOverlap(changedFiles, prs) {
    const files = changedFiles.map(String).filter(Boolean);
    if (files.length === 0)
        return { overlap: false, reason: 'no_changed_files' };
    if (prs.length === 0)
        return { overlap: false, reason: 'no_open_prs' };
    const changedSet = new Set(files);
    let best = null;
    for (const pr of prs) {
        if (!pr.files?.length)
            continue;
        const prSet = new Set(pr.files.map(String));
        const shared = [...changedSet].filter((f) => prSet.has(f));
        if (shared.length === 0)
            continue;
        const ratio = shared.length / files.length;
        if (!best || ratio > best.overlapRatio) {
            best = { overlap: true, prNumber: pr.number, prTitle: pr.title, headRefName: pr.headRefName, overlapRatio: ratio, sharedFiles: shared };
        }
    }
    return best ?? { overlap: false, reason: 'no_intersection' };
}
function tokenize(s) {
    return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3);
}
/**
 * Token overlap between a task's signals and each PR's title + branch name — the pre-exec dedup signal, used
 * before any files exist. Returns the top-N PRs whose token overlap meets `threshold` (default 0.5), strongest
 * first. Denominator is the signal-token set, so this asks "how much of what I'm about to work on does this PR
 * already mention?".
 */
export function findSignalHints(signals, prs, opts = {}) {
    const threshold = opts.threshold ?? 0.5;
    const topN = opts.topN ?? 3;
    const sigTokens = new Set();
    for (const s of signals)
        for (const t of tokenize(s))
            sigTokens.add(t);
    if (sigTokens.size === 0 || prs.length === 0)
        return [];
    const hits = [];
    for (const pr of prs) {
        const prTokens = new Set();
        for (const t of tokenize(pr.title))
            prTokens.add(t);
        for (const t of tokenize(pr.headRefName))
            prTokens.add(t);
        if (prTokens.size === 0)
            continue;
        let common = 0;
        sigTokens.forEach((t) => { if (prTokens.has(t))
            common++; });
        const ratio = common / sigTokens.size;
        if (ratio >= threshold) {
            hits.push({ number: pr.number, title: pr.title, headRefName: pr.headRefName, files: (pr.files ?? []).slice(0, 5), tokenOverlap: ratio });
        }
    }
    hits.sort((a, b) => b.tokenOverlap - a.tokenOverlap);
    return hits.slice(0, topN);
}
// ── gh lister seam + TTL cache ─────────────────────────────────────────────
const GH_TIMEOUT_MS = 5000;
/**
 * Default lister: `gh pr list --state=open --json number,title,headRefName,files --limit 50`. Graceful —
 * returns [] on any failure (gh missing, unauthenticated, timeout, bad JSON) so dedup just turns off. gh is a
 * trusted infra tool, so its own auth (GH_TOKEN/GITHUB_TOKEN, or the gh config under $HOME) is passed through.
 */
export function makeGhPrLister() {
    return async (cwd) => {
        try {
            const r = await spawnCapture('gh', ['pr', 'list', '--state=open', '--json', 'number,title,headRefName,files', '--limit', '50'], {
                cwd: cwd ?? process.cwd(),
                timeoutMs: GH_TIMEOUT_MS,
                env: scrubAgentEnv(process.env, { allowKeys: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR'] }),
            });
            if (r.code !== 0)
                return [];
            const arr = JSON.parse(r.stdout || '[]');
            if (!Array.isArray(arr))
                return [];
            return arr.map((pr) => ({
                number: Number(pr.number),
                title: String(pr.title ?? ''),
                headRefName: String(pr.headRefName ?? ''),
                files: Array.isArray(pr.files) ? pr.files.map((f) => String(f.path ?? '')).filter(Boolean) : [],
            }));
        }
        catch {
            return [];
        }
    };
}
/**
 * Wrap a lister with a TTL cache + single-flight: a resident daemon polls often, but the open-PR set changes
 * slowly — don't shell `gh` every tick. Concurrent callers within the window share one in-flight fetch.
 */
export function makeCachedPrLister(lister, opts = {}) {
    const ttlMs = opts.ttlMs ?? 60_000;
    const now = opts.now ?? (() => Date.now());
    let cache = null;
    let cacheAt = 0;
    let inflight = null;
    return (cwd) => {
        if (cache && now() - cacheAt < ttlMs)
            return Promise.resolve(cache);
        if (inflight)
            return inflight; // share the in-flight fetch rather than spawning a second gh
        inflight = lister(cwd)
            .then((fresh) => { cache = fresh; cacheAt = now(); return fresh; })
            .finally(() => { inflight = null; });
        return inflight;
    };
}