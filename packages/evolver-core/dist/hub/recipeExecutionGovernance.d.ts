import { type RecipeExecutionCapability, type RecipeExecutionInputs, type RecipeExecutionOperation, type RecipeExecutionOutputs } from './recipeExecution.js';
export interface RecipeSpendConsent {
    version: 1;
    enabled: boolean;
    maxCredits: number;
    acknowledgedAt: string;
}
export declare function recipeStateDirectory(env?: Record<string, string | undefined>): string;
export declare function readRecipeSpendConsent(directory?: string): RecipeSpendConsent | null;
export declare function setRecipeSpendConsent(enabled: boolean, maxCredits: number, directory?: string): RecipeSpendConsent;
export declare class RecipeExecutionGovernance {
    private readonly pendingRejections;
    private readonly directory;
    constructor(directory?: string);
    assertSpendAllowed(maxCredits: number): void;
    invoke<K extends RecipeExecutionOperation>(capability: RecipeExecutionCapability | undefined, operation: K, input: RecipeExecutionInputs[K]): Promise<RecipeExecutionOutputs[K]>;
    private persistUncertainPreflightIntent;
    private invokeIntent;
    private persistRejection;
}