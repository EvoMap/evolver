// Proven-success gate for publishing / uploading a gene (#581).
//
// A gene's `confidence` is minted from model self-report (solidify), text
// completeness (conversationDistiller), or is absent (like) — none of which
// prove the gene ever WORKED. Publishing such a gene to the market pairs it
// with a capsule and lets the Hub quality gate reject it after a round-trip
// ("never truly succeeded"). This predicate is the single, outcome-driven bar
// every publish/upload surface routes through, so an unproven gene is stopped
// locally with a clear reason instead of leaking to the Hub.
//
// Deliberately DISTINCT from `probationWouldPromote` (genePromotion.ts):
// auto-promotion runs with NO human in the loop, so it demands a strong, clean
// record (>= minSuccess successes AND zero failures). Publishing is human-
// initiated, so the bar is only "has this gene truly succeeded at least once"
// — a gene with many successes and one stray failure is still worth publishing,
// and blocking it on `failed === 0` would be wrong.
import { aggregateLearningHistory } from '../assetstore/learningHistory.js';
/**
 * The single publish/upload eligibility predicate: a gene may be published iff
 * it has at least one capsule with a `success` outcome.
 *
 * We count `success + inert`, NOT just `success`. aggregateLearningHistory
 * demotes a `success` capsule that carries no `proof_of_work` to `inert`
 * (#195), but the evox capsule builder (asset_builder.rs) does NOT emit
 * `proof_of_work` — a genuine successful run surfaces there as `inert`. Gating
 * publish on the proof-only `success` count would therefore block genes that
 * actually succeeded in production. "Has a success outcome" is the honest bar
 * for the publish gate; the proof/inert distinction stays where it belongs
 * (success-rate, auto-promote), not here. A gene with only failures — or one
 * never run at all — has `success + inert === 0` and is not publishable.
 */
export function isGenePublishEligible(view) {
    return view.success + (view.inert ?? 0) >= 1;
}
/**
 * Read-only: derive a gene's outcome evidence and whether it clears the publish
 * bar. Returns `no_proven_success` for a gene the store has never seen succeed,
 * so callers can surface a precise, self-serviceable reason.
 */
export async function assessGenePublishEvidence(store, geneId) {
    const view = await aggregateLearningHistory(store, geneId);
    const eligible = isGenePublishEligible(view);
    return {
        geneId,
        success: view.success,
        failed: view.failed,
        inert: view.inert ?? 0,
        total: view.total,
        eligible,
        reason: eligible ? 'eligible' : 'no_proven_success',
    };
}