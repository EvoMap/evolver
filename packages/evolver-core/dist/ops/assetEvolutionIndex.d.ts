import type { AssetRecord } from '../assetstore/provider.js';
import { type ReviewRecord } from '../assetstore/reviewLedger.js';
import type { AssetEvolutionInput, LineageEdge, TimelineEntry } from './assetEvolutionModel.js';
import { type Family } from './assetEvolutionFamilies.js';
import { type FamilyLookup, type Relative } from './assetEvolutionLineage.js';
import { type DeliveryFact, type ReuseFact } from './assetEvolutionSignals.js';
/** Every join the overview and the dossier read, built once per projection. */
export interface EvolutionIndex {
    input: AssetEvolutionInput;
    families: Family[];
    lookup: FamilyLookup;
    effectiveReview: Map<string, ReviewRecord>;
    /** Append position of each review record, the tie-break when two decisions share a timestamp. */
    reviewOrder: Map<ReviewRecord, number>;
    reviewByAsset: Map<string, ReviewRecord[]>;
    reuses: ReuseFact[];
    deliveries: DeliveryFact[];
    edges: LineageEdge[];
    parents: Map<string, Map<string, Relative>>;
    children: Map<string, Map<string, Relative>>;
    capsulesByFamily: Map<string, AssetRecord[]>;
    reusesByFamily: Map<string, ReuseFact[]>;
    deliveriesByFamily: Map<string, DeliveryFact[]>;
    timeline: TimelineEntry[];
    lastActivityByFamily: Map<string, string>;
}
export declare function buildEvolutionIndex(input: AssetEvolutionInput): EvolutionIndex;