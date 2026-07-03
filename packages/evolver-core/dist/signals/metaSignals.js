// Meta-signal vocabulary (ported from v1 src/gep/signals.js analyzeRecentHistory + the meta-signal pass).
// These are HISTORY-DERIVED signals that drive STRATEGY ADAPTATION: when the evolution loop gets stuck
// (repair loops, empty cycles, saturation, failure streaks, high failure ratio) the loop emits signals that
// downstream strategy selection reacts to — e.g. evolution_saturation → steady-state, repair_loop_detected /
// high_failure_ratio → innovate. v2 had only restored plateau→drift (algo/exploration.ts); this restores the
// rest of the vocabulary so the loop can adapt to being stuck instead of spinning.
//
// RECONCILIATION (reuse, don't duplicate):
//  - PLATEAU: v1 also emitted plateau_pivot_required/_suggested here from recent outcome scores. v2 already
//    owns plateau detection in algo/exploration.ts (detectPlateau over the cycle-outcome stream, which then
//    forces drift in gene selection). We DO NOT re-derive plateau here; callers keep using exploration.ts.
//  - BAN_GENE: v1 emitted ban_gene:<topGene> on a long failure streak. v2 already owns gene banning in
//    algo/bans.ts (bannedGenesFromFailures, signal-overlap based) which drops failing genes from the
//    candidate set directly — a stronger mechanism than a soft signal. We DO NOT emit ban_gene here; the
//    failure-streak meta-signals below are the strategy-posture half, bans.ts is the candidate-exclusion half.
//
// Pure + deterministic: input is a normalized cycle-history view; no clock / fs / env reads.
const RECENT_WINDOW = 10; // v1: last 10 events
const FREQ_WINDOW = 8; // v1: gene/failure frequency over the last 8
/** Is a record an empty cycle (no real change)? Mirrors v1: meta.empty_cycle || (files===0 && lines===0). */
function isEmptyCycle(r) {
    if (r.emptyCycle)
        return true;
    const br = r.blastRadius;
    return !!br && (br.files ?? -1) === 0 && (br.lines ?? -1) === 0;
}
function isFailed(r) {
    return r.outcome?.status === 'failed';
}
/**
 * Derive the v1 history counters from a normalized cycle-record window (newest LAST), mirroring v1
 * analyzeRecentHistory. Pure + deterministic. Use {@link cycleRecordsFromEvents} to adapt the v2 event log.
 */
export function deriveCycleHistory(records) {
    const empty = {
        consecutiveRepairCount: 0,
        emptyCycleCount: 0,
        consecutiveEmptyCycles: 0,
        consecutiveFailureCount: 0,
        recentFailureRatio: 0,
        geneFreq: {},
    };
    if (!Array.isArray(records) || records.length === 0)
        return empty;
    const recent = records.slice(-RECENT_WINDOW);
    const tail = recent.slice(-FREQ_WINDOW);
    // Consecutive repair-intent cycles at the tail.
    let consecutiveRepairCount = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i].intent === 'repair')
            consecutiveRepairCount++;
        else
            break;
    }
    // Empty cycles within the frequency window + gene frequency.
    let emptyCycleCount = 0;
    const geneFreq = {};
    for (const r of tail) {
        if (isEmptyCycle(r))
            emptyCycleCount++;
        for (const g of r.genesUsed ?? [])
            geneFreq[String(g)] = (geneFreq[String(g)] ?? 0) + 1;
    }
    // Consecutive empty cycles at the tail (saturation).
    let consecutiveEmptyCycles = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        if (isEmptyCycle(recent[i]))
            consecutiveEmptyCycles++;
        else
            break;
    }
    // Consecutive failures at the tail. Empty cycles are zero-blast no-ops in v1's history model: even when the
    // terminal status is failed, they break the failure streak instead of extending it.
    let consecutiveFailureCount = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        if (isEmptyCycle(recent[i]))
            break;
        if (isFailed(recent[i]))
            consecutiveFailureCount++;
        else
            break;
    }
    // Failure ratio over the frequency window, excluding empty cycles from both numerator and denominator.
    let recentFailureCount = 0;
    let nonEmptyCycleCount = 0;
    for (const r of tail) {
        if (isEmptyCycle(r))
            continue;
        nonEmptyCycleCount++;
        if (isFailed(r))
            recentFailureCount++;
    }
    return {
        consecutiveRepairCount,
        emptyCycleCount,
        consecutiveEmptyCycles,
        consecutiveFailureCount,
        recentFailureRatio: nonEmptyCycleCount > 0 ? recentFailureCount / nonEmptyCycleCount : 0,
        geneFreq,
    };
}
/**
 * Compute the history-derived meta-signal vocabulary from the loop's recent shape (ported v1 signals.js
 * ~555-655 for the signals NOT already owned by exploration/bans). The returned signals are MEANT to be
 * merged into the cycle's signal set so strategy selection (resolveStrategy) and signal expansion can react.
 *
 * Ports (thresholds faithful to v1):
 *  - consecutiveRepairCount >= 3  → repair_loop_detected + force_innovation_after_repair_loop
 *  - emptyCycleCount        >= 4  → empty_cycle_loop_detected
 *  - consecutiveEmptyCycles >= 5  → force_steady_state + evolution_saturation
 *  - consecutiveEmptyCycles >= 3  → evolution_saturation (+ explore_opportunity)
 *  - consecutiveFailureCount>= 3  → consecutive_failure_streak_<N>
 *  - consecutiveFailureCount>= 5  → failure_loop_detected   (ban_gene deferred to algo/bans.ts)
 *  - recentFailureRatio  >= 0.75  → high_failure_ratio + force_innovation_after_repair_loop
 *
 * Deferred (handled elsewhere, see RECONCILIATION above): plateau_pivot_* → algo/exploration.ts;
 * ban_gene:<top> → algo/bans.ts.
 */
export function computeMetaSignals(history) {
    const signals = [];
    // Repair loop: 3+ consecutive repair-intent cycles → push to innovate to break the loop.
    if (history.consecutiveRepairCount >= 3) {
        signals.push('repair_loop_detected');
        signals.push('force_innovation_after_repair_loop');
    }
    // Empty-cycle loop: many zero-change cycles in the window → the loop is spinning without effect.
    if (history.emptyCycleCount >= 4) {
        signals.push('empty_cycle_loop_detected');
    }
    // Saturation (graceful degradation): consecutive empty cycles → steady-state / saturation posture.
    if (history.consecutiveEmptyCycles >= 5) {
        signals.push('force_steady_state');
        signals.push('evolution_saturation');
    }
    else if (history.consecutiveEmptyCycles >= 3) {
        signals.push('evolution_saturation');
    }
    // Exploration opportunity: when saturated, nudge proactive exploration rather than idling.
    if (history.consecutiveEmptyCycles >= 3) {
        signals.push('explore_opportunity');
    }
    // Failure streak awareness: tell the loop "you have failed N times in a row — slow down".
    if (history.consecutiveFailureCount >= 3) {
        signals.push('consecutive_failure_streak_' + history.consecutiveFailureCount);
        if (history.consecutiveFailureCount >= 5) {
            signals.push('failure_loop_detected');
            // NB: v1 also pushed ban_gene:<topGene> here. v2 defers gene banning to algo/bans.ts
            // (bannedGenesFromFailures), which excludes the failing gene from the candidate set directly.
        }
    }
    // High failure ratio in the recent window → break out by innovating.
    if (history.recentFailureRatio >= 0.75) {
        signals.push('high_failure_ratio');
        signals.push('force_innovation_after_repair_loop');
    }
    // De-dup while preserving first-seen order.
    return [...new Set(signals)];
}