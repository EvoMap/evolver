import { type SandboxResourceGroup } from './sandboxRunner.js';
import { type ValidationResult } from './validation.js';
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
    /** Convenience score for cycle outcomes: 0.95 pass / 0.2 fail (matches the prior inline hook). */
    score: number;
    results: ValidationResult[];
    /** Validation commands not executed because their script was missing or failed the path safety gate. */
    skipped: SandboxedValidationSkippedCommand[];
    /**
     * Whether OS-namespace isolation (no-network + hidden home secrets) was applied. TRUE only where unprivileged
     * namespaces exist (Linux today). FALSE on Windows/macOS, where commands still get the non-namespace hardening
     * but CAN reach the network and read home files — the caller should surface this so the weaker guarantee on
     * those platforms is not silent.
     */
    isolated: boolean;
}
export declare function readOnlyFilesystemIsolationAvailable(): boolean;
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
    /** Checkout root to preserve read-only at its original absolute path. */
    readOnlyRoot?: string;
    /** Injected cgroup allocator (test seam). */
    resourceGroupFactory?: () => SandboxResourceGroup | null;
}
/**
 * Run validation commands in the hardened sandbox. Isolation (no-network + hidden home secrets) is requested only
 * when unprivileged namespaces are available; elsewhere (Windows/macOS) it degrades to the non-namespace hardening
 * rather than denying every command. The allowlist is derived from the declared commands' own executables, so this
 * runs exactly the commands the caller asked for — just hardened. An EMPTY command set passes (nothing to verify),
 * preserving prior behavior; note this differs from runValidation's own "no commands = not verified" stance.
 */
export declare function runSandboxedValidation(cmds: readonly string[], cwd: string, opts?: SandboxedValidationOptions): Promise<SandboxedValidationResult>;