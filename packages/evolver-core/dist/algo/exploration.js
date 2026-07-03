// Exploration layer (ported from v1 src/gep/selector.js): adaptive drift intensity + plateau override
// to escape local optima. v2 selection is deterministic by default (always the top score); drift stays
// OFF unless the caller passes SelectionInput.exploration (typically when a plateau is detected upstream).
// When active, the strategy occasionally picks from the top-N candidates instead of the single top —
// random exploration to break a stuck pool. Randomness is injected (ctx.rng) for deterministic tests.
const MATURITY_ATTEMPTS_PER_GENE = 10;
const DRIFT_OFFSET_MAX = 0.3;
const DRIFT_OFFSET_MIN = 0.02;
const PLATEAU_SUGGEST = 5;
const PLATEAU_FORCE = 10;
/**
 * Adaptive drift intensity (ported v1): 1/sqrt(Ne) + an offset that decays from 0.3 → 0.02 as the pool
 * matures (totalAttempts approaches Ne * 10). Tiny pools (Ne <= 1) get a fixed high 0.7 to force exploration.
 */
export function computeDriftIntensity(ne, totalAttempts = 0) {
    if (!Number.isFinite(ne) || ne <= 1)
        return 0.7;
    const maturityThreshold = ne * MATURITY_ATTEMPTS_PER_GENE;
    const maturity = maturityThreshold > 0 ? Math.min(1, totalAttempts / maturityThreshold) : 0;
    const offset = DRIFT_OFFSET_MAX - (DRIFT_OFFSET_MAX - DRIFT_OFFSET_MIN) * maturity;
    return Math.min(1, 1 / Math.sqrt(ne) + offset);
}
/** Detect a plateau from recent cycle outcomes: count the trailing run of consecutive non-success. */
export function detectPlateau(recentOutcomes) {
    let count = 0;
    for (let i = recentOutcomes.length - 1; i >= 0; i--) {
        if (recentOutcomes[i] === 'success')
            break;
        count++;
    }
    if (count >= PLATEAU_FORCE)
        return { active: true, severity: 'required', count };
    if (count >= PLATEAU_SUGGEST)
        return { active: true, severity: 'suggested', count };
    return { active: false, severity: 'suggested', count };
}
/**
 * Pick which ranked candidate to take among `eligibleCount` above-floor candidates.
 * No exploration → deterministic top (index 0). With exploration → compute intensity (an active plateau
 * forces it to 0.7/1.0); with probability = intensity, pick a random candidate from the top-N (N grows
 * with intensity). rng() is called at most twice; pass a seeded rng for deterministic tests.
 */
export function driftSelect(eligibleCount, exp, rng) {
    if (!exp || (!exp.driftEnabled && !exp.plateau?.active) || eligibleCount <= 1) {
        return { driftMode: 'deterministic', index: 0, intensity: 0 };
    }
    let intensity = computeDriftIntensity(eligibleCount, exp.totalAttempts ?? 0);
    if (exp.plateau?.active)
        intensity = Math.max(intensity, exp.plateau.severity === 'required' ? 1.0 : 0.7);
    if (rng() >= intensity)
        return { driftMode: 'deterministic', index: 0, intensity };
    const topN = Math.min(eligibleCount, Math.max(2, Math.ceil(eligibleCount * intensity)));
    const index = Math.min(topN - 1, Math.max(0, Math.floor(rng() * topN)));
    return { driftMode: exp.plateau?.active ? 'plateau_drift' : 'drift', index, intensity };
}