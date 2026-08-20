import type { AssetRecord, HubCapability } from './capability.js';
export declare const RECIPE_COMPOSE_FLAG = "compose_recipe";
export interface RecipeComposeInput {
    title?: string;
    description?: string;
    assets?: readonly unknown[];
    source?: unknown;
    [k: string]: unknown;
}
export interface RecipeComposeResult {
    attempted: boolean;
    ok: boolean;
    reason?: string;
    recipeId?: string;
    status?: string;
}
export declare function recipeComposeRequested(payload: RecipeComposeInput): boolean;
export declare function recipeAssetsFromPayload(payload: RecipeComposeInput): {
    gene?: AssetRecord;
    capsule?: AssetRecord;
};
/**
 * After a Gene/Capsule bundle is accepted by Hub, compose a Recipe as the
 * preferred public artifact. Skill Store publish is not the default outbound.
 * Missing recipe capability or missing Gene is a no-op, never a publish failure.
 */
export declare function composeRecipeAfterAssetPublish(hub: Pick<HubCapability, 'recipes'>, payload: RecipeComposeInput): Promise<RecipeComposeResult>;