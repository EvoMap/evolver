import { type CommandRunner } from './validation.js';
export interface SandboxOptions {
    /** Per-command timeout (ms); clamped to 120s. Default 60s. */
    timeoutMs?: number;
    /** Working directory; default = a fresh temp dir, wiped after the command. */
    cwd?: string;
    /** Env keys that reach the child (default = a minimal safe set). */
    envAllowKeys?: readonly string[];
    /**
     * Run the command in a fresh network namespace (no network) — a validation command shouldn't need the net,
     * and cutting it blocks exfiltration (#26). Uses `unshare -r -n` (unprivileged user+net namespace). FAIL-SAFE:
     * if unshare/userns is unavailable, the command is DENIED rather than run with network. Default off.
     */
    noNetwork?: boolean;
    /**
     * Hide the user's credential directories from the command via a mount namespace (#26 FS half): a validation
     * command runs in a fresh temp cwd and has no business reading ~/.evomap (node_secret), ~/.ssh, ~/.aws, etc.
     * — an empty tmpfs is mounted over each (inside the ns only; the host is untouched). FAIL-SAFE: denied if
     * unprivileged mount namespaces are unavailable. Binaries live outside these dirs, so the command still runs.
     */
    hideHomeSecrets?: boolean;
    /** Injected unshare-availability probe (test seam). Default: a real `unshare -r -m -n true` check (cached). */
    unshareCheck?: () => boolean;
}
/** Wrap an (executable,args) in unprivileged namespaces per the requested isolation (pure — testable). */
export declare function isolationCommand(bin: string, args: readonly string[], opts: {
    noNetwork?: boolean;
    hideHomeSecrets?: boolean;
}): {
    cmd: string;
    args: string[];
};
/** Whether unprivileged user+mount+net namespaces (`unshare -r -m -n`) work here (cached) — covers both isolation modes. */
export declare function unshareNetAvailable(): boolean;
/**
 * Build a hardened CommandRunner. The executable allowlist is the ValidationPlan's job (runValidation);
 * this only hardens how an allowed command runs.
 */
export declare function makeSandboxRunner(opts?: SandboxOptions): CommandRunner;