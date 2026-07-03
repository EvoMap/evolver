export interface PackageMetadata {
    readonly name?: string;
    readonly version?: string;
    readonly bin?: string | Record<string, string>;
}
export interface ResolveRuntimeVersionOptions {
    readonly startDir: string;
    readonly isPackage: (pkg: PackageMetadata) => boolean;
    readonly fallback?: string;
    readonly execGit?: (args: readonly string[], cwd: string) => string;
}
export declare function resolveRuntimeVersion(opts: ResolveRuntimeVersionOptions): string;