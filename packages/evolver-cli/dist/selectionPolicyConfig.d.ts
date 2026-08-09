export type ConfiguredSelectionPolicy = 'engine-health' | 'ucb1-shadow' | 'ucb1';
export type ConfiguredSelectionGuard = 'legacy' | 'shadow' | 'enforce';
/** Unknown values fail safe to the current production policy. */
export declare function selectionPolicyFromEnv(env?: NodeJS.ProcessEnv): ConfiguredSelectionPolicy;
/** Unknown values fail safe to the production relevance guard. */
export declare function selectionGuardFromEnv(env?: NodeJS.ProcessEnv): ConfiguredSelectionGuard;
/** Optional score floor. Invalid values are omitted so core keeps its declared default. */
export declare function selectionFloorFromEnv(env?: NodeJS.ProcessEnv): number | undefined;