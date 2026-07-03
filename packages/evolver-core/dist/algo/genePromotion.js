import { aggregateLearningHistory } from '../assetstore/learningHistory.js';
/** The default proven-success bar. Symmetric to reuse-report's prune threshold (a few clean signals, not one). */
export const DEFAULT_PROMOTE_MIN_SUCCESS = 3;
/**
 * The single promote predicate: a quarantined gene auto-promotes iff it has ZERO failures AND at least minSuccess
 * real (value-producing) successes. Inert (zero-work) successes are excluded by aggregateLearningHistory, so they
 * never count here. Every surface that judges promote-eligibility (auto-promote, reuse-report --promote, the
 * review listing) MUST route through this so they cannot diverge — e.g. a gene the review view labels "healthy"
 * by success-rate but that still has a failure must read as NOT promotable here.
 */
export function probationWouldPromote(view, minSuccess = DEFAULT_PROMOTE_MIN_SUCCESS) {
    return view.failed === 0 && view.success >= minSuccess;
}
/**
 * Read-only scan of the review ledger: for every QUARANTINED gene, derive its learning evidence and whether it
 * meets the promote bar right now. The single source of truth for the promote predicate — autoPromoteProbationGenes
 * acts on exactly this, and reuse-report --promote displays it. Never mutates the ledger.
 */
export async function scanProbationGenes(store, review, opts = {}) {
    const minSuccess = opts.minSuccess ?? DEFAULT_PROMOTE_MIN_SUCCESS;
    const out = [];
    for (const rec of review.records()) {
        if (rec.state !== 'quarantined')
            continue; // only probation drafts; human approve/reject is left alone
        const gene = await store.get(rec.assetId);
        if (!gene || gene.type !== 'Gene')
            continue;
        const geneId = typeof gene['id'] === 'string' ? String(gene['id']) : rec.assetId;
        const view = await aggregateLearningHistory(store, geneId);
        out.push({
            assetId: rec.assetId, geneId,
            success: view.success, failed: view.failed, inert: view.inert ?? 0, total: view.total,
            minSuccess, wouldPromote: probationWouldPromote(view, minSuccess),
        });
    }
    return out;
}
/**
 * Scan the review ledger for quarantined genes and auto-approve those whose cycle outcomes prove their value
 * (>= minSuccess real successes AND 0 failures). Returns the asset_ids promoted. Never promotes a gene with any
 * failure, nor one whose only "successes" were inert. Idempotent: an already-approved/rejected gene is skipped.
 */
export async function autoPromoteProbationGenes(store, review, opts = {}) {
    const by = opts.by ?? 'auto-promote';
    const promoted = [];
    for (const s of await scanProbationGenes(store, review, opts)) {
        if (!s.wouldPromote)
            continue;
        review.approve(s.assetId, by, `evidence: ${s.success}/${s.total} success, 0 fail (auto-promote #306)`);
        promoted.push(s.assetId);
    }
    return promoted;
}