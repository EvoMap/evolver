import { hub } from '@evomap/evolver-core';
import { type PublicHubOptions } from './hubCapability.js';
export declare function recipeHubError(error: unknown, operation: hub.RecipeExecutionOperation): hub.RecipeExecutionError;
export declare function createRecipeExecution(opts: PublicHubOptions): hub.RecipeExecutionCapability;