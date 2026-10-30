export interface ExperienceCommit {
    operationId: string;
    requestHash: string;
    namespace: string;
    commitId: string;
    commitSequence: number;
    committedAt: string;
    action: string;
    assetId: string;
    state: string;
    evidence: Record<string, unknown>;
}
export interface ExperienceOperationStatus {
    operationId: string;
    requestHash: string;
    state: 'reserved' | 'prepared' | 'committed' | 'aborted' | 'recovery_unknown';
    completion: 'pending' | 'acknowledged';
    commit?: ExperienceCommit;
}
export interface ExperienceMutation {
    file: string;
    row: Record<string, unknown>;
}
export declare class ExperienceJournalError extends Error {
    readonly code: string;
    constructor(code: string);
}
/** Business commit authority. JSONL mirrors are fenced until the immutable receipt + outbox commit. */
export declare class ExperienceJournal {
    readonly baseDir: string;
    readonly path: string;
    readonly marker: string;
    constructor(baseDir: string);
    private use;
    lookup(id: string, hash?: string): ExperienceOperationStatus | undefined;
    status(limit?: number, after?: number): ExperienceOperationStatus[];
    private outbox;
    recoveryStatus(limit?: number, deadlineAt?: number): Promise<ExperienceOperationStatus[]>;
    hasCommitForAsset(assetId: string): boolean;
    pending(limit?: number, deadlineAt?: number): Promise<ExperienceCommit[]>;
    backlog(operationId?: string, deadlineAt?: number): Promise<{
        remaining: number;
        totalPending: number;
        nextOperationId?: string;
    }>;
    acknowledge(commit: ExperienceCommit, receipt: unknown, deadlineAt?: number): Promise<void>;
    private namespace;
    private manifest;
    private verifyMutation;
    private cleanup;
    private recoverUnderLock;
    recoverBusiness(deadlineAt?: number): Promise<'none' | 'committed' | 'aborted'>;
    commit(id: string, hash: string, prepare: () => {
        mutations: ExperienceMutation[];
        result: Omit<ExperienceCommit, 'operationId' | 'requestHash' | 'namespace' | 'commitId' | 'commitSequence' | 'committedAt'>;
    }, now: () => number, checkpoint?: (phase: string) => void): ExperienceCommit;
}