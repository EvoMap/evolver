import { hub } from '@evomap/evolver-core';
export declare function recipeIpcScope(capability: hub.RecipeExecutionCapability | undefined): string | null;
export declare function invokeRecipeIpc(capability: hub.RecipeCapability | undefined, governance: hub.RecipeExecutionGovernance, operation: hub.RecipeExecutionOperation, raw: unknown, hubMode: 'public' | 'private' | undefined): Promise<{
    status: number;
    body: unknown;
}>;