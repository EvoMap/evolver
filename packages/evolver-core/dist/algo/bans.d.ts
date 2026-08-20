export interface FailedCapsuleRef {
    gene?: string;
    trigger?: readonly string[];
    /** Stable logical FailureRecord id; duplicate deliveries of the same record count once. */
    failureId?: string;
    /** Root attempt shared by automatic retries; sharing this id makes retry fan-out count once. */
    rootAttemptId?: string;
    /** Execution/run id; duplicate deliveries of one execution count once even if other metadata diverges. */
    executionId?: string;
    /** Optional verifier+artifact digest pair refines legacy evidence when no direct failure/root/execution id exists. */
    verifierDigest?: string;
    artifactDigest?: string;
}
/** Gene ids with >=2 independent failed capsules whose trigger covers >=60% of the current signals. */
export declare function bannedGenesFromFailures(failures: readonly FailedCapsuleRef[], signals: readonly string[]): Set<string>;