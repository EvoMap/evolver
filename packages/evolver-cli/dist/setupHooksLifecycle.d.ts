import { type InjectionPlan, type InstallOptions, type InstallScope, type RuntimeId } from '@evomap/evolver-mcp';
export declare const SETUP_LIFECYCLE_SCHEMA = "evolver.setup_hooks.lifecycle.v1";
export declare const SETUP_LIFECYCLE_PLAN_TTL_MS = 120000;
export type SetupLifecycleAction = 'install' | 'uninstall';
export type SetupLifecycleOperation = 'plan' | 'verify' | 'install' | 'uninstall';
export interface SetupLifecycleCapabilities {
    schema: typeof SETUP_LIFECYCLE_SCHEMA;
    runtime: RuntimeId;
    scope: InstallScope;
    supported: boolean;
    operations: Record<SetupLifecycleOperation, boolean>;
}
export interface SetupLifecycleTarget {
    target_id: string;
    target_ref: string;
    expected_identity: string;
    disposition: 'installable' | 'removable' | 'already_satisfied';
    impact_hints: string[];
}
export interface SetupLifecyclePlan {
    schema: typeof SETUP_LIFECYCLE_SCHEMA;
    plan_id: string;
    generation: string;
    target_set_digest: string;
    intent_digest: string;
    created_at: string;
    expires_at: string;
    action: SetupLifecycleAction;
    runtime: RuntimeId;
    scope: InstallScope;
    targets: SetupLifecycleTarget[];
}
export interface SetupLifecycleTargetResult {
    target_id: string;
    outcome: 'installed' | 'removed' | 'already_satisfied' | 'already_absent' | 'failed';
    committed: boolean;
    verified: boolean;
    recovery?: 'REFRESH_PLAN' | 'OPEN_CONFIG' | 'RETRY_VERIFICATION';
}
export interface SetupLifecycleExecutionResult {
    schema: typeof SETUP_LIFECYCLE_SCHEMA;
    action: SetupLifecycleAction;
    runtime: RuntimeId;
    scope: InstallScope;
    plan_id: string;
    generation: string;
    target_set_digest: string;
    complete: boolean;
    verified: boolean;
    targets: SetupLifecycleTargetResult[];
}
export interface SetupLifecycleExecutionOptions {
    targetId?: string;
    completedTargetIds?: readonly string[];
}
export interface SetupLifecycleContext {
    runtime: RuntimeId;
    scope: InstallScope;
    configRoot: string;
    injectionPlan: InjectionPlan;
    installOptions: InstallOptions;
    now?: () => Date;
}
export declare class SetupLifecycleError extends Error {
    readonly code: 'CAPABILITY_UNAVAILABLE' | 'PLAN_INVALID' | 'PLAN_EXPIRED' | 'PLAN_STALE' | 'VERIFY_FAILED';
    constructor(code: 'CAPABILITY_UNAVAILABLE' | 'PLAN_INVALID' | 'PLAN_EXPIRED' | 'PLAN_STALE' | 'VERIFY_FAILED', message: string);
}
export declare function setupLifecycleCapabilities(runtime: RuntimeId, scope: InstallScope): SetupLifecycleCapabilities;
export declare function createSetupLifecyclePlan(context: SetupLifecycleContext, action: SetupLifecycleAction): SetupLifecyclePlan;
export declare function encodeSetupLifecyclePlan(plan: SetupLifecyclePlan): string;
export declare function decodeSetupLifecyclePlan(raw: string): SetupLifecyclePlan;
export declare function verifySetupLifecycle(context: SetupLifecycleContext): boolean;
export declare function executeSetupLifecyclePlan(context: SetupLifecycleContext, confirmed: SetupLifecyclePlan, options?: SetupLifecycleExecutionOptions): SetupLifecycleExecutionResult;