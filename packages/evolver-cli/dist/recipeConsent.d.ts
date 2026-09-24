export interface RecipeGovernanceCliIo {
    log(line: string): void;
}
export declare function runRecipeConsentCommand(args: readonly string[], env: NodeJS.ProcessEnv, io: RecipeGovernanceCliIo): number;