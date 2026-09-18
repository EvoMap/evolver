declare const CEILINGS: {
    readonly timeoutMs: 5000;
    readonly maxEntries: 100000;
    readonly maxDepth: 128;
    readonly maxPathBytes: 32768;
    readonly maxFileBytes: number;
    readonly maxTotalBytes: number;
    readonly maxRecordBytes: number;
};
export type ValidationTreeFingerprintLimits = {
    [Key in keyof typeof CEILINGS]?: number;
};
/** Internal test seam: overrides can tighten, never increase, the production ceilings. */
export declare function fingerprintTreeWithLimits(root: string, overrides?: ValidationTreeFingerprintLimits): string;
/** Bounded synchronous compatibility API. Execution containment must not depend on a fingerprint. */
export declare function treeFingerprint(root: string): string;
export {};