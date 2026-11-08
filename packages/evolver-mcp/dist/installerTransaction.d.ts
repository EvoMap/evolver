import { type InstallerSyncResult } from './installerSync.js';
import { type SharedFileCommitPaths, type SharedFileSnapshot } from './sharedFileCommit.js';
export declare const INSTALLER_TRANSACTION_SCHEMA = "evolver.installer.transaction.v1";
export type InstallerTransactionState = 'prepared' | 'applying' | 'committed' | 'rollback_pending' | 'rolled_back' | 'released';
export interface InstallerTransactionTarget {
    id: string;
    paths: string[];
}
interface Artifact {
    path: string;
    target: string;
    before: SharedFileSnapshot;
    current: SharedFileSnapshot;
}
interface Step {
    artifact: number;
    before: SharedFileSnapshot;
    nextRaw: string | null;
    paths: SharedFileCommitPaths;
    prepared?: SharedFileSnapshot;
    displaced?: SharedFileSnapshot;
    publicationAttempted?: true;
    retainedOriginal?: true;
    published?: SharedFileSnapshot;
    finished?: boolean;
}
interface Journal {
    schema: typeof INSTALLER_TRANSACTION_SCHEMA;
    id: string;
    root: string;
    binding: string;
    state: InstallerTransactionState;
    targets: InstallerTransactionTarget[];
    completed: string[];
    artifacts: Artifact[];
    steps: Step[];
    metadata: unknown;
    blocked: string[];
}
export interface InstallerTransactionSummary {
    schema: typeof INSTALLER_TRANSACTION_SCHEMA;
    transaction_id: string;
    state: InstallerTransactionState;
    complete: boolean;
    completed_target_ids: string[];
    blocked_target_ids: string[];
    /** Display references only; active filesystem consumers use InstallerTransaction.retainedPaths. */
    retained_paths?: string[];
    targets: {
        target_id: string;
        target_ref: string;
        committed: boolean;
        verified: boolean;
    }[];
    recovery: ('resume' | 'rollback' | 'accept-current')[];
    resolution_digest?: string;
    state_durable?: boolean;
    runtime?: string;
    scope?: 'user' | 'project';
    action?: 'install' | 'uninstall';
}
export declare function installerTransactionFromError(error: unknown): InstallerTransactionSummary | undefined;
export interface InstallerTransactionOptions {
    root: string;
    id: string;
    binding?: string;
    targets?: InstallerTransactionTarget[];
    metadata?: unknown;
    validatePrepared?: (artifacts: readonly {
        path: string;
        target: string;
        identity: SharedFileSnapshot['identity'];
    }[]) => boolean;
}
export declare class InstallerTransactionError extends Error {
    readonly code: 'TRANSACTION_INVALID' | 'TRANSACTION_PENDING' | 'TRANSACTION_CONFLICT' | 'TRANSACTION_IO';
    readonly transaction?: InstallerTransactionSummary | undefined;
    constructor(code: 'TRANSACTION_INVALID' | 'TRANSACTION_PENDING' | 'TRANSACTION_CONFLICT' | 'TRANSACTION_IO', message: string, transaction?: InstallerTransactionSummary | undefined, options?: {
        cause?: unknown;
    });
}
interface Loaded {
    journal: Journal;
    sequence: number;
    digest: string;
}
export declare function inspectInstallerTransactions(root: string, id?: string): InstallerTransactionSummary[];
export declare class InstallerTransaction {
    private readonly root;
    private readonly journal;
    private selected?;
    private verifying?;
    private released;
    rollbackOnError: boolean;
    private assertActive;
    armRollback(): void;
    private sequence;
    private digest;
    private stateUnconfirmed;
    private readonly directory;
    constructor(root: string, journal: Journal, loaded?: Loaded);
    releaseDirectory(): void;
    get status(): InstallerTransactionSummary;
    /** Private backup consumers keep the original paths; public summaries contain only safe references. */
    get retainedPaths(): readonly string[];
    get metadata(): unknown;
    get targets(): readonly InstallerTransactionTarget[];
    get binding(): string;
    hasCompleted(id: string): boolean;
    wasChanged(id: string): boolean;
    private save;
    private conflict;
    private publicationAttempted;
    private canRebase;
    private rebase;
    private observer;
    /** Resolve writes that reached publication but crashed before their durable receipt. */
    private reconcile;
    assertCurrent(): void;
    runTarget<T>(id: string, run: () => InstallerSyncResult<T>, verify: () => boolean): T;
    markRollbackBlocked(): void;
    private cleanupScratch;
    verifyUninstall(verify: () => boolean): boolean;
    commit(verify: () => boolean): void;
    private restoreTargets;
    /** Explicitly acknowledge a reviewed manual reconciliation. No runtime file or ownership backup is changed. */
    acceptCurrent(expectedDigest: string): InstallerTransactionSummary;
    rollback(): InstallerTransactionSummary;
}
/** One scope-wide lease covers preparation, target execution, recovery and journal publication. */
export declare function withInstallerTransaction<T>(options: InstallerTransactionOptions, run: (transaction: InstallerTransaction) => InstallerSyncResult<T>): T;
export {};