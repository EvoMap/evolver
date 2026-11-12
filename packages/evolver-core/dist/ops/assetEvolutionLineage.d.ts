import type { AssetRecord } from '../assetstore/provider.js';
import type { LineageEdge } from './assetEvolutionModel.js';
import { type Family } from './assetEvolutionFamilies.js';
/** Resolves content ids and logical ids to the local Gene family they belong to. */
export interface FamilyLookup {
    familyOfGene(ref: string): Family | undefined;
    familyOfAsset(assetId: string): Family | undefined;
    isLocalCapsule(assetId: string): boolean;
}
/** Only links the stores already hold; nothing is inferred from similarity or timing. */
export declare function lineageEdgesOf(families: readonly Family[], capsules: readonly AssetRecord[], lookup: FamilyLookup): LineageEdge[];
export declare function isDerivation(edge: LineageEdge): boolean;
/** One end of a derivation edge, collapsed to its family when local so versions of one parent count once. */
export interface Relative {
    key: string;
    assetId: string;
    family: Family | undefined;
}
/** Parents and children of every local family through derivation edges, excluding the family itself. */
export declare function relativesOf(edges: readonly LineageEdge[], lookup: FamilyLookup): {
    parents: Map<string, Map<string, Relative>>;
    children: Map<string, Map<string, Relative>>;
};