import type { EvidenceTier, EvolutionRootEvent, ReuseOutcome, ReuseStage } from './assetEvolutionModel.js';
/** One reuse report from the local ledger: `value.reuse_hit` is a success, `value.reuse_outcome` carries its verdict. */
export interface ReuseFact {
    assetId: string;
    at: string;
    outcome: ReuseOutcome;
    host: string | null;
    tier: EvidenceTier | null;
    stage: ReuseStage | null;
    taskId: string | null;
    cycleId: string | null;
}
/** One delivery of genes into a host context. `geneRefs` mixes content ids and logical ids, as producers wrote them. */
export interface DeliveryFact {
    at: string;
    entrypoint: string;
    geneRefs: string[];
    capsuleIds: string[];
}
export declare function isValidTime(value: unknown): value is string;
/** Reuse reports counted once per delivery identity, with the same dedupe the reuse report applies. */
export declare function reuseFactsOf(events: readonly EvolutionRootEvent[]): ReuseFact[];
/** Gene deliveries from session-start/prompt-recall receipts and `value.inject`, once per delivery. A shadow render is not a delivery. */
export declare function deliveryFactsOf(events: readonly EvolutionRootEvent[]): DeliveryFact[];