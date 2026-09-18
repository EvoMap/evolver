interface RuntimeIdentity {
    execPath: string;
    platform: NodeJS.Platform;
    bunVersion?: string;
}
export interface TrustedValidationRuntime {
    cmd: string;
    args: string[];
    /** Merge last over an already scrubbed environment; never merge the parent environment. */
    env: NodeJS.ProcessEnv;
    /** Trusted workers must not start in the source tree, where Bun can discover configuration. */
    cwd: string;
    /** Must run after the worker exits, including timeout and spawn failure. Throws if cleanup is unconfirmed. */
    cleanup(): void;
}
/** Only fixed, trusted JavaScript belongs here. Positional data is never interpolated into its source. */
export declare function trustedValidationRuntime(source: string, positional?: readonly string[], options?: {
    /** V8 options are meaningful only for Node, not Bun's JavaScriptCore. */
    nodeArgs?: readonly string[];
    /** Internal test seam. Production callers use the actual running executable and runtime. */
    runtime?: RuntimeIdentity;
}): TrustedValidationRuntime;
export {};