/** Counters describing the recent shape of the evolution loop, mirroring v1 analyzeRecentHistory. */
export interface CycleHistory {
    /** Trailing run of consecutive 'repair'-intent cycles at the tail. */
    consecutiveRepairCount: number;
    /** Empty cycles (zero blast radius) within the recent window. */
    emptyCycleCount: number;
    /** Trailing run of consecutive empty cycles at the tail (saturation). */
    consecutiveEmptyCycles: number;
    /** Trailing run of consecutive failed cycles at the tail. */
    consecutiveFailureCount: number;
    /** Trailing run of consecutive successful cycles at the tail. */
    consecutiveSuccessCount: number;
    /** Successful cycles within the recent window. */
    successCycleCount: number;
    /** Fraction of the recent window that failed (0..1). */
    recentFailureRatio: number;
    /** geneId → times used within the recent window (informs which gene dominates a failure loop). */
    geneFreq: Readonly<Record<string, number>>;
}
/** A normalized per-cycle record (v2-shaped mirror of v1's recentEvents entries). All fields optional. */
export interface CycleRecord {
    /** Intent category of the cycle ('repair' | 'optimize' | 'innovate' | 'explore' | ...). */
    intent?: string;
    /** Final cycle outcome. */
    outcome?: {
        status?: 'success' | 'failed';
        score?: number;
    };
    /** Change footprint; files===0 && lines===0 (or meta.emptyCycle) marks an empty cycle. */
    blastRadius?: {
        files?: number;
        lines?: number;
    };
    /** Explicit empty-cycle marker (when blast radius is unavailable). */
    emptyCycle?: boolean;
    /** Genes used in the cycle (for failure-loop gene frequency). */
    genesUsed?: readonly string[];
}
/**
 * Derive the v1 history counters from a normalized cycle-record window (newest LAST), mirroring v1
 * analyzeRecentHistory. Pure + deterministic. Use {@link cycleRecordsFromEvents} to adapt the v2 event log.
 */
export declare function deriveCycleHistory(records: readonly CycleRecord[]): CycleHistory;
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
export declare function computeMetaSignals(history: CycleHistory): string[];