import type { McpServerCmd } from './injection.js';
export type ServiceTarget = 'launchd' | 'systemd' | 'windows' | 'compose' | 'k8s';
export declare const SERVICE_TARGETS: readonly ServiceTarget[];
export interface ServiceGuidanceContext {
    /** Path to the credential store the service should reference via EVOLVER_ENV_FILE. Falls back to the exec env's
     *  pointer, else a placeholder. NEVER a secret value — only the pointer path. */
    envFile?: string;
    /** The long-running evolver command the service runs (illustrative — operator may swap for autoexec/proxy/etc). */
    exec: McpServerCmd;
}
/**
 * Render a service template for `target`. Print-only; the operator edits + installs it. Each template wires the
 * credential store via the EVOLVER_ENV_FILE pointer (never inlines a secret) and runs the given evolver command.
 */
export declare function renderServiceGuidance(target: ServiceTarget, ctx: ServiceGuidanceContext): string;