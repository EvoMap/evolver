import { StrategyPoint } from '../strategy/strategyPoint.js';
import { geneHealthScore, HEALTH_WEIGHTS_VERSION } from './geneHealth.js';
import { tagOverlapScore, bagCosine } from '../signals/expand.js';
import { driftSelect } from './exploration.js';
import { isDistilledGeneId } from './geneIntake.js';
function decisionWithWarnings(input, decision) {
    return input.antiWarnings && input.antiWarnings.length > 0
        ? { ...decision, antiWarnings: [...input.antiWarnings] }
        : decision;
}
function signalMatchScore(signals, match) {
    if (signals.length === 0 || match.length === 0)
        return 0;
    const set = new Set(signals);
    const hit = match.filter((m) => set.has(m)).length;
    return hit / match.length; // 覆盖率
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
/**
 * Version of the full engine-health weight vector (health 0.6 + signal-match 0.4 − epigenetic penalty
 * + CONFIDENCE_WEIGHT × confidence + REUSE_WEIGHT × reuse-sentiment). Bumped whenever a factor is added so golden
 * weight snapshots track the change. Composed from the health-weights version so a change to either layer shows.
 */
export const SELECTION_WEIGHTS_VERSION = `sel-3(${HEALTH_WEIGHTS_VERSION},conf=${CONFIDENCE_WEIGHT},reuse=${REUSE_WEIGHT})`;
/**
 * Match score with semantic signal expansion (ported from v1): literal coverage first, then fill the
 * recall gap with semantic tag overlap, then with bag-of-words cosine similarity. A perfect literal match
 * short-circuits to 1; otherwise tag overlap adds partial credit (so a '429' signal can reach a gene tagged
 * for 'repair'), and cosine catches lexical similarity the curated tags miss (e.g. a 'timeout_slow' signal
 * vs a gene summarized "fix the slow timeout"). Each layer only fills the gap the previous one left.
 */
function expandedMatchScore(signals, c) {
    const literal = signalMatchScore(signals, c.signalsMatch);
    if (literal >= 1)
        return { score: 1, literal, tag: 0, cos: 0 };
    const tag = tagOverlapScore(signals, { signalsMatch: c.signalsMatch, geneId: c.geneId, category: c.category, summary: c.summary });
    const base = Math.min(1, literal + (1 - literal) * tag);
    if (base >= 1)
        return { score: 1, literal, tag, cos: 0 };
    const geneText = [...c.signalsMatch, c.category ?? '', c.summary ?? ''].join(' ');
    const cos = bagCosine(signals.join(' '), geneText);
    return { score: Math.min(1, base + (1 - base) * cos * SEMANTIC_WEIGHT), literal, tag, cos };
}
/** Score one candidate under the engine-health weight vector (health 0.6 + 信号匹配 0.4 − epigenetic + confidence). */
function scoreCandidate(signals, c) {
    const health = geneHealthScore(c.view, { reuseCount: c.reuseCount, antiPatternCount: c.antiPatternCount });
    const m = expandedMatchScore(signals, c);
    const epi = c.epigeneticPenalty ?? 0;
    // Confidence is the fourth (positive) factor: a [0,1] preferred-gene edge for this signal fingerprint.
    // Clamped defensively so an upstream bug cannot turn the soft nudge into a dominant term.
    const conf = Math.max(0, Math.min(1, c.confidence ?? 0));
    // Cross-runtime reuse sentiment (#268 phase 1): clamped to [-1,1] so an upstream bug cannot turn the soft nudge
    // into a dominant (or unbounded) term. Absent → 0 → no effect (default-off until a caller injects it).
    const reuse = Math.max(-1, Math.min(1, c.reuseAdjust ?? 0));
    const score = 0.6 * health.score + 0.4 * m.score - epi + CONFIDENCE_WEIGHT * conf + REUSE_WEIGHT * reuse;
    const breakdown = m.tag > 0 || m.cos > 0 ? `(literal=${m.literal.toFixed(2)}+tag=${m.tag.toFixed(2)}+cos=${m.cos.toFixed(2)})` : '';
    const reasons = [`health=${health.score.toFixed(3)}(succ=${health.successRate.toFixed(2)},reuse=${health.reuseCount})`, `信号匹配=${m.score.toFixed(2)}${breakdown}`];
    if (epi > 0)
        reasons.push(`epigenetic 环境抑制 -${epi.toFixed(2)}`);
    if (conf > 0)
        reasons.push(`preferred-gene confidence +${(CONFIDENCE_WEIGHT * conf).toFixed(3)} (conf=${conf.toFixed(2)})`);
    if (reuse !== 0)
        reasons.push(`cross-runtime reuse ${reuse >= 0 ? '+' : ''}${(REUSE_WEIGHT * reuse).toFixed(3)} (sentiment=${reuse.toFixed(2)})`);
    return { geneId: c.geneId, ...(c.assetId ? { assetId: c.assetId } : {}), score, health, reasons };
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
    if (!isDistilledGeneId(fallback.geneId)) {
        forcedFallback.reasons.push('forced gene rejected: suppressed fallback');
        return { scoredForChoice: scoredCandidatesOnly, forceRejected: true };
    }
    forcedFallback.reasons.push(`forced gene selected: explicit forcedGeneId matched assembled distilled fallback (${forcedGeneId})`);
    if (floor !== undefined && forcedFallback.score <= floor)
        forcedFallback.reasons.push(`forced gene selected despite floor ${floor}`);
    return { selectedGeneId: fallback.geneId, ...(fallback.assetId ? { selectedAssetId: fallback.assetId } : {}), scoredForChoice: scoredCandidatesOnly };
}
/** 实现1: engine 健康分主导(health 0.6 + 信号匹配 0.4). */
export const engineHealthSelection = {
    name: 'engine-health',
    version: '1',
    run(input, ctx) {
        const scored = input.candidates.map((c) => scoreCandidate(input.signals, c)).sort((a, b) => b.score - a.score);
        const floor = input.floor ?? 0;
        const forced = forcedSelection(input, scored, (c) => scoreCandidate(input.signals, c), floor);
        const eligible = forced.scoredForChoice.filter((s) => s.score > floor);
        // Deterministic top by default; exploration drift picks from the top-N to escape local optima.
        const drift = driftSelect(eligible.length, input.exploration, ctx?.rng ?? Math.random);
        const chosen = eligible[drift.index] ?? eligible[0];
        let selectedGeneId = forced.selectedGeneId ?? (chosen ? chosen.geneId : null);
        let selectedAssetId = forced.selectedAssetId ?? chosen?.assetId;
        if (!selectedGeneId) {
            // Issue #97 (ported from v1 selector.js): no candidate matched any live signal (every gene scored <= 0). Rather
            // than fall straight through to a blind innovate, reuse a *distilled* gene if one is available. NB the prefix
            // does NOT mean "skill-derived" in v2 the way it did in v1: v1 tagged only skill genes gene_distilled_ (auto-
            // evolved genes were gene_auto_), but v2's intakeGene tags EVERY intaken gene gene_distilled_ (autoExec even
            // intakes task strategies that way) and has no gene_auto_. So this pool is "any trusted/approved/non-suppressed
            // pooled gene that does not match", not specifically skill-derived — the safety rests on the upstream gates
            // (trust #30 / review #89-91 / signal-ban / inert-ban #195) plus the epigenetic skip below, not on a skill-
            // provenance low-blast-radius assumption. We skip any distilled fallback epigenetically suppressed in this env;
            // v2's event-log-derived epigeneticPenalty is the analog of v1's asset-mark hard suppression (related band, not
            // the identical predicate). No usable distilled fallback → stay null so the caller still innovates (the contract).
            //
            // v1 #97 parity: the distilled fallback is a *no-signal-match* last resort — it must fire only when NOTHING
            // scored above zero, NOT merely when nothing cleared a positive `floor`. Otherwise a real but weak signal match
            // (0 < score <= floor) would be preempted by an unrelated zero-evidence distilled gene; V1 (which has no floor)
            // keeps such a match. When candidates scored > 0 but below floor, defer to V2's floor policy (innovate).
            const noSignalMatch = !forced.forceRejected && forced.scoredForChoice.every((s) => s.score <= 0);
            const fb = noSignalMatch
                ? (input.distilledFallback ?? []).find((c) => isDistilledGeneId(c.geneId) && (c.epigeneticPenalty ?? 0) === 0)
                : undefined;
            if (fb) {
                const fbScored = scoreCandidate(input.signals, fb);
                fbScored.reasons.push('distilled_fallback(#97): 无信号匹配, 低置信度复用蒸馏 gene');
                scored.push(fbScored);
                selectedGeneId = fb.geneId;
                selectedAssetId = fb.assetId;
            }
            else {
                forced.scoredForChoice.forEach((s) => s.reasons.push(`< floor ${floor} → innovate`));
            }
        }
        else if (forced.selectedGeneId === undefined && drift.driftMode !== 'deterministic') {
            scored.find((s) => s.geneId === selectedGeneId)?.reasons.push(`drift(${drift.driftMode},intensity=${drift.intensity.toFixed(2)})`);
        }
        return decisionWithWarnings(input, { selectedGeneId, ...(selectedAssetId ? { selectedAssetId } : {}), candidates: scored, weightsVersion: SELECTION_WEIGHTS_VERSION, strategyName: 'engine-health' });
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
            const forced = input.forcedGeneId ? base.find((s) => s.reasons.some((r) => r.includes('forced gene'))) : undefined;
            if (forced?.reasons.some((r) => r.includes('forced gene selected'))) {
                return decisionWithWarnings(input, { selectedGeneId: forced.geneId, ...(forced.assetId ? { selectedAssetId: forced.assetId } : {}), candidates: base, weightsVersion: SELECTION_WEIGHTS_VERSION, strategyName: 'agent-led' });
            }
            const candidatesForPick = forced?.reasons.some((r) => r.includes('forced gene rejected')) ? base.filter((s) => !matchesScoredIdentity(s, forced)) : base;
            const choice = pick(candidatesForPick, input);
            const selected = candidatesForPick.find((s) => s.geneId === choice) ?? base.find((s) => s.geneId === choice);
            return decisionWithWarnings(input, { selectedGeneId: choice, ...(selected?.assetId ? { selectedAssetId: selected.assetId } : {}), candidates: base, weightsVersion: SELECTION_WEIGHTS_VERSION, strategyName: 'agent-led' });
        },
    };
}
/** 选 gene StrategyPoint: 默认 engine-health, 备选 signal-match(+ 可注册 agent-led). */
export function makeGeneSelectionPoint() {
    return new StrategyPoint('gene-selection', engineHealthSelection).register(signalMatchSelection);
}