import type { RootEvent } from '../events/eventSchema.js';
export declare const SELECTION_POLICIES: readonly ["engine-health", "ucb1-shadow", "ucb1"];
export type SelectionPolicy = (typeof SELECTION_POLICIES)[number];
export declare const UCB1_SELECTION_POLICY_VERSION = "ucb1-v1";
export declare const UCB1_REWARD_POLICY_VERSION = "productive-binary-v1";
export interface Ucb1ArmStats {
    armId: string;
    pulls: number;
    completedPulls: number;
    rewardSum: number;
    meanReward: number;
}
export interface Ucb1History {
    arms: ReadonlyMap<string, Ucb1ArmStats>;
    /** Every non-ad-hoc decision counts immediately, including decisions whose terminal event is still pending. */
    totalPulls: number;
}
export interface Ucb1Arm {
    armId: string;
    baseScore: number;
    explorationEligible: boolean;
    stats: Ucb1ArmStats;
}
export interface Ucb1Choice {
    armId: string;
    pulls: number;
    completedPulls: number;
    totalPulls: number;
    meanReward: number;
    /** Null represents the canonical +Infinity cold-start index without putting Infinity on the event wire. */
    bonus: number | null;
    /** Null represents the canonical +Infinity cold-start index without putting Infinity on the event wire. */
    index: number | null;
    coldStart: boolean;
}
export type Ucb1FallbackReason = 'empty_pool' | 'ineligible_arm' | 'missing_history';
export interface Ucb1Decision {
    choice: Ucb1Choice | null;
    fallbackReason?: Ucb1FallbackReason;
}
/**
 * Rebuild UCB1 state from the append-only root event log. Decisions are pulls immediately, so later readers no
 * longer treat an in-flight arm as cold. The read-select-append sequence is not an atomic reservation across
 * workers. A terminal event adds reward exactly once per cycle; duplicate rows collapse to their latest projection.
 */
export declare function deriveUcb1History(events: readonly RootEvent[]): Ucb1History;
/** Combine current asset identity with legacy gene-only history when that bridge is unambiguous. */
export declare function ucb1StatsForCandidate(history: Ucb1History, geneId: string, assetId?: string, includeLegacyGeneHistory?: boolean): Ucb1ArmStats;
/**
 * Canonical UCB1: mean reward + sqrt(2 ln(total pulls) / arm pulls). Cold arms have +Infinity and are ordered
 * deterministically by base score then arm identity. The caller supplies only the already-gated exploration window.
 */
export declare function chooseUcb1Arm(arms: readonly Ucb1Arm[], historyTotalPulls: number): Ucb1Decision;