import type { SelectionPolicy, Ucb1History } from './ucb1.js';
export type PlateauSeverity = 'suggested' | 'required';
export interface PlateauState {
    active: boolean;
    severity: PlateauSeverity;
    count: number;
}
/** Exploration control fed into selection. Absent → pure deterministic top-score selection. */
export interface ExplorationInput {
    /** Selection policy requested by the composition layer. Default preserves legacy engine-health + drift. */
    policy?: SelectionPolicy;
    /** Force drift on even without a plateau (e.g. an explicit explore policy). */
    driftEnabled?: boolean;
    /** Plateau detected upstream; an active plateau forces drift intensity up. */
    plateau?: PlateauState;
    /** Total attempts across the candidate pool (drives the maturity decay of the drift offset). */
    totalAttempts?: number;
    /** Event-log-derived state for UCB1. Undefined means fail-safe to legacy drift. */
    ucb1History?: Ucb1History;
}
/**
 * Adaptive drift intensity (ported v1): 1/sqrt(Ne) + an offset that decays from 0.3 → 0.02 as the pool
 * matures (totalAttempts approaches Ne * 10). Tiny pools (Ne <= 1) get a fixed high 0.7 to force exploration.
 */
export declare function computeDriftIntensity(ne: number, totalAttempts?: number): number;
/** Detect a plateau from recent cycle outcomes: count the trailing run of consecutive non-success. */
export declare function detectPlateau(recentOutcomes: readonly ('success' | 'failed')[]): PlateauState;
export interface DriftDecision {
    driftMode: 'deterministic' | 'drift' | 'plateau_drift';
    index: number;
    intensity: number;
}
/** Deterministic top-N window shared by legacy random drift and UCB1. */
export declare function explorationWindowSize(eligibleCount: number, exp: ExplorationInput | undefined): number;
/**
 * Pick which ranked candidate to take among `eligibleCount` above-floor candidates.
 * No exploration → deterministic top (index 0). With exploration → compute intensity (an active plateau
 * forces it to 0.7/1.0); with probability = intensity, pick a random candidate from the top-N (N grows
 * with intensity). rng() is called at most twice; pass a seeded rng for deterministic tests.
 */
export declare function driftSelect(eligibleCount: number, exp: ExplorationInput | undefined, rng: () => number): DriftDecision;