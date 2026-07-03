export interface FailedCapsuleRef {
    gene?: string;
    trigger?: readonly string[];
}
/** Gene ids with >=2 failed capsules whose trigger covers >=60% of the current signals. */
export declare function bannedGenesFromFailures(failures: readonly FailedCapsuleRef[], signals: readonly string[]): Set<string>;