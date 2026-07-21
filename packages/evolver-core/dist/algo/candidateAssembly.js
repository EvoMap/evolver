import { aggregateLearningHistory } from '../assetstore/learningHistory.js';
import { reuseSentiment } from '../ops/reuseOutcomes.js';
import { tagOverlapScore } from '../signals/expand.js';
import { bannedGenesFromFailures } from './bans.js';
import { geneGenerationSource } from './geneIntake.js';
function asStrings(v) {
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}
function stringField(v) {
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}
function severityOf(v) {
    return v === 'low' || v === 'medium' || v === 'high' ? v : undefined;
}
function candidateIds(geneId, assetId) {
    return [...new Set([geneId, assetId].filter((id) => typeof id === 'string' && id.length > 0))];
}
function isBannedCandidate(banned, geneId, assetId) {
    return candidateIds(geneId, assetId).some((id) => banned.has(id));
}
function passesInjectedCandidateGates(candidate, opts, provenance, review) {
    const assetId = candidate.assetId;
    if (opts.provenance && !opts.includeUntrusted) {
        if (!assetId || provenance?.get(assetId)?.trusted !== true)
            return false;
    }
    if (opts.review) {
        const reviewRecord = assetId ? review?.get(assetId) : undefined;
        if (!assetId || (reviewRecord !== undefined && reviewRecord.state !== 'approved'))
            return false;
    }
    return true;
}
/** A zero learning view for a gene with no capsules yet (used for lightweight distilled-fallback candidates). */
function emptyLearningView(geneId) {
    return { geneId, total: 0, success: 0, failed: 0, successRate: 0, avgScore: 0, recentCapsuleIds: [] };
}
/** Combined reuse sentiment across ALL of a candidate's ids (#268 Bugbot). Reuse events key by assetId — which
 *  may be the content asset_id OR the logical id — while candidates key by geneId, AND one gene's events can SPLIT
 *  across both forms. So we SUM the counts of every distinct id the candidate has, then compute sentiment once:
 *  averaging two per-id sentiments (or taking the first) would let negatives stored under one id be ignored. */
function combinedReuseSentiment(map, ...ids) {
    if (!map)
        return undefined;
    let success = 0, negative = 0, found = false;
    const seen = new Set();
    for (const id of ids) {
        if (id === undefined || seen.has(id))
            continue;
        seen.add(id);
        const c = map.get(id);
        if (c) {
            success += c.success;
            negative += c.negative;
            found = true;
        }
    }
    return found ? reuseSentiment({ success, negative }) : undefined;
}
/** Genes banned by repeated signal-matched failures (>=2 failed capsules covering the signals). */
async function computeBans(store, signals, limit) {
    const caps = await store.search({ kind: 'Capsule', signalsAny: [...signals], limit });
    const failures = caps
        .filter((c) => c['outcome']?.status === 'failed')
        .map((c) => ({
        gene: typeof c['gene'] === 'string' ? String(c['gene']) : undefined,
        trigger: asStrings(c['trigger']),
    }));
    return bannedGenesFromFailures(failures, signals);
}
/**
 * Assemble the full selection pool from the store for the given signals: the relevant scored candidates AND the
 * distilled-gene fallback pool, in a single pass over the gene list (one store.list + one ban computation). A gene
 * is a normal candidate if its signals_match literally intersects the signals OR semantically overlaps them (so a
 * '429' signal can still reach a gene tagged for 'repair'); a trusted/approved/non-banned *distilled* gene that
 * does NOT match goes to `distilledFallback` (v1 #97).
 */
export async function assembleSelectionPool(store, signals, opts = {}) {
    const limit = opts.limit ?? 500;
    const genes = await store.list('Gene', limit);
    const banned = await computeBans(store, signals, limit);
    const sigSet = new Set(signals);
    const provenance = opts.provenance?.snapshot();
    const review = opts.review?.snapshot();
    const out = [];
    const distilledFallback = [];
    const antiWarnings = [];
    for (const g of genes) {
        // Trust-first (#30): untrusted (e.g. hub-ingested) genes are excluded from the candidate pool by default;
        // they enter only with includeUntrusted or after an explicit promotion. Provenance is keyed by asset_id.
        if (opts.provenance && !opts.includeUntrusted && provenance?.get(String(g.asset_id))?.trusted === false)
            continue;
        // Review-first (#89/#91): auto-distilled drafts land quarantined until a human approves; rejected drafts stay
        // out too. No record → eligible (cycle/migrate genes). Symmetric to the provenance trust-first filter above.
        // Probation (#306): includeProbation lets a quarantined draft be TRIED so it can earn evidence; a rejected
        // draft is never tried. Off (default) keeps quarantined drafts out until approval.
        const reviewRecord = review?.get(String(g.asset_id));
        if (opts.review && reviewRecord !== undefined && reviewRecord.state !== 'approved'
            && (!opts.includeProbation || reviewRecord.state === 'rejected'))
            continue;
        const geneId = typeof g['id'] === 'string' ? String(g['id']) : String(g.asset_id);
        const assetId = String(g.asset_id);
        if (isBannedCandidate(banned, geneId, assetId))
            continue; // repeated signal-matched failures → not a candidate (nor a fallback)
        const signalsMatch = asStrings(g['signals_match']);
        const category = typeof g['category'] === 'string' ? String(g['category']) : undefined;
        const summary = typeof g['summary'] === 'string' ? String(g['summary']) : undefined;
        const literal = signalsMatch.some((m) => sigSet.has(m));
        const relevant = literal || tagOverlapScore(signals, { signalsMatch, geneId, category, summary }) > 0;
        if (!relevant) {
            // #97: a trusted, approved, non-banned distilled (or evolved) gene that doesn't match the live signals is not
            // a normal candidate, but it IS eligible as a last-resort fallback (selection uses it only when nothing clears
            // the floor). Eligibility here is gated by trust/review/ban, not by skill provenance. Provenance is read from
            // generation_meta (V1 #302); a legacy gene without it falls back to the `gene_distilled_` id namespace.
            // Lightweight: no learning-history aggregation — it is picked first-match, not ranked by health.
            const gsrc = geneGenerationSource(g, geneId);
            if (gsrc === 'distilled' || gsrc === 'evolved') {
                distilledFallback.push({
                    geneId,
                    assetId,
                    signalsMatch,
                    view: emptyLearningView(geneId),
                    reuseCount: 0,
                    generationSource: gsrc,
                    ...(category ? { category } : {}),
                    ...(summary ? { summary } : {}),
                });
            }
            continue;
        }
        const view = await aggregateLearningHistory(store, geneId);
        // #268 Bugbot: reuse events key by assetId, which may be the content asset_id (sha256:…) OR the logical id —
        // candidates key by the logical geneId. Look the sentiment up by BOTH so the soft re-order actually matches
        // regardless of which form the reuse-result carried (recall's resolveGene accepts both for the same reason).
        const reuseAdjustVal = combinedReuseSentiment(opts.reuseCounts, geneId, String(g.asset_id));
        out.push({
            geneId,
            assetId: String(g.asset_id),
            signalsMatch,
            view,
            // #195: inert (zero-work) cycles are not productive reuse — exclude them so a do-nothing gene can't earn
            // the reuse bonus. success + failed === total when there are no inert cycles (back-compat).
            reuseCount: view.success + view.failed,
            ...(category ? { category } : {}),
            ...(summary ? { summary } : {}),
            ...(reuseAdjustVal !== undefined ? { reuseAdjust: reuseAdjustVal } : {}),
        });
    }
    // #110: merge hub reuse candidates into the same pool, trust-first — local (trusted) genes win on a
    // geneId collision, and a hub candidate banned by repeated signal-matched failures stays out too.
    if (opts.hubCandidates && opts.hubCandidates.length > 0) {
        const localIds = new Set(out.map((c) => c.geneId));
        for (const h of opts.hubCandidates) {
            if (!passesInjectedCandidateGates(h, opts, provenance, review))
                continue;
            if (localIds.has(h.geneId))
                continue; // a trusted local gene already covers this id
            if (isBannedCandidate(banned, h.geneId, h.assetId))
                continue;
            // Stamp the reuse sentiment onto a hub candidate too (only when it didn't carry one), matched by its geneId
            // OR its asset_id — symmetric with local genes, so a map keyed like reuse events (often sha256:…) still hits
            // (#268 Bugbot). A hub candidate that exposes neither matching id is simply left unstamped.
            const hubAdj = h.reuseAdjust === undefined ? combinedReuseSentiment(opts.reuseCounts, h.geneId, h.assetId) : undefined;
            out.push(hubAdj !== undefined ? { ...h, reuseAdjust: hubAdj } : h);
            localIds.add(h.geneId);
        }
    }
    for (const a of await store.list('AntiGene', limit)) {
        // AntiGene is negative memory that changes an autonomous prompt. Unlike legacy/cycle-authored Genes, it must
        // never inherit ReviewLedger's backward-compatible "no record = approved" default: no ledger, no record,
        // quarantined, and rejected all fail closed. Only an explicit human approval can enable warning injection.
        if (review?.get(String(a.asset_id))?.state !== 'approved')
            continue;
        const trigger = asStrings(a['trigger']);
        const avoid = asStrings(a['avoid']);
        if (trigger.length === 0 || avoid.length === 0)
            continue;
        const antiGeneId = stringField(a['id']) ?? String(a.asset_id);
        const summary = stringField(a['summary']);
        const relevant = trigger.some((m) => sigSet.has(m))
            || tagOverlapScore(signals, { signalsMatch: trigger, geneId: antiGeneId, summary }) > 0;
        if (!relevant)
            continue;
        const severity = severityOf(a['severity']);
        const rationale = stringField(a['rationale']);
        antiWarnings.push({
            antiGeneId,
            assetId: String(a.asset_id),
            trigger,
            avoid,
            ...(summary ? { summary } : {}),
            ...(severity ? { severity } : {}),
            ...(rationale ? { rationale } : {}),
        });
    }
    return { candidates: out, distilledFallback, antiWarnings };
}
/**
 * Assemble selection candidates from the store for the given signals (the relevant scored set only).
 * Thin wrapper over {@link assembleSelectionPool} kept for back-compat with callers that don't use the
 * distilled-gene fallback pool.
 */
export async function assembleCandidates(store, signals, opts = {}) {
    return (await assembleSelectionPool(store, signals, opts)).candidates;
}