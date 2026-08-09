import { spawn } from 'node:child_process';
import { type MigrationOptions } from './migration.js';
export declare const BOOTSTRAP_SUCCESS_FILE = "bootstrap.json";
export type BootstrapSkipReason = 'already_supervised' | 'already_bootstrapped' | 'unsupported_install_shape' | 'policy_not_auto' | 'bootstrap_disabled' | 'ci_environment' | 'container_environment' | 'recent_failure';
export interface BootstrapDecision {
    proceed: boolean;
    reason?: BootstrapSkipReason;
}
export interface BootstrapOutcome {
    ok: boolean;
    /**
     * 'bootstrapped' / 'migrated' on success; failure/skip reason otherwise. Migration
     * failures record 'migration_failed' / 'migration_timeout' (both cooldown-worthy).
     */
    reason: string;
    detail?: string;
}
export interface BootstrapRunOptions {
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    execPath?: string;
    argv1?: string;
    timeoutMs?: number;
    now?: number;
    exists?: (path: string) => boolean;
    readFile?: (path: string) => string;
    writeFile?: (path: string, content: string) => void;
    spawnFn?: typeof spawn;
    /**
     * Extra seams forwarded to the one-time npm/JS → standalone migration (migration.ts).
     * Bootstrap-level seams (exists/readFile/writeFile/spawnFn/now/execPath) win when both
     * are supplied, so the decision and the migration observe the same injected world.
     */
    migration?: MigrationOptions;
}
/** Lifecycle state dir mirror of evolver-cli lifecyclePaths (kept dependency-free across packages). */
export declare function resolveBootstrapStateDir(env: NodeJS.ProcessEnv): string;
export declare function looksLikeContainer(exists: (path: string) => boolean, readFile: (path: string) => string): boolean;
/** True when a recent bootstrap/migration attempt failed within the cooldown window. */
export declare function recentBootstrapFailure(env: NodeJS.ProcessEnv, readFile: (path: string) => string, now: number): boolean;
/**
 * Decide whether an unsupervised (degraded) startup should attempt first-run bootstrap.
 * Pure — filesystem access is injectable for tests.
 */
export declare function shouldBootstrap(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform, options?: Pick<BootstrapRunOptions, 'exists' | 'readFile' | 'now' | 'execPath'>): BootstrapDecision;
/**
 * Resolve the `lifecycle bootstrap` invocation for the current install shape: standalone binary,
 * CLI entry through node, or the npm-installed @evomap/evolver-cli sibling. Returns undefined when
 * no CLI can be located (degrade to the existing warning instead of failing startup).
 */
export declare function resolveBootstrapCliInvocation(options?: Pick<BootstrapRunOptions, 'execPath' | 'argv1' | 'exists'>): {
    command: string;
    args: string[];
} | undefined;
/** Best-effort attempt marker; never throws — bootstrap bookkeeping must not break startup. */
export declare function recordBootstrapAttempt(env: NodeJS.ProcessEnv, outcome: BootstrapOutcome, options?: Pick<BootstrapRunOptions, 'writeFile' | 'now'>): void;
/** Spawn `evolver lifecycle bootstrap` and await its result within a bounded timeout. */
export declare function runBootstrap(options: BootstrapRunOptions): Promise<BootstrapOutcome>;
export interface DegradedStartupBootstrapResult {
    /** True when bootstrap succeeded and startup should exit so the new service takes over. */
    handedOver: boolean;
    /** Operator-facing single-line message (stdout when handed over, stderr otherwise). */
    message: string;
}
/**
 * Orchestrate bootstrap for a degraded (default-auto, unsupervised) startup: decide, attempt,
 * record, and produce the operator message. Never throws.
 */
export declare function bootstrapDegradedSelfUpdateStartup(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform, options?: Omit<BootstrapRunOptions, 'env' | 'platform'>): Promise<DegradedStartupBootstrapResult>;