export interface ValidationToolchain {
    /** Absolute executable spawned inside the boundary. */
    bin: string;
    /** Prepended to the command's own arguments (the tool's script when `bin` is the JavaScript runtime). */
    argsPrefix: string[];
    /** Whether `bin` is the host Node runtime, which the Linux tier exposes at its fixed launcher path. */
    javascriptRuntime: boolean;
    /** Canonical directories the tool needs to read; everything else under HOME stays hidden. */
    readRoots: string[];
    /** Directories placed before the trusted system PATH so the tool's own child processes resolve. */
    pathDirs: string[];
    /** Offline, no-write-to-checkout settings; `tmp` is the command's private scratch directory. */
    env(tmp: string): Record<string, string>;
}
export interface ToolchainHost {
    /** The host PATH the tools were installed on (the daemon's own PATH). */
    hostPath: string;
    /** The account home whose contents stay hidden apart from the returned read roots. */
    home: string;
    /** Validation root, searched first for a project `.venv`. */
    root: string;
    /** Canonical source venv explicitly mirrored into the validation root. */
    mirroredVenvRoot?: string;
    env: NodeJS.ProcessEnv;
}
export declare function safeValidationReadRoots(roots: readonly string[], home: string): string[] | null;
/**
 * Resolve a validation tool on the host PATH (a project `.venv` first for Python) and describe exactly what the
 * sandbox must expose for it to run offline. Null means the tool is absent or would need a hidden location.
 */
export declare function resolveValidationToolchain(executable: string, host: ToolchainHost): ValidationToolchain | null;