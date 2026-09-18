export declare function privateRootPathsAllowed(root: string, cwd: string, scratch: string): boolean;
/** A non-recursive bind must not substitute the hidden underlying directory for a source submount. */
export declare function sourceHasNestedMounts(root: string, mountInfo: string): boolean;
export declare const PRIVATE_ROOT_GUARDIAN: string;
/** Fixed positional launcher: no source-derived value is interpolated as shell code. */
export declare function privateRootFilesystemSetup(scratchBytes: number, trustedPath: string): string;