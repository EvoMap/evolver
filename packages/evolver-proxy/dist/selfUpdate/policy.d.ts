export type SelfUpdatePolicy = 'off' | 'prompt' | 'auto';
/** Resolve EVOLVER_SELF_UPDATE to a policy. Unset → 'auto' (still gated by supervisor + public key). Unrecognized → 'off' (fail-closed). */
export declare function resolveSelfUpdatePolicy(env?: NodeJS.ProcessEnv): SelfUpdatePolicy;
/** True when the operator set EVOLVER_SELF_UPDATE to any non-blank value. */
export declare function isSelfUpdateExplicit(env?: NodeJS.ProcessEnv): boolean;
/** Attested only by the generated durable launchers; env files and operators cannot forge the marker. */
export declare function selfUpdateSupervisorAttested(env: NodeJS.ProcessEnv): boolean;
export interface EffectiveSelfUpdatePolicy {
    policy: SelfUpdatePolicy;
    /** True when a DEFAULT auto was degraded to 'off' because the supervisor attestation is missing. */
    degraded: boolean;
}
/**
 * Resolve the policy that startup should actually run with. A default (unset) 'auto' without durable
 * supervisor attestation OR without any available public key OR without a bindable self-update target
 * (npm/JS install shape) degrades to 'off' so direct/foreground runs — and residual launchers from a
 * bad bootstrap on a JS install — keep working; an explicit 'auto' passes through untouched and fails
 * closed at assembly time. `execPath` overrides process.execPath for the target-bindability check.
 */
export declare function resolveEffectiveSelfUpdatePolicy(env?: NodeJS.ProcessEnv, execPath?: string): EffectiveSelfUpdatePolicy;