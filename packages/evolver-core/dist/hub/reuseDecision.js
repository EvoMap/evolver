// Reuse-before-solve DECISION CORE (#110) — pure, hub-agnostic ranking. Ported from v1 hubSearch.js
// (scoreHubResult / pickBestMatch / getMinReuseScore). Given the local problem signals and the FREE
// metadata of hub search candidates, this ranks "which candidate is worth getting" and decides whether
// reusing one is better than solving fresh. It picks AT MOST ONE candidate to fetch.
//
// HARD BOUNDARY (acceptance criterion #110): the economic-ownership rule. This file ranks reuse QUALITY and
// outputs "which asset is worth getting" — it never models the economic dimension of getting it. The paid
// pull, the economic receipt, and the cache all live in the adapter. An acceptance test greps this file for
// the economic vocabulary and expects zero hits — so even the comments here avoid those words deliberately.
//
// Determinism: scoring is a pure function of the inputs. Recency uses an injected `now` (no Date.now here)
// so golden tests are reproducible.
import { tagOverlapScore } from '../signals/expand.js';
/** Default reuse threshold (ported from v1 DEFAULT_MIN_REUSE_SCORE). The adapter overrides via env. */
export const DEFAULT_MIN_REUSE_SCORE = 0.72;
/** Streak cap to prevent unbounded score inflation (ported from v1 MAX_STREAK_CAP). */
export const MAX_STREAK_CAP = 5;
/** Weight of the semantic-similarity bonus when the hub provided a vector similarity (ported from v1). */
export const SEMANTIC_SIMILARITY_BONUS = 0.3;
/** Weight of the signal-match multiplier: how much local↔candidate signal overlap shapes the rank. */
export const SIGNAL_MATCH_FLOOR = 0.5;
/** Recency half-life in days: a candidate that is HALF_LIFE_DAYS old keeps half its recency weight. */
export const RECENCY_HALF_LIFE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
function clampStreak(raw) {
    return Math.min(Math.max(Number.isFinite(raw) ? raw : 0, 1), MAX_STREAK_CAP);
}
/**
 * Base hub-quality score (ported faithfully from v1 scoreHubResult):
 *   quality = confidence × cappedStreak × (reputation/100)
 * Extended with the optional hub quality multipliers the v2 metadata can carry (gdi / successRate),
 * each gated so an absent field is neutral (×1), never a penalty.
 */
function qualityScore(m) {
    const confidence = Number.isFinite(Number(m.confidence)) ? Number(m.confidence) : 0;
    const streak = clampStreak(Number(m.successStreak));
    const reputation = Number.isFinite(Number(m.reputationScore)) ? Number(m.reputationScore) : 50;
    let q = confidence * streak * (reputation / 100);
    // Optional v2 hub quality metadata — multiply in only when present (absent = neutral).
    if (Number.isFinite(Number(m.gdiScore)))
        q *= Math.max(Number(m.gdiScore), 0);
    if (Number.isFinite(Number(m.successRate)))
        q *= Math.max(Number(m.successRate), 0);
    return q;
}
/**
 * Signal-match multiplier in [SIGNAL_MATCH_FLOOR..1]. Reuses signals/expand's three-layer matching
 * (tagOverlapScore) so a '429' local signal still matches a candidate tagged for 'repair'. A zero overlap
 * does not zero out the rank (the hub already recalled it as relevant) but discounts it to the floor.
 */
function signalMatchFactor(localSignals, m) {
    const overlap = tagOverlapScore(localSignals, {
        ...(m.signalsMatch ? { signalsMatch: m.signalsMatch } : {}),
        ...(m.category ? { category: m.category } : {}),
        ...(m.summary ? { summary: m.summary } : {}),
    });
    return SIGNAL_MATCH_FLOOR + (1 - SIGNAL_MATCH_FLOOR) * Math.min(Math.max(overlap, 0), 1);
}
/** Exponential time-decay recency multiplier in (0..1]. Absent updatedAt or now → neutral 1.0. */
function recencyFactor(m, now) {
    if (!Number.isFinite(Number(m.updatedAt)) || now === undefined)
        return 1;
    const ageMs = now - Number(m.updatedAt);
    if (ageMs <= 0)
        return 1;
    const ageDays = ageMs / MS_PER_DAY;
    return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}
/** Popularity prior: a gently saturating multiplier from reuseCount (absent → neutral 1.0). */
function reuseFactor(m) {
    const n = Number(m.reuseCount);
    if (!Number.isFinite(n) || n <= 0)
        return 1;
    // log1p saturates: 0→1.0, 9→~1.23, 99→~1.46 — popularity helps but never dominates quality.
    return 1 + Math.log1p(n) / 20;
}
/**
 * Rank free hub search candidates by reuse quality only. Deterministic given (signals, metadata, now).
 * Returns a new array sorted high→low score; ties are broken by assetId for stable golden output.
 */
export function scoreSearchResults(localSignals, hubMetadata, opts = {}) {
    const now = opts.now;
    const ranked = [];
    for (const m of hubMetadata) {
        if (!m || typeof m.assetId !== 'string' || m.assetId.length === 0)
            continue;
        const quality = qualityScore(m);
        const signalMatch = signalMatchFactor(localSignals, m);
        const recency = recencyFactor(m, now);
        const reuse = reuseFactor(m);
        const sim = Number.isFinite(Number(m.semanticSimilarity)) ? Math.max(Number(m.semanticSimilarity), 0) : 0;
        const semanticBonus = sim * SEMANTIC_SIMILARITY_BONUS;
        const raw = quality * signalMatch * recency * reuse + semanticBonus;
        ranked.push({
            assetId: m.assetId,
            score: Math.round(raw * 1000) / 1000,
            reasons: { quality, signalMatch, recency, semanticBonus, reuseFactor: reuse },
            metadata: m,
        });
    }
    ranked.sort((a, b) => (b.score - a.score) || (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
    return ranked;
}
/**
 * Decide whether to reuse (port of v1 pickBestMatch): among the ranked candidates, keep only eligible ones
 * (status promoted or unset), and pick the single highest scorer that clears the threshold. Below threshold
 * → solve-fresh. Picks AT MOST ONE — the adapter pays to fetch only this winner (or nothing).
 */
export function decideReuse(ranked, opts = {}) {
    const threshold = Number.isFinite(Number(opts.threshold)) && Number(opts.threshold) > 0
        ? Number(opts.threshold)
        : DEFAULT_MIN_REUSE_SCORE;
    // Eligibility: an explicit non-promoted status disqualifies (untrusted/quarantined never auto-reused).
    const eligible = ranked.filter((r) => {
        const status = r.metadata.status;
        return !status || status === 'promoted';
    });
    // Pick the max explicitly (don't rely on input order — robust to an unsorted `ranked`).
    let winner;
    for (const r of eligible)
        if (!winner || r.score > winner.score)
            winner = r;
    if (!winner || winner.score < threshold) {
        return { action: 'solve-fresh', threshold, considered: eligible.length };
    }
    return { action: 'fetch', candidate: winner, threshold, considered: eligible.length };
}