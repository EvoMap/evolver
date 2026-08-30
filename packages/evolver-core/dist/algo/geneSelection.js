import { StrategyPoint } from '../strategy/strategyPoint.js';
import { geneHealthScore, HEALTH_WEIGHTS_VERSION } from './geneHealth.js';
import { bagCosine, buildSemanticIdfProfile, geneTags, idfBagCosine, idfTagOverlapScore, tagOverlapScore, } from '../signals/expand.js';
import { driftSelect, explorationWindowSize } from './exploration.js';
import { isDistilledGeneId } from './geneIntake.js';
import { chooseUcb1Arm, ucb1StatsForCandidate, UCB1_REWARD_POLICY_VERSION, UCB1_SELECTION_POLICY_VERSION, } from './ucb1.js';
import { resolveTaskDomainSignals, withoutTaskDomainSignals, } from '../signals/taskDomain.js';
export const SELECTION_GUARD_VERSION = 'relevance-guard-v1';
function decisionWithWarnings(input, decision) {
    const selected = decision.selectedGeneId
        ? decision.candidates.find((candidate) => (candidate.geneId === decision.selectedGeneId
            || (decision.selectedAssetId !== undefined && candidate.assetId === decision.selectedAssetId)))
        : undefined;
    const enriched = {
        ...decision,
        ...(selected ? { selectedReason: selected.reasons.join('; ') } : {}),
        ...(input.memoryEvidence && input.memoryEvidence.length > 0 ? { memoryEvidence: [...input.memoryEvidence] } : {}),
    };
    return input.antiWarnings && input.antiWarnings.length > 0
        ? { ...enriched, antiWarnings: [...input.antiWarnings] }
        : enriched;
}
function signalMatchScore(signals, match) {
    const genericSignals = withoutTaskDomainSignals(signals);
    const genericMatch = withoutTaskDomainSignals(match);
    if (genericSignals.length === 0 || genericMatch.length === 0)
        return 0;
    const set = new Set(genericSignals);
    const hit = genericMatch.filter((m) => set.has(m)).length;
    return hit / genericMatch.length; // 覆盖率
}
// Weight of the bag-of-words cosine path when it fills the recall gap left by literal + tag overlap.
const SEMANTIC_WEIGHT = 0.5;
/**
 * Weight of the preferred-gene confidence factor (fourth factor, positive cross-cycle learning). Kept small so
 * it only re-orders near-ties between already-eligible candidates rather than overriding health / signal match.
 */
export const CONFIDENCE_WEIGHT = 0.15;
/**
 * Weight of the cross-runtime reuse-sentiment factor (#268 phase 1). Deliberately SMALLER than CONFIDENCE_WEIGHT:
 * a self-reported reuse outcome is weaker evidence than the confidence sidecar (which is built from verified cycle
 * history), so it only re-orders near-ties. Clamped to a [-1,1] sentiment, so its contribution is bounded to
 * ±REUSE_WEIGHT and can never dominate health/signal-match.
 */
export const REUSE_WEIGHT = 0.1;
/** Weight of scoped local MemoryGraph outcome evidence. */
export const MEMORY_GRAPH_WEIGHT = 0.12;
/** Bounded weight for a canonical task-domain signal match (#628). */
export const TASK_DOMAIN_WEIGHT = 0.08;
/** signals_match is weak domain evidence; its maximum score contribution is 0.08 * 0.5 = 0.04. */
export const TASK_DOMAIN_SIGNAL_EVIDENCE = 0.5;
/**
 * Soft boost for strict K_auto members. Smaller than CONFIDENCE_WEIGHT: membership is a writer-side property,
 * not verified cycle history, so it only breaks near-ties between already-eligible candidates.
 */
export const KAUTO_WEIGHT = 0.05;
/** λ is intentionally NOT inlined into SELECTION_WEIGHTS_VERSION text:
 *  decision.gene_selected root events already sit within ~2B of the 4096B line budget
 *  under UCB1/plateau fixtures; a `,kauto=0.05` suffix drops selectionPolicy. */
const SELECTION_GUARD_MATCH_EPS = 1e-6;
/**
 * Version of the full engine-health weight vector (health 0.6 + signal-match 0.4 − epigenetic penalty
 * + CONFIDENCE_WEIGHT × confidence + REUSE_WEIGHT × reuse-sentiment + KAUTO_WEIGHT × kauto-member).
 * Bumped whenever a factor is added so golden weight snapshots track the change. Composed from the
 * health-weights version so a change to either layer shows.
 */
export const LEGACY_SELECTION_WEIGHTS_VERSION = `sel-6-domain(${HEALTH_WEIGHTS_VERSION},conf=${CONFIDENCE_WEIGHT},memory=${MEMORY_GRAPH_WEIGHT},reuse=${REUSE_WEIGHT},domain=${TASK_DOMAIN_WEIGHT})`;
export const SELECTION_WEIGHTS_VERSION = `sel-7-idf-domain(${HEALTH_WEIGHTS_VERSION},conf=${CONFIDENCE_WEIGHT},memory=${MEMORY_GRAPH_WEIGHT},reuse=${REUSE_WEIGHT},domain=${TASK_DOMAIN_WEIGHT})`;
const SEMANTIC_CORPUS_LIMIT = 1_000;
const SEMANTIC_SIGNAL_LIMIT = 16;
const SEMANTIC_SIGNAL_CHARS = 96;
const SEMANTIC_GENE_ID_CHARS = 128;
const SEMANTIC_CATEGORY_CHARS = 96;
const SEMANTIC_SUMMARY_CHARS = 1_024;
const SEMANTIC_IDENTITY_CHARS = 256;
function legacyCandidateSemanticText(candidate) {
    return [
        ...withoutTaskDomainSignals(candidate.signalsMatch),
        candidate.category ?? '',
        candidate.summary ?? '',
    ].join(' ');
}
function boundedSignals(signals) {
    const out = [];
    const genericSignals = withoutTaskDomainSignals(signals);
    const limit = Math.min(genericSignals.length, SEMANTIC_SIGNAL_LIMIT);
    for (let index = 0; index < limit; index += 1) {
        const signal = genericSignals[index];
        if (typeof signal === 'string')
            out.push(signal.slice(0, SEMANTIC_SIGNAL_CHARS));
    }
    return out;
}
function semanticCandidateProjection(candidate) {
    const signalsMatch = boundedSignals(candidate.signalsMatch);
    const geneId = candidate.geneId.slice(0, SEMANTIC_GENE_ID_CHARS);
    const category = candidate.category?.slice(0, SEMANTIC_CATEGORY_CHARS);
    const summary = candidate.summary?.slice(0, SEMANTIC_SUMMARY_CHARS);
    return {
        tagInput: {
            signalsMatch,
            geneId,
            ...(category ? { category } : {}),
            ...(summary ? { summary } : {}),
        },
        text: [...signalsMatch, category ?? '', summary ?? ''].join(' '),
        hasContent: signalsMatch.some((signal) => signal.trim().length > 0)
            || Boolean(category?.trim())
            || Boolean(summary?.trim()),
    };
}
function buildSelectionSemanticProfile(corpus) {
    const documents = [];
    const identities = new Set();
    for (const candidate of corpus) {
        if (documents.length >= SEMANTIC_CORPUS_LIMIT)
            break;
        const identityValue = candidate.assetId ?? candidate.geneId;
        const identity = `${candidate.assetId ? 'asset' : 'gene'}:${identityValue.slice(0, SEMANTIC_IDENTITY_CHARS)}`;
        if (identities.has(identity))
            continue;
        identities.add(identity);
        const projection = semanticCandidateProjection(candidate);
        if (!projection.hasContent)
            continue;
        documents.push({ tags: geneTags(projection.tagInput), text: projection.text });
    }
    return buildSemanticIdfProfile(documents);
}
/**
 * Match score with semantic signal expansion (ported from v1): literal coverage first, then fill the
 * recall gap with semantic tag overlap, then with bag-of-words cosine similarity. A perfect literal match
 * short-circuits to 1; otherwise tag overlap adds partial credit (so a '429' signal can reach a gene tagged
 * for 'repair'), and cosine catches lexical similarity the curated tags miss (e.g. a 'timeout_slow' signal
 * vs a gene summarized "fix the slow timeout"). Each layer only fills the gap the previous one left.
 */
function expandedMatchScore(signals, c, semanticProfile) {
    const literal = signalMatchScore(signals, c.signalsMatch);
    if (literal >= 1)
        return { score: 1, literal, tag: 0, cos: 0 };
    const projection = semanticProfile ? semanticCandidateProjection(c) : undefined;
    const semanticSignals = semanticProfile ? boundedSignals(signals) : withoutTaskDomainSignals(signals);
    const tag = semanticProfile
        ? idfTagOverlapScore(semanticSignals, projection.tagInput, semanticProfile)
        : tagOverlapScore(semanticSignals, {
            signalsMatch: withoutTaskDomainSignals(c.signalsMatch),
            geneId: c.geneId,
            category: c.category,
            summary: c.summary,
        });
    const base = Math.min(1, literal + (1 - literal) * tag);
    if (base >= 1)
        return { score: 1, literal, tag, cos: 0 };
    const cos = semanticProfile
        ? idfBagCosine(semanticSignals.join(' '), projection.text, semanticProfile)
        : bagCosine(semanticSignals.join(' '), legacyCandidateSemanticText(c));
    return { score: Math.min(1, base + (1 - base) * cos * SEMANTIC_WEIGHT), literal, tag, cos };
}
function taskDomainEvidence(queryDomain, candidateSignals) {
    if (queryDomain.status !== 'resolved')
        return 0;
    const candidateDomain = resolveTaskDomainSignals(candidateSignals);
    return candidateDomain.status === 'resolved' && candidateDomain.slug === queryDomain.slug
        ? TASK_DOMAIN_SIGNAL_EVIDENCE
        : 0;
}
/**
 * Score one candidate under the engine-health weight vector, including bounded task-domain evidence.
 * `kautoWeight` defaults to production KAUTO_WEIGHT; ablation passes λ ∈ {0,0.01,0.05,0.1}.
 */
function scoreCandidate(signals, c, semanticProfile, queryDomain, kautoWeight = KAUTO_WEIGHT) {
    const health = geneHealthScore(c.view, { reuseCount: c.reuseCount, antiPatternCount: c.antiPatternCount });
    const m = expandedMatchScore(signals, c, semanticProfile);
    const epi = c.epigeneticPenalty ?? 0;
    // Confidence is the fourth (positive) factor: a [0,1] preferred-gene edge for this signal fingerprint.
    // Clamped defensively so an upstream bug cannot turn the soft nudge into a dominant term.
    const conf = Math.max(0, Math.min(1, c.confidence ?? 0));
    // Cross-runtime reuse sentiment (#268 phase 1): clamped to [-1,1] so an upstream bug cannot turn the soft nudge
    // into a dominant (or unbounded) term. Absent → 0 → no effect (default-off until a caller injects it).
    const reuse = Math.max(-1, Math.min(1, c.reuseAdjust ?? 0));
    const memory = Math.max(-1, Math.min(1, c.memoryBoost ?? 0));
    const domainEvidence = taskDomainEvidence(queryDomain, c.signalsMatch);
    const domainContribution = TASK_DOMAIN_WEIGHT * domainEvidence;
    // Soft K_auto membership preference: binary, already-admitted candidates only.
    const kauto = c.kautoMember === true ? 1 : 0;
    const kautoContribution = kautoWeight * kauto;
    // score_base is everything except the K_auto soft term — used by λ ablation.
    const scoreBase = 0.6 * health.score + 0.4 * m.score - epi + CONFIDENCE_WEIGHT * conf
        + MEMORY_GRAPH_WEIGHT * memory + REUSE_WEIGHT * reuse + domainContribution;
    const score = scoreBase + kautoContribution;
    const breakdown = m.tag > 0 || m.cos > 0 ? `(literal=${m.literal.toFixed(2)}+tag=${m.tag.toFixed(2)}+cos=${m.cos.toFixed(2)})` : '';
    const reasons = [`health=${health.score.toFixed(3)}(succ=${health.successRate.toFixed(2)},reuse=${health.reuseCount})`, `信号匹配=${m.score.toFixed(2)}${breakdown}`];
    if (epi > 0)
        reasons.push(`epigenetic 环境抑制 -${epi.toFixed(2)}`);
    if (conf > 0)
        reasons.push(`preferred-gene confidence +${(CONFIDENCE_WEIGHT * conf).toFixed(3)} (conf=${conf.toFixed(2)})`);
    if (memory !== 0)
        reasons.push(`scoped memory-graph outcome ${memory >= 0 ? '+' : ''}${(MEMORY_GRAPH_WEIGHT * memory).toFixed(3)} (boost=${memory.toFixed(2)})`);
    if (reuse !== 0)
        reasons.push(`cross-runtime reuse ${reuse >= 0 ? '+' : ''}${(REUSE_WEIGHT * reuse).toFixed(3)} (sentiment=${reuse.toFixed(2)})`);
    if (domainContribution > 0)
        reasons.push(`task_domain match +${domainContribution.toFixed(3)} (evidence=${domainEvidence.toFixed(2)})`);
    if (kautoContribution > 0)
        reasons.push(`K_auto member +${kautoContribution.toFixed(3)}`);
    // Keep scoreBase/kautoContribution off ScoredCandidate so decision.gene_selected
    // root-event candidate payloads retain the pre-K_auto 4096B line budget.
    return {
        geneId: c.geneId,
        ...(c.assetId ? { assetId: c.assetId } : {}),
        score,
        matchScore: m.score,
        health,
        reasons,
    };
}
function candidateIdentity(c) {
    return c.assetId ? `asset:${c.assetId}` : `gene:${c.geneId}`;
}
/**
 * Offline λ ablation over an already-admitted candidate pool.
 * Does not run hard gates / force / distilled fallback — those stay outside the soft preference.
 * Pure ranking sensitivity for score_T2 = score_base + λ · 1[k_a ∈ K_auto].
 */
export function ablateKautoLambda(input, lambdas = [0, 0.01, 0.05, 0.1], opts = {}) {
    const topK = opts.topK ?? 3;
    const floor = opts.floor ?? 0;
    const semanticProfile = input.disableSemanticIdf || input.semanticCorpus === undefined
        ? undefined
        : buildSelectionSemanticProfile(input.semanticCorpus);
    const queryDomain = resolveTaskDomainSignals(input.signals);
    const pools = lambdas.map((lambda) => {
        const scored = input.candidates
            .map((c) => {
            const s = scoreCandidate(input.signals, c, semanticProfile, queryDomain, lambda);
            const kautoContribution = (c.kautoMember === true ? 1 : 0) * lambda;
            return {
                geneId: s.geneId,
                ...(s.assetId ? { assetId: s.assetId } : {}),
                score: s.score,
                scoreBase: s.score - kautoContribution,
                kautoContribution,
                kautoMember: c.kautoMember === true,
            };
        })
            .sort((a, b) => b.score - a.score || (a.assetId ?? a.geneId).localeCompare(b.assetId ?? b.geneId));
        const eligible = scored.filter((s) => s.score > floor);
        const chosen = eligible[0];
        const bases = scored.map((s) => s.scoreBase);
        const scoreBaseMin = bases.length ? Math.min(...bases) : 0;
        const scoreBaseMax = bases.length ? Math.max(...bases) : 0;
        const scoreBaseMean = bases.length ? bases.reduce((a, b) => a + b, 0) / bases.length : 0;
        return {
            lambda,
            ranking: scored.map((s, index) => ({
                rank: index + 1,
                geneId: s.geneId,
                ...(s.assetId ? { assetId: s.assetId } : {}),
                score: s.score,
                scoreBase: s.scoreBase,
                kautoContribution: s.kautoContribution,
                kautoMember: s.kautoMember,
            })),
            selectedGeneId: chosen?.geneId ?? null,
            ...(chosen?.assetId ? { selectedAssetId: chosen.assetId } : {}),
            scoreBaseMin,
            scoreBaseMax,
            scoreBaseMean,
        };
    });
    const baseline = pools.find((p) => p.lambda === 0) ?? pools[0];
    const baselineRank = new Map(baseline?.ranking.map((r) => [candidateIdentity(r), r.rank]) ?? []);
    const baselineTopK = new Set((baseline?.ranking.slice(0, topK) ?? []).map((r) => candidateIdentity(r)));
    const baselineSelected = baseline
        ? candidateIdentity({
            geneId: baseline.selectedGeneId ?? '',
            ...(baseline.selectedAssetId ? { assetId: baseline.selectedAssetId } : {}),
        })
        : '';
    const rankChangesByLambda = {};
    const selectedChangesByLambda = {};
    const topKChangesByLambda = {};
    for (const pool of pools) {
        const key = String(pool.lambda);
        let rankChanges = 0;
        for (const row of pool.ranking) {
            const id = candidateIdentity(row);
            if ((baselineRank.get(id) ?? -1) !== row.rank)
                rankChanges += 1;
        }
        rankChangesByLambda[key] = rankChanges;
        const selectedId = candidateIdentity({
            geneId: pool.selectedGeneId ?? '',
            ...(pool.selectedAssetId ? { assetId: pool.selectedAssetId } : {}),
        });
        selectedChangesByLambda[key] = selectedId !== baselineSelected;
        const topSet = new Set(pool.ranking.slice(0, topK).map((r) => candidateIdentity(r)));
        let topDiff = 0;
        for (const id of topSet)
            if (!baselineTopK.has(id))
                topDiff += 1;
        for (const id of baselineTopK)
            if (!topSet.has(id))
                topDiff += 1;
        topKChangesByLambda[key] = topDiff;
    }
    return {
        lambdas,
        pools,
        rankChangesByLambda,
        selectedChangesByLambda,
        topKChangesByLambda,
        topK,
    };
}
function matchesForcedGeneId(c, forcedGeneId) {
    return c.geneId === forcedGeneId || c.assetId === forcedGeneId;
}
function matchesCandidateIdentity(s, c) {
    return c.assetId ? s.assetId === c.assetId : s.geneId === c.geneId;
}
function matchesScoredIdentity(a, b) {
    return b.assetId ? a.assetId === b.assetId : a.geneId === b.geneId;
}
function withoutCandidateIdentity(scored, c) {
    return scored.filter((s) => !matchesCandidateIdentity(s, c));
}
function candidateForScore(input, scored) {
    // Eligibility is attached to one assembled candidate, not to every logical alias of the same content.
    // Match the exact scored row so an untrusted alias cannot borrow a trusted candidate's UCB1 admission bit.
    return input.candidates.find((candidate) => (candidate.geneId === scored.geneId && candidate.assetId === scored.assetId));
}
function compactMetric(value) {
    return Math.round(value * 1_000_000) / 1_000_000;
}
function compactChoice(choice) {
    return {
        ...choice,
        armId: choice.armId.slice(0, 160),
        meanReward: compactMetric(choice.meanReward),
        ...(choice.bonus !== null ? { bonus: compactMetric(choice.bonus) } : { bonus: null }),
        ...(choice.index !== null ? { index: compactMetric(choice.index) } : { index: null }),
    };
}
function isReusableGenerationSource(source) {
    return source === 'distilled' || source === 'evolved';
}
function isReusableFallbackCandidate(c) {
    if (c.generationSource !== undefined)
        return isReusableGenerationSource(c.generationSource);
    return isDistilledGeneId(c.geneId);
}
function forcedSelection(input, scored, scoreForcedFallback, floor) {
    const forcedGeneId = input.forcedGeneId?.trim();
    if (!forcedGeneId)
        return { scoredForChoice: scored };
    const source = input.candidates.find((c) => matchesForcedGeneId(c, forcedGeneId));
    if (source) {
        const forced = scored.find((s) => matchesCandidateIdentity(s, source));
        if (!forced)
            return { scoredForChoice: scored };
        if ((source.epigeneticPenalty ?? 0) > 0) {
            forced.reasons.push('forced gene rejected: epigenetic suppression');
            return { scoredForChoice: withoutCandidateIdentity(scored, source), forceRejected: true };
        }
        forced.reasons.push(`forced gene selected: explicit forcedGeneId matched assembled candidate (${forcedGeneId})`);
        if (floor !== undefined && forced.score <= floor)
            forced.reasons.push(`forced gene selected despite floor ${floor}`);
        return { selectedGeneId: source.geneId, ...(source.assetId ? { selectedAssetId: source.assetId } : {}), scoredForChoice: scored };
    }
    const fallback = (input.distilledFallback ?? []).find((c) => matchesForcedGeneId(c, forcedGeneId));
    if (!fallback)
        return { scoredForChoice: scored };
    const scoredCandidatesOnly = scored.slice();
    const forcedFallback = scoreForcedFallback(fallback);
    scored.push(forcedFallback);
    if ((fallback.epigeneticPenalty ?? 0) > 0) {
        forcedFallback.reasons.push('forced gene rejected: epigenetic suppression');
        return { scoredForChoice: scoredCandidatesOnly, forceRejected: true };
    }
    if (!isReusableFallbackCandidate(fallback)) {
        forcedFallback.reasons.push('forced gene rejected: suppressed fallback');
        return { scoredForChoice: scoredCandidatesOnly, forceRejected: true };
    }
    forcedFallback.reasons.push(`forced gene selected: explicit forcedGeneId matched assembled distilled fallback (${forcedGeneId})`);
    if (floor !== undefined && forcedFallback.score <= floor)
        forcedFallback.reasons.push(`forced gene selected despite floor ${floor}`);
    return { selectedGeneId: fallback.geneId, ...(fallback.assetId ? { selectedAssetId: fallback.assetId } : {}), scoredForChoice: scoredCandidatesOnly };
}
/** Refs #626: identify selections whose relevance is absent or cannot discriminate during a plateau. */
export function assessSelectionGuard(scored, plateauActive) {
    if (scored.length === 0) {
        return { wouldAbstain: true, reason: 'no_match', maxMatch: 0, matchSpread: 0 };
    }
    const matches = scored.map((candidate) => candidate.matchScore ?? 0);
    const maxMatch = Math.max(...matches);
    const minMatch = Math.min(...matches);
    const matchSpread = maxMatch - minMatch;
    const metrics = {
        maxMatch: compactMetric(maxMatch),
        matchSpread: compactMetric(matchSpread),
    };
    if (maxMatch <= SELECTION_GUARD_MATCH_EPS) {
        return { wouldAbstain: true, reason: 'no_match', ...metrics };
    }
    if (plateauActive && scored.length > 1 && matchSpread <= SELECTION_GUARD_MATCH_EPS) {
        return { wouldAbstain: true, reason: 'plateau_flat_match', ...metrics };
    }
    return { wouldAbstain: false, ...metrics };
}
/** 实现1: engine 健康分主导(health 0.6 + 信号匹配 0.4). */
export const engineHealthSelection = {
    name: 'engine-health',
    version: '1',
    run(input, ctx) {
        const semanticProfile = input.disableSemanticIdf || input.semanticCorpus === undefined
            ? undefined
            : buildSelectionSemanticProfile(input.semanticCorpus);
        const weightsVersion = semanticProfile ? SELECTION_WEIGHTS_VERSION : LEGACY_SELECTION_WEIGHTS_VERSION;
        const semanticMetadata = semanticProfile
            ? {
                semanticProfileVersion: semanticProfile.version,
                semanticDocumentCount: semanticProfile.documentCount,
            }
            : {};
        const queryDomain = resolveTaskDomainSignals(input.signals);
        const scoreForSelection = (candidate) => (scoreCandidate(input.signals, candidate, semanticProfile, queryDomain));
        const scored = input.candidates.map(scoreForSelection).sort((a, b) => b.score - a.score);
        const floor = input.floor ?? 0;
        const forced = forcedSelection(input, scored, scoreForSelection, floor);
        const eligible = forced.scoredForChoice.filter((s) => s.score > floor);
        const guardMode = input.selectionGuard ?? 'legacy';
        const plateauActive = input.exploration?.plateau?.active === true;
        let guardAssessment = assessSelectionGuard(eligible, plateauActive);
        if (eligible.length === 0) {
            const fullAssessment = assessSelectionGuard(forced.scoredForChoice, plateauActive);
            if (fullAssessment.reason !== 'no_match') {
                guardAssessment = {
                    wouldAbstain: false,
                    ...(fullAssessment.maxMatch !== undefined ? { maxMatch: fullAssessment.maxMatch } : {}),
                    ...(fullAssessment.matchSpread !== undefined ? { matchSpread: fullAssessment.matchSpread } : {}),
                };
            }
        }
        const policyEligible = guardMode === 'enforce' && guardAssessment.reason === 'no_match'
            ? []
            : eligible;
        // Deterministic top by default. Plateau exploration either preserves legacy random drift or, when explicitly
        // requested, evaluates UCB1 over the same adaptive top-N window. Forced selection always wins below.
        const requestedPolicy = input.exploration?.policy ?? 'engine-health';
        const ucb1Active = input.exploration?.plateau?.active === true;
        let drift = { driftMode: 'deterministic', index: 0, intensity: 0 };
        let chosen;
        let selectionPolicy;
        if (forced.selectedGeneId === undefined && ucb1Active && requestedPolicy !== 'engine-health') {
            // Canonicalize ties before slicing the UCB window. The legacy/default ranked list intentionally keeps its
            // stable input-order tie behavior; UCB1 must produce the same arm for any permutation of the same pool.
            const ucbRanked = [...policyEligible].sort((left, right) => {
                const leftScore = Number.isFinite(left.score) ? left.score : Number.NEGATIVE_INFINITY;
                const rightScore = Number.isFinite(right.score) ? right.score : Number.NEGATIVE_INFINITY;
                return rightScore !== leftScore
                    ? rightScore - leftScore
                    : (left.assetId ?? left.geneId).localeCompare(right.assetId ?? right.geneId);
            });
            const window = ucbRanked.slice(0, explorationWindowSize(ucbRanked.length, input.exploration));
            const logicalIdCounts = new Map();
            for (const scored of window) {
                logicalIdCounts.set(scored.geneId, (logicalIdCounts.get(scored.geneId) ?? 0) + 1);
            }
            const history = input.exploration?.ucb1History;
            const result = history
                ? chooseUcb1Arm(window.map((scored) => {
                    const candidate = candidateForScore(input, scored);
                    const armId = scored.assetId ?? scored.geneId;
                    return {
                        armId,
                        baseScore: scored.score,
                        explorationEligible: candidate?.explorationEligible === true,
                        stats: candidate
                            ? ucb1StatsForCandidate(history, candidate.geneId, candidate.assetId, (logicalIdCounts.get(candidate.geneId) ?? 0) === 1)
                            : { armId, pulls: 0, completedPulls: 0, rewardSum: 0, meanReward: 0 },
                    };
                }), history.totalPulls)
                : { choice: null, fallbackReason: 'missing_history' };
            const ucbChosen = result.choice
                ? window.find((candidate) => (candidate.assetId ?? candidate.geneId) === result.choice.armId)
                : undefined;
            if (requestedPolicy === 'ucb1' && ucbChosen) {
                chosen = ucbChosen;
                const choice = compactChoice(result.choice);
                chosen.reasons.push('ucb1(index=' + (choice.index ?? 'cold') + ',mean=' + choice.meanReward.toFixed(3) + ',pulls=' + choice.pulls + ')');
                selectionPolicy = {
                    requested: requestedPolicy,
                    effective: 'ucb1',
                    selectionPolicyVersion: UCB1_SELECTION_POLICY_VERSION,
                    rewardPolicyVersion: UCB1_REWARD_POLICY_VERSION,
                    arm: choice,
                };
            }
            else {
                drift = driftSelect(eligible.length, input.exploration, ctx?.rng ?? Math.random);
                chosen = eligible[drift.index] ?? eligible[0];
                selectionPolicy = {
                    requested: requestedPolicy,
                    effective: 'engine-health',
                    selectionPolicyVersion: UCB1_SELECTION_POLICY_VERSION,
                    rewardPolicyVersion: UCB1_REWARD_POLICY_VERSION,
                    ...(result.choice ? {
                        arm: compactChoice(result.choice),
                        shadowArmId: result.choice.armId.slice(0, 160),
                        shadowDisagrees: Boolean(chosen && (chosen.assetId ?? chosen.geneId) !== result.choice.armId),
                    } : {}),
                    ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
                };
            }
        }
        else {
            drift = driftSelect(eligible.length, input.exploration, ctx?.rng ?? Math.random);
            chosen = eligible[drift.index] ?? eligible[0];
        }
        const forcedSelected = forced.selectedGeneId !== undefined;
        const ucb1ResolvedPlateau = guardAssessment.reason === 'plateau_flat_match'
            && selectionPolicy?.effective === 'ucb1';
        const guardApplied = guardMode === 'enforce'
            && !forcedSelected
            && guardAssessment.wouldAbstain
            && !ucb1ResolvedPlateau;
        if (guardApplied) {
            chosen = undefined;
        }
        let selectedGeneId = forced.selectedGeneId ?? (chosen ? chosen.geneId : null);
        let selectedAssetId = forced.selectedAssetId ?? chosen?.assetId;
        let fallbackSelected = false;
        if (!selectedGeneId) {
            // Issue #97 (ported from v1 selector.js): no candidate matched any live signal (every gene scored <= 0). Rather
            // than fall straight through to a blind innovate, reuse a *distilled* (or evolved) gene if one is available.
            // The fallback pool is built by candidateAssembly, which now filters by generation_meta.source ∈ {distilled,
            // evolved} (V1 #302), falling back to the `gene_distilled_` id namespace for legacy genes. The id-prefix check
            // below is a defense-in-depth filter for callers that bypass candidateAssembly; the authoritative provenance
            // lives on generation_meta (see geneGenerationSource). The safety rests on the upstream gates (trust #30 /
            // review #89-91 / signal-ban / inert-ban #195) plus the epigenetic skip below, not on a skill-provenance
            // low-blast-radius assumption. We skip any distilled fallback epigenetically suppressed in this env; v2's
            // event-log-derived epigeneticPenalty is the analog of v1's asset-mark hard suppression (related band, not the
            // identical predicate). No usable distilled fallback → stay null so the caller still innovates (the contract).
            //
            // v1 #97 parity: the distilled fallback is a *no-signal-match* last resort — it must fire only when NOTHING
            // scored above zero, NOT merely when nothing cleared a positive `floor`. Otherwise a real but weak signal match
            // (0 < score <= floor) would be preempted by an unrelated zero-evidence distilled gene; V1 (which has no floor)
            // keeps such a match. When candidates scored > 0 but below floor, defer to V2's floor policy (innovate).
            const normalPoolHasMatch = forced.scoredForChoice.some((candidate) => (candidate.matchScore ?? 0) > SELECTION_GUARD_MATCH_EPS);
            const noSignalMatch = !forced.forceRejected
                && ((guardApplied && guardAssessment.reason === 'no_match' && !normalPoolHasMatch)
                    || forced.scoredForChoice.every((candidate) => candidate.score <= 0));
            const fallback = noSignalMatch
                ? (input.distilledFallback ?? [])
                    .filter((candidate) => isReusableFallbackCandidate(candidate) && (candidate.epigeneticPenalty ?? 0) === 0)
                    .map((candidate) => ({ candidate, scored: scoreForSelection(candidate) }))
                    .sort((left, right) => right.scored.score - left.scored.score || left.candidate.geneId.localeCompare(right.candidate.geneId))[0]
                : undefined;
            if (fallback) {
                const { candidate: fb, scored: fbScored } = fallback;
                fbScored.reasons.push('distilled_fallback(#97): 无信号匹配, 低置信度复用蒸馏 gene');
                scored.push(fbScored);
                selectedGeneId = fb.geneId;
                selectedAssetId = fb.assetId;
                fallbackSelected = true;
            }
            else if (!guardApplied) {
                forced.scoredForChoice.forEach((candidate) => candidate.reasons.push(`< floor ${floor} → innovate`));
            }
        }
        else if (forced.selectedGeneId === undefined && selectionPolicy?.effective !== 'ucb1' && drift.driftMode !== 'deterministic') {
            scored.find((s) => s.geneId === selectedGeneId)?.reasons.push(`drift(${drift.driftMode},intensity=${drift.intensity.toFixed(2)})`);
        }
        if (selectionPolicy?.requested === 'ucb1-shadow' && selectionPolicy.shadowArmId) {
            selectionPolicy.shadowDisagrees = (selectedAssetId ?? selectedGeneId) !== selectionPolicy.shadowArmId;
        }
        const selectionGuard = guardMode === 'legacy'
            ? undefined
            : {
                mode: guardMode,
                version: SELECTION_GUARD_VERSION,
                status: forcedSelected
                    ? 'forced'
                    : ucb1ResolvedPlateau
                        ? 'ucb1'
                        : fallbackSelected
                            ? 'fallback'
                            : guardApplied
                                ? 'innovate'
                                : guardAssessment.wouldAbstain
                                    ? 'shadow'
                                    : 'allowed',
                ...(guardAssessment.wouldAbstain && guardAssessment.reason ? { reason: guardAssessment.reason } : {}),
                ...(guardAssessment.maxMatch !== undefined ? { maxMatch: guardAssessment.maxMatch } : {}),
                ...(guardAssessment.matchSpread !== undefined ? { matchSpread: guardAssessment.matchSpread } : {}),
            };
        return decisionWithWarnings(input, {
            selectedGeneId,
            ...(selectedAssetId ? { selectedAssetId } : {}),
            candidates: scored,
            weightsVersion,
            ...semanticMetadata,
            strategyName: 'engine-health',
            ...(selectionPolicy ? { selectionPolicy } : {}),
            ...(selectionGuard ? { selectionGuard } : {}),
        });
    },
};
/** 实现2: 纯信号匹配采样(忽略 health, 对照基线 — 经验主义要可对比). */
export const signalMatchSelection = {
    name: 'signal-match',
    version: '1',
    run(input) {
        const scoreSignalCandidate = (c) => ({
            geneId: c.geneId, ...(c.assetId ? { assetId: c.assetId } : {}), score: signalMatchScore(input.signals, c.signalsMatch),
            reasons: [`纯信号匹配=${signalMatchScore(input.signals, c.signalsMatch).toFixed(2)}`],
        });
        const scored = input.candidates.map((c) => scoreSignalCandidate(c)).sort((a, b) => b.score - a.score);
        const forced = forcedSelection(input, scored, scoreSignalCandidate, input.floor ?? 0);
        const top = forced.scoredForChoice[0];
        const selectedGeneId = forced.selectedGeneId ?? (top && top.score > (input.floor ?? 0) ? top.geneId : null);
        const selectedAssetId = forced.selectedAssetId ?? (selectedGeneId === top?.geneId ? top.assetId : undefined);
        return decisionWithWarnings(input, {
            selectedGeneId,
            ...(selectedAssetId ? { selectedAssetId } : {}),
            candidates: scored, weightsVersion: 'none', strategyName: 'signal-match',
        });
    },
};
/** 实现3: agent 主导(注入决策回调; engine 只给候选+分, agent 拍板, D26 agent 一等公民). */
export function agentLedSelection(pick) {
    return {
        name: 'agent-led',
        version: '1',
        run(input, ctx) {
            const baseDecision = engineHealthSelection.run(input, ctx);
            const base = baseDecision.candidates;
            const decisionMetadata = {
                weightsVersion: baseDecision.weightsVersion,
                ...(baseDecision.semanticProfileVersion
                    ? { semanticProfileVersion: baseDecision.semanticProfileVersion }
                    : {}),
                ...(baseDecision.semanticDocumentCount !== undefined
                    ? { semanticDocumentCount: baseDecision.semanticDocumentCount }
                    : {}),
            };
            const forced = input.forcedGeneId ? base.find((s) => s.reasons.some((r) => r.includes('forced gene'))) : undefined;
            if (forced?.reasons.some((r) => r.includes('forced gene selected'))) {
                return decisionWithWarnings(input, {
                    selectedGeneId: forced.geneId,
                    ...(forced.assetId ? { selectedAssetId: forced.assetId } : {}),
                    candidates: base,
                    ...decisionMetadata,
                    strategyName: 'agent-led',
                });
            }
            const candidatesForPick = forced?.reasons.some((r) => r.includes('forced gene rejected')) ? base.filter((s) => !matchesScoredIdentity(s, forced)) : base;
            const choice = pick(candidatesForPick, input);
            const selected = candidatesForPick.find((s) => s.geneId === choice) ?? base.find((s) => s.geneId === choice);
            return decisionWithWarnings(input, {
                selectedGeneId: choice,
                ...(selected?.assetId ? { selectedAssetId: selected.assetId } : {}),
                candidates: base,
                ...decisionMetadata,
                strategyName: 'agent-led',
            });
        },
    };
}
/** 选 gene StrategyPoint: 默认 engine-health, 备选 signal-match(+ 可注册 agent-led). */
export function makeGeneSelectionPoint() {
    return new StrategyPoint('gene-selection', engineHealthSelection).register(signalMatchSelection);
}