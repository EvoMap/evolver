import { type ValidationResult } from './validation.js';
export interface SandboxedValidationSkippedCommand {
    cmd: string;
    script: string;
    reason: 'missing_script';
}
export interface SandboxedValidationResult {
    passed: boolean;
    /** Convenience score for cycle outcomes: 0.95 pass / 0.2 fail (matches the prior inline hook). */
    score: number;
    results: ValidationResult[];
    /** Declared repo-relative validation scripts that were absent from this checkout. */
    skipped: SandboxedValidationSkippedCommand[];
    /**
     * Whether OS-namespace isolation (no-network + hidden home secrets) was applied. TRUE only where unprivileged
     * namespaces exist (Linux today). FALSE on Windows/macOS, where commands still get the non-namespace hardening
     * but CAN reach the network and read home files — the caller should surface this so the weaker guarantee on
     * those platforms is not silent.
     */
    isolated: boolean;
}
export interface SandboxedValidationOptions {
    /** Per-command timeout (ms), forwarded to the sandbox runner. */
    timeoutMs?: number;
    /** Test seam: override the unprivileged-namespace availability probe. */
    unshareCheck?: () => boolean;
}
/**
 * Run validation commands in the hardened sandbox. Isolation (no-network + hidden home secrets) is requested only
 * when unprivileged namespaces are available; elsewhere (Windows/macOS) it degrades to the non-namespace hardening
 * rather than denying every command. The allowlist is derived from the declared commands' own executables, so this
 * runs exactly the commands the caller asked for — just hardened. An EMPTY command set passes (nothing to verify),
 * preserving prior behavior; note this differs from runValidation's own "no commands = not verified" stance.
 */
export declare function runSandboxedValidation(cmds: readonly string[], cwd: string, opts?: SandboxedValidationOptions): Promise<SandboxedValidationResult>;