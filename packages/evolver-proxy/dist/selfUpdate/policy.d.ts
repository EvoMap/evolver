export type SelfUpdatePolicy = 'off' | 'prompt' | 'auto';
/** Resolve EVOLVER_SELF_UPDATE to a policy. Unset/unrecognized → 'off' (fail-closed). */
export declare function resolveSelfUpdatePolicy(env?: NodeJS.ProcessEnv): SelfUpdatePolicy;