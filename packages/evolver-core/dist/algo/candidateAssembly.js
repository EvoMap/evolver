import { aggregateLearningHistory } from '../assetstore/learningHistory.js';
import { reuseSentiment } from '../ops/reuseOutcomes.js';
import { decideKauto } from './kautoValidator.js';
import { isProjectionRevoked } from './kautoProjection.js';
import { expandSignals, geneTags, tagOverlapScore, } from '../signals/expand.js';
import { resolveTaskDomainSignals, withoutTaskDomainSignals } from '../signals/taskDomain.js';
import { bannedGenesFromFailures } from './bans.js';
import { geneGenerationSource } from './geneIntake.js';
import { isCompatibilityBlocked } from '../modelCompatibility.js';
const SEMANTIC_CORPUS_LIMIT = 1_000;
function asStrings(v) {
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}
function stringField(v) {
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}
function firstStringField(record, keys) {
    for (const key of keys) {
        const value = stringField(record[key]);
        if (value)
            return value;
    }
    return undefined;
}
function recordList(v) {
    return Array.isArray(v) ? v.filter((x) => x !== null && typeof x === 'object' && !Array.isArray(x)) : [];
}
function failureIdentitySource(record) {
    for (const trace of recordList(record['execution_trace'])) {
        const stage = stringField(trace['stage']);
        if (stage === 'validate' && firstStringField(trace, ['root_attempt_id', 'rootAttemptId', 'execution_id', 'executionId', 'failure_id', 'failureId', 'verifier_digest', 'verifierDigest', 'artifact_digest', 'artifactDigest']))
            return trace;
    }
    return record;
}
function failureRefFromCapsule(record) {
    const identity = failureIdentitySource(record);
    return {
        gene: stringField(record['gene']),
        trigger: asStrings(record['trigger']),
        failureId: firstStringField(identity, ['failure_id', 'failureId']),
        rootAttemptId: firstStringField(identity, ['root_attempt_id', 'rootAttemptId', 'attempt_root_id', 'attemptRootId']),
        executionId: firstStringField(identity, ['execution_id', 'executionId', 'run_id', 'runId', 'cycle_id', 'cycleId']),
        verifierDigest: firstStringField(identity, ['verifier_digest', 'verifierDigest']),
        artifactDigest: firstStringField(identity, ['artifact_digest', 'artifactDigest']),
    };
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
function requiredSignals(signalsMatch) {
    return signalsMatch.flatMap((signal) => signal.startsWith('required:') ? [signal.slice('required:'.length).trim()] : []).filter(Boolean);
}
function matchSignals(signalsMatch) {
    return signalsMatch.map((signal) => signal.startsWith('required:') ? signal.slice('required:'.length).trim() : signal).filter(Boolean);
}
function passesRequiredSignals(signalsMatch, liveSignals) {
    const required = requiredSignals(signalsMatch);
    return required.length === 0 || required.every((signal) => liveSignals.has(signal));
}
function passesFallbackTaskDomain(liveSignals, candidateSignals) {
    const candidateDomain = resolveTaskDomainSignals(candidateSignals);
    if (candidateDomain.status === 'absent')
        return true;
    if (candidateDomain.status !== 'resolved')
        return false;
    const liveDomain = resolveTaskDomainSignals(liveSignals);
    return liveDomain.status === 'resolved' && liveDomain.slug === candidateDomain.slug;
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
    if (signals.length === 0)
        return new Set();
    const caps = await store.search({ kind: 'Capsule', signalsAny: [...signals], limit });
    const failures = caps
        .filter((c) => c['outcome']?.status === 'failed')
        .map((c) => failureRefFromCapsule(c));
    return bannedGenesFromFailures(failures, signals);
}
const GENERIC_NAMESPACE_TAGS = new Set(['action', 'area', 'problem', 'risk', 'signal']);
// Generic namespace tags and inferred action/signal subtypes are too broad to admit a candidate by themselves.
function hasSelectionAdmissionEvidence(liveSignals, gene) {
    const tags = new Set(geneTags(gene));
    const triggerTags = new Set(expandSignals(gene.signalsMatch ?? []));
    const categoryActionTag = gene.category ? `action:${gene.category.toLowerCase()}` : undefined;
    if (liveSignals.some((signal) => ((triggerTags.has(signal) || signal === categoryActionTag)
        && !GENERIC_NAMESPACE_TAGS.has(signal)))) {
        return true;
    }
    const liveTags = expandSignals(liveSignals);
    if (liveTags.some((tag) => (tags.has(tag)
        && (tag.startsWith('problem:')
            || tag.startsWith('area:')
            || tag.startsWith('risk:')))))
        return true;
    return liveTags.some((tag) => tag.startsWith('signal:') && triggerTags.has(tag));
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
    const includeSemanticCorpus = opts.includeSemanticCorpus !== false;
    const scanLimit = includeSemanticCorpus ? Math.max(limit, SEMANTIC_CORPUS_LIMIT) : limit;
    const genes = await store.list('Gene', scanLimit);
    const matchingSignals = withoutTaskDomainSignals(signals);
    const banned = await computeBans(store, matchingSignals, limit);
    const liveSignalSet = new Set(signals);
    const sigSet = new Set(matchingSignals);
    const provenance = opts.provenance?.snapshot();
    const review = opts.review?.snapshot();
    const out = [];
    const distilledFallback = [];
    const semanticCorpus = [];
    const semanticIdentities = new Set();
    const addSemanticCandidate = (candidate) => {
        if (!includeSemanticCorpus || semanticCorpus.length >= SEMANTIC_CORPUS_LIMIT)
            return;
        const identity = candidate.assetId ?? candidate.geneId;
        if (semanticIdentities.has(identity))
            return;
        semanticIdentities.add(identity);
        semanticCorpus.push(candidate);
    };
    const antiWarnings = [];
    for (const [geneIndex, g] of genes.entries()) {
        const provenanceRecord = provenance?.get(String(g.asset_id));
        if (isCompatibilityBlocked({ assetType: 'Gene', assetId: String(g.asset_id), revision: stringField(g['revision']) ?? '' }, opts.compatibility))
            continue;
        // Trust-first (#30): untrusted (e.g. hub-ingested) genes are excluded from the candidate pool by default;
        // they enter only with includeUntrusted or after an explicit promotion. Provenance is keyed by asset_id.
        if (opts.provenance && !opts.includeUntrusted && provenanceRecord?.trusted === false)
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
        // K_auto projection revocation (T1, opt-in). A decidable record whose current five-coordinate projection
        // touches a revoked (coordinate, value) pair is not eligible — coordinate-locally, so a sibling differing on
        // the revoked coordinate is unaffected. Runs AFTER trust/review/ban (those are the deployed hard gates) and
        // before signal matching, so a revoked projection is dropped from both the candidate and #97 fallback pools.
        // Default-off: without opts.kautoProjection the deployed T2 path is unchanged.
        if (opts.kautoProjection
            && isProjectionRevoked(decideKauto(g, opts.kautoProjection.runtimeRegistry ? { runtimeRegistry: opts.kautoProjection.runtimeRegistry } : undefined), opts.kautoProjection.revoked))
            continue;
        const signalsMatch = asStrings(g['signals_match']);
        const effectiveSignalsMatch = matchSignals(signalsMatch);
        const category = typeof g['category'] === 'string' ? String(g['category']) : undefined;
        const summary = typeof g['summary'] === 'string' ? String(g['summary']) : undefined;
        // Experimental probation and explicitly untrusted records may be selectable by opt-in, but never shape global
        // document frequency. Only trusted, approved/legacy-local records enter the pre-admission semantic corpus.
        if (provenanceRecord?.trusted !== false && (reviewRecord === undefined || reviewRecord.state === 'approved')) {
            addSemanticCandidate({
                geneId,
                assetId,
                signalsMatch: effectiveSignalsMatch,
                view: emptyLearningView(geneId),
                ...(category ? { category } : {}),
                ...(summary ? { summary } : {}),
            });
        }
        if (geneIndex >= limit)
            continue;
        if (!passesRequiredSignals(signalsMatch, liveSignalSet))
            continue;
        const matchingSignalsForGene = withoutTaskDomainSignals(effectiveSignalsMatch);
        const literal = matchingSignalsForGene.some((m) => sigSet.has(m));
        const tagInput = { signalsMatch: matchingSignalsForGene, geneId, category, summary };
        const relevant = literal || hasSelectionAdmissionEvidence(matchingSignals, tagInput);
        if (!relevant) {
            // #97: a trusted, approved, non-banned distilled (or evolved) gene that doesn't match the live signals is not
            // a normal candidate, but it IS eligible as a last-resort fallback (selection uses it only when nothing clears
            // the floor). Eligibility here is gated by trust/review/ban, not by skill provenance. Provenance is read from
            // generation_meta (V1 #302); a legacy gene without it falls back to the `gene_distilled_` id namespace.
            // Lightweight: no learning-history aggregation — it is picked first-match, not ranked by health.
            const gsrc = geneGenerationSource(g, geneId);
            if ((gsrc === 'distilled' || gsrc === 'evolved')
                && passesFallbackTaskDomain(signals, effectiveSignalsMatch)) {
                distilledFallback.push({
                    geneId,
                    assetId,
                    signalsMatch: effectiveSignalsMatch,
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
        const explorationEligible = provenanceRecord?.trusted !== false
            && (reviewRecord === undefined || reviewRecord.state === 'approved');
        // #268 Bugbot: reuse events key by assetId, which may be the content asset_id (sha256:…) OR the logical id —
        // candidates key by the logical geneId. Look the sentiment up by BOTH so the soft re-order actually matches
        // regardless of which form the reuse-result carried (recall's resolveGene accepts both for the same reason).
        const reuseAdjustVal = combinedReuseSentiment(opts.reuseCounts, geneId, String(g.asset_id));
        // Soft K_auto preference: stamp only when the source record clears the strict five-coordinate bar.
        // Absent/false leaves score unchanged so the historical non-member catalogue is not zeroed.
        const kautoMember = decideKauto(g).inKauto;
        out.push({
            geneId,
            assetId: String(g.asset_id),
            signalsMatch: effectiveSignalsMatch,
            view,
            // #195: inert (zero-work) cycles are not productive reuse — exclude them so a do-nothing gene can't earn
            // the reuse bonus. success + failed === total when there are no inert cycles (back-compat).
            reuseCount: view.success + view.failed,
            ...(category ? { category } : {}),
            ...(summary ? { summary } : {}),
            ...(reuseAdjustVal !== undefined ? { reuseAdjust: reuseAdjustVal } : {}),
            ...(kautoMember ? { kautoMember: true } : {}),
            explorationEligible,
        });
    }
    // #110: merge hub reuse candidates into the same pool, trust-first — local (trusted) genes win on a
    // geneId collision, and a hub candidate banned by repeated signal-matched failures stays out too.
    if (opts.hubCandidates && opts.hubCandidates.length > 0) {
        const localIds = new Set(out.map((c) => c.geneId));
        const localAssetIds = new Set(out.map((c) => c.assetId).filter((id) => id !== undefined));
        for (const h of opts.hubCandidates) {
            if (isCompatibilityBlocked({ assetType: 'Gene', assetId: h.assetId ?? h.geneId, revision: String(h.hubAsset?.['revision'] ?? '') }, opts.compatibility))
                continue;
            if (!passesInjectedCandidateGates(h, opts, provenance, review))
                continue;
            if (!passesRequiredSignals(h.signalsMatch, sigSet))
                continue;
            if (localIds.has(h.geneId))
                continue; // a trusted local gene already covers this id
            if (h.assetId && localAssetIds.has(h.assetId))
                continue; // the same content identity is already local/trusted
            if (isBannedCandidate(banned, h.geneId, h.assetId))
                continue;
            // Stamp the reuse sentiment onto a hub candidate too (only when it didn't carry one), matched by its geneId
            // OR its asset_id — symmetric with local genes, so a map keyed like reuse events (often sha256:…) still hits
            // (#268 Bugbot). A hub candidate that exposes neither matching id is simply left unstamped.
            const hubSignalsMatch = matchSignals(h.signalsMatch);
            const hubAdj = h.reuseAdjust === undefined ? combinedReuseSentiment(opts.reuseCounts, h.geneId, h.assetId) : undefined;
            // A transient Hub candidate must never self-assert active-bandit cold-start eligibility. It still competes
            // under the existing base score and legacy drift; UCB1 fails safe for a mixed window.
            const guarded = { ...h, signalsMatch: hubSignalsMatch, explorationEligible: false };
            out.push(hubAdj !== undefined ? { ...guarded, reuseAdjust: hubAdj } : guarded);
            localIds.add(h.geneId);
            if (h.assetId)
                localAssetIds.add(h.assetId);
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
        const matchingTrigger = withoutTaskDomainSignals(trigger);
        // This is a safety inclusion gate: ubiquitous evidence must still emit warnings.
        const relevant = matchingTrigger.some((m) => sigSet.has(m))
            || tagOverlapScore(matchingSignals, { signalsMatch: matchingTrigger, geneId: antiGeneId, summary }) > 0;
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
    return { candidates: out, distilledFallback, semanticCorpus, antiWarnings };
}
/**
 * Assemble selection candidates from the store for the given signals (the relevant scored set only).
 * Thin wrapper over {@link assembleSelectionPool} kept for back-compat with callers that don't use the
 * distilled-gene fallback pool.
 */
export async function assembleCandidates(store, signals, opts = {}) {
    // This compatibility wrapper discards semanticCorpus, so preserve its legacy I/O bound instead of scanning
    // 1,000 records for data the caller cannot consume.
    return (await assembleSelectionPool(store, signals, { ...opts, includeSemanticCorpus: false })).candidates;
}