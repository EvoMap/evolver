import type { AssetEvolutionInput, AssetEvolutionOverview, AssetDossier } from './assetEvolutionModel.js';
export { ASSET_EVOLUTION_SCHEMA } from './assetEvolutionModel.js';
export type { AssetEvolutionInput, AssetEvolutionOverview, AssetDossier, AssetEvolutionSources, EvolutionRootEvent } from './assetEvolutionModel.js';
export interface AssetEvolutionOptions {
    /** Most timeline entries returned, newest first. */
    limit: number;
}
export declare function projectAssetEvolutionOverview(input: AssetEvolutionInput, options: AssetEvolutionOptions): AssetEvolutionOverview;
/** The dossier for a local Gene (by content id or logical id) or a network asset seen locally; null when unknown. */
export declare function projectAssetEvolutionDossier(input: AssetEvolutionInput, ref: string, options: AssetEvolutionOptions): AssetDossier | null;