export interface SeatbeltLimits {
    cpuSeconds: number;
    fileSizeBytes: number;
    /** Processes this command tree may add on top of what the account already runs. */
    processes: number;
}
export interface SeatbeltPaths {
    readOnlyRoot: string;
    cwd: string;
    writableTmpDir: string;
    runtime: string;
    home: string;
    /** Toolchain and dependency directories that stay readable even inside the hidden subpaths. */
    readRoots?: readonly string[];
    /** Symlinks a toolchain path resolves through into its read roots; only the link itself becomes visible. */
    readLinks?: readonly string[];
    /** Let the workload write the checkout itself (a disposable verification copy), never anything else. */
    writableSource?: boolean;
}
export interface SeatbeltLaunch {
    cmd: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
    cleanup: () => void;
}
export declare function seatbeltCommand(bin: string, args: readonly string[], requested: SeatbeltPaths, limits: SeatbeltLimits): SeatbeltLaunch;
/** The real account home, not $HOME: a caller that overrides HOME must not move the secret boundary with it. */
export declare function accountHome(): string;
/** Proves the generated profile is enforced on this host (network, checkout writes, HOME reads) before trusting it. */
export declare function seatbeltIsolationAvailable(): boolean;