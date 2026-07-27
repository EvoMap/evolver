import { assetstore, events, verify, type hub as hubNs } from '@evomap/evolver-core';
import type { ConnectPublicOptions, PublicHubCapability } from '@evomap/evolver-adapter-public';
export interface RecipeCliDeps {
    hub?: RecipeHub;
    store?: assetstore.AssetStoreProvider;
    env?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    err?: (line: string) => void;
    ingestor?: events.Ingestor;
    review?: assetstore.ReviewLedger;
    runValidation?: typeof verify.runSandboxedValidation;
    connectHub?: (opts: ConnectPublicOptions) => {
        hub: PublicHubCapability;
        auth: hubNs.AuthProvider;
    };
}
export interface RecipeHub {
    recipes?: hubNs.RecipeCapability;
    publish(bundle: assetstore.AssetRecord[]): Promise<hubNs.PublishReceipt>;
    hello?(opts: {
        rotate: boolean;
        evolverVersion?: string;
        preserveCredentials?: boolean;
    }): Promise<{
        ok: boolean;
        error?: string;
        nodeId?: string;
    }>;
}
type ParseResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: string;
};
export interface RecipeBuildOptions {
    sub: 'build';
    title: string;
    assetIds: string[];
    description?: string;
    pricePerExecution?: number;
    publish: boolean;
}
export interface RecipeReuseOptions {
    sub: 'reuse';
    recipeId: string;
    inputPayload: Record<string, unknown>;
    jsonOut: boolean;
}
export interface RecipeFromSkillsOptions {
    sub: 'from-skills';
    manifestPath: string;
    publish: boolean;
    jsonOut: boolean;
}
export type RecipeOptions = RecipeBuildOptions | RecipeReuseOptions | RecipeFromSkillsOptions;
export declare function runRecipeCommand(argv: readonly string[], deps?: RecipeCliDeps): Promise<number>;
export declare function createRecipeHubFromEnv(env?: NodeJS.ProcessEnv, connectHub?: (opts: ConnectPublicOptions) => {
    hub: PublicHubCapability;
    auth: hubNs.AuthProvider;
}): PublicHubCapability;
/** Opaque identity for resume isolation; raw credentials, account ids, and local paths never leave this helper. */
export declare function resolveRecipeHubResumeIdentityFingerprint(env: NodeJS.ProcessEnv): string;
export declare function parseRecipeArgs(argv: readonly string[]): ParseResult<RecipeOptions>;
/**
 * The EXPLICIT home overrides (EVOMAP_DIR / EVOLVER_HOME / EVOMAP_HOME) the recipe credential layer honors,
 * resolved purely from the passed env with no process.env fallback. Exported so `reset-local-secret` (index.ts)
 * can clear the SAME explicit directories the recipe path may persist rotated legacy files into
 * (rotatePersistDir = recipeHomeCandidates(env)[0], which is the first explicit home when any is set) — otherwise
 * a reset that only wiped ~/.evomap would leave a stale node_secret under EVOMAP_DIR/EVOMAP_HOME that resurrects on
 * the next recipe run (H3). Kept env-pure (no events.evomapHome()) so reset stays hermetic under an injected env.
 */
export declare function explicitRecipeHomes(env: NodeJS.ProcessEnv): string[];
export {};