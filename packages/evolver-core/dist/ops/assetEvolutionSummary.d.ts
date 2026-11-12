import type { AssetSummary, DeliveryStats, EvolutionState, ReuseStats } from './assetEvolutionModel.js';
import { type Family } from './assetEvolutionFamilies.js';
import type { DeliveryFact, ReuseFact } from './assetEvolutionSignals.js';
import type { EvolutionIndex } from './assetEvolutionIndex.js';
export declare function reuseStatsOf(facts: readonly ReuseFact[]): ReuseStats;
export declare function deliveryStatsOf(facts: readonly DeliveryFact[], withEntrypoints: boolean): DeliveryStats;
export declare function assetState(index: EvolutionIndex, assetId: string): EvolutionState;
export declare function summaryOf(index: EvolutionIndex, family: Family): AssetSummary;
/** Newest activity first; families with no dated activity follow, newest stored first. */
export declare function byRecentActivity(a: {
    summary: AssetSummary;
    family: Family;
}, b: {
    summary: AssetSummary;
    family: Family;
}): number;