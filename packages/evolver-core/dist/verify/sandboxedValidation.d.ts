import { type SandboxResourceBudget, type SandboxResourceGroup } from './sandboxRunner.js';
import { type ValidationResult } from './validation.js';
import type { ObservedCheck } from './observedCheck.js';
export { treeFingerprint } from './validationTreeFingerprint.js';
export { normalizeObservedCheck, type ObservedCheck } from './observedCheck.js';
export { validationCommandRejection, type ValidationCommandRejection } from './validationCommandPolicy.js';
export type SandboxedValidationSkipReason = 'missing_script' | 'script_outside_root' | 'script_symlink' | 'script_unresolvable';
export interface SandboxedValidationSkippedCommand {
    cmd: string;
    script: string;
    reason: SandboxedValidationSkipReason;
}
export interface SandboxedValidationResult {
    passed: boolean;
    /** 是否因宿主取消而终止；取消永远不是成功验证。 */
    cancelled?: boolean;
    /** Setup/cleanup failures remain explicit even when the validation command itself exited successfully. */
    failureReason?: 'sandbox_setup_failed' | 'sandbox_cleanup_failed';
    /** Convenience score for cycle outcomes: 0.95 pass / 0.2 fail (matches the prior inline hook). */
    score: number;
    results: ValidationResult[];
    /** Validation commands not executed because their script was missing or failed the path safety gate. */
    skipped: SandboxedValidationSkippedCommand[];
    /**
     * Whether an OS isolation boundary was requested: Linux namespaces, or the macOS Seatbelt profile. FALSE on
     * Windows, where commands still get the non-namespace hardening but CAN reach the network and read home
     * files — the caller should surface this so the weaker guarantee is not silent.
     */
    isolated: boolean;
    /**
     * Selected boundary. A nonempty passing plan confirms it wrapped every command; a failed plan can
     * include a setup refusal. 'read-only' is the full cage (no network, hidden home secrets, a read-only
     * checkout with only a private scratch writable, aggregate resource limits, whole-tree cleanup); 'no-network'
     * uses a private filesystem root with a read-only checkout, private HOME/processes and no network, without
     * aggregate cgroup limits; 'none' means no boundary at all.
     * Callers that need the full cage must check this, not `isolated`.
     */
    isolationTier: ValidationIsolationTier;
    /**
     * How the read-only tier's aggregate memory/process budget was enforced: 'kernel' (Linux cgroup v2) or
     * 'watchdog' (macOS, sampled every 100 ms, so a burst between samples can overshoot before the tree is killed).
     * Present only with `isolationTier: 'read-only'`.
     */
    resourceLimitEnforcement?: ResourceLimitEnforcement;
}
export type ResourceLimitEnforcement = 'kernel' | 'watchdog';
/** Named boundaries so a caller can state the floor it will accept. */
export type ValidationIsolationTier = 'none' | 'no-network' | 'read-only';
/** A floor names a boundary the caller will accept, and 'none' is the absence of one — never a valid floor. */
export type ValidationIsolationFloor = Exclude<ValidationIsolationTier, 'none'>;
/** Probe the complete fallback boundary, not merely whether a network namespace can be created. */
export declare function privateRootIsolationAvailable(): boolean;
export declare function readOnlyFilesystemIsolationAvailable(): boolean;
/** What this host can actually build, strongest first. Callers log it to explain a downgrade. */
export declare function availableIsolationTier(): ValidationIsolationTier;
export declare function readOnlyIsolationAvailable(): boolean;
export interface SandboxedValidationOptions {
    /** Per-command timeout (ms), forwarded to the sandbox runner. */
    timeoutMs?: number;
    /** Cooperative cancellation forwarded to the validation process. */
    signal?: AbortSignal;
    /** Test seam: override the unprivileged-namespace availability probe. */
    unshareCheck?: () => boolean;
    /** Refuse before spawning when network/home namespace isolation is unavailable. */
    requireIsolation?: boolean;
    /**
     * Weakest tier this caller accepts under `requireIsolation`. Defaults to 'read-only', which is what every caller
     * got before this option existed. 'no-network' lets a host that cannot build a read-only root still run the
     * commands inside a private root with a read-only checkout instead of refusing outright. Aggregate cgroup
     * resource limits are absent in this tier, so it is opt-in and
     * always reported back in `isolationTier`.
     */
    minimumIsolation?: ValidationIsolationFloor;
    /**
     * Override what the host is judged capable of. `unshareCheck` cannot express "network namespaces work but a
     * read-only root does not", which is exactly the case this tier exists for, so that combination needs a seam
     * that names the tier.
     */
    isolationProbe?: () => ValidationIsolationTier;
    /** Checkout root to preserve read-only at its original absolute path. */
    readOnlyRoot?: string;
    /**
     * Read-only tier only: the original project whose installed `node_modules` (root and workspace packages) and
     * `.venv` the checkout copy may use. The copy gets links, the sandbox gets read access to the targets only.
     */
    dependencySourceRoot?: string;
    /**
     * Read-only tier only: the checkout is a disposable verification copy that test tooling may write (vite bundles
     * its config next to the config file). Dependencies, the source project and the network stay closed.
     */
    writableCheckout?: boolean;
    /** Aggregate memory/process budget per command; defaults to 1 GiB and 64 processes. */
    resourceBudget?: SandboxResourceBudget;
    /** Injected cgroup allocator (test seam). */
    resourceGroupFactory?: (budget: SandboxResourceBudget) => SandboxResourceGroup | null;
}
/**
 * Run validation commands in the hardened sandbox. Isolation (no-network + hidden home secrets) is requested only
 * when an OS boundary is available; elsewhere (Windows, or a host whose probe failed) it degrades to the
 * non-namespace hardening rather than denying every command. The allowlist is derived from the declared commands' own executables, so this
 * runs exactly the commands the caller asked for — just hardened. An EMPTY command set passes (nothing to verify),
 * preserving prior behavior; note this differs from runValidation's own "no commands = not verified" stance.
 */
export declare function runSandboxedValidation(cmds: readonly string[], cwd: string, opts?: SandboxedValidationOptions): Promise<SandboxedValidationResult>;
/**
 * Same boundary and result as runSandboxedValidation, for checks that carry their own working directory
 * (relative to the read-only root), such as the output of normalizeObservedCheck.
 */
export declare function runSandboxedChecks(checks: readonly ObservedCheck[], cwd: string, opts?: SandboxedValidationOptions): Promise<SandboxedValidationResult>;