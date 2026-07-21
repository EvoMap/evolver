export interface CurrentVersionOptions {
    startDir?: string;
    buildVersion?: string;
}
/** Resolve EVOLVER's version from package/git metadata, then the standalone build-time version. */
export declare function getCurrentVersion(options?: CurrentVersionOptions): string;