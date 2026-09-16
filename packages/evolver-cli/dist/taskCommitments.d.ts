import { AtpHubClient } from '@evomap/evolver-adapter-public';
/**
 * A claim is a promise, and this file is where the promises live: the execute-queue entry a
 * claimed task becomes, the ledger of what is still owed, and the wiring that keeps or
 * re-files each debt. Choosing which task to take is the receiver's job, not this one's.
 */
/** The execute-queue record a claimed Hub task becomes. */
export interface QueueTask {
    id: string;
    hubTaskId: string;
    /** Which filing of this queue id this is. Tells a late result from the current one. */
    generation: string;
    repo: string;
    target: string;
    expectedEffect: string;
    signals: string[];
    commitmentDeadline?: string;
}
export interface QueueRetryResult {
    retried: number;
    queued: number;
    pending: number;
    /** Claims let go of: the commitment ran out, or the queue name never came free. */
    dropped: number;
}
export interface CompletionRetryResult {
    retried: number;
    completed: number;
    abandoned: number;
    pending: number;
    /** Outcomes the ledger would not take. The next run will see a stale picture. */
    unrecorded: number;
    /** Deliveries given up on. They are gone from the ledger, so they must be said out loud. */
    abandonedTasks: Array<{
        taskId: string;
        resultAssetId: string;
        lastError: string;
    }>;
}
export interface CompletedTask {
    /** The Hub was told, but the ledger would not take the update. The next run sees stale state. */
    unrecorded?: boolean;
    taskId: string;
    completed: boolean;
    error?: string;
    /** The report could not be delivered and is now owed to the Hub on a later beat. */
    pending?: boolean;
}
export interface PendingCompletion {
    /** Which filing this debt belongs to. A late report from an earlier one is not it. */
    generation?: string;
    taskId: string;
    resultAssetId: string;
    attempts: number;
    nextAttemptMs: number;
    lastError?: string;
}
export interface PendingClaim {
    taskId: string;
    queueTask: QueueTask;
    attempts: number;
    lastError?: string;
}
/** A claim this node holds, keyed by the execute-queue id it was filed under. */
export interface OwnedClaim {
    queueTaskId: string;
    hubTaskId: string;
    generation: string;
    commitmentDeadline?: string;
}
export interface PendingCompletionLedger {
    version: 1;
    pending: Record<string, PendingCompletion>;
    /** Claims the Hub granted that never reached the execute queue. */
    unqueued?: Record<string, PendingClaim>;
    /**
     * Queue ids this receiver really claimed from the Hub. The `hub-` prefix is only a
     * naming convention — a local task is free to use it — so the register, not the id,
     * is what says a queue entry is remote work under a commitment.
     */
    owned?: Record<string, OwnedClaim>;
}
export declare const COMPLETION_LEDGER_FILENAME = "task-complete-pending.json";
export declare function completionLedgerPath(env?: NodeJS.ProcessEnv): string;
export declare function readCompletionLedger(path: string): PendingCompletionLedger;
export declare function rememberUnqueued(path: string, queueTask: QueueTask, error: string): void;
/** Queue ids the receiver writes carry this prefix, so the loop can tell hub work apart. */
export declare const HUB_QUEUE_PREFIX = "hub-";
/** A task id becomes a filename, so it may only be what a filename may safely be. */
/** The queue entry already under this id, or null when there is none we can read. */
export declare function defaultReadQueueTask(dir: string, id: string): QueueTask | null;
export declare function defaultWriteQueueTask(dir: string, task: QueueTask): void;
export declare function defaultRemoveQueueTask(dir: string, id: string): void;
type FileOutcome = 'written' | 'name_taken' | 'unrecorded';
/**
 * File a claimed task under its queue id. An `EEXIST` is only "an earlier beat already did
 * this" when the register says that queue id is ours; otherwise the name belongs to a local
 * task, and treating the collision as success would hand its capsule to the Hub.
 */
export declare function fileClaim(deps: CommitmentDeps, queueDir: string, claim: QueueTask): FileOutcome;
/**
 * Wire a receive pass into the resident loop. It stays off without a node
 * identity or an allowlisted repo: claiming a task this daemon cannot execute
 * is a promise to the Hub we would break.
 */
/** What a receiver can do about promises already made, on or off. */
export interface CommitmentWiring {
    /**
     * Report a finished task back to the Hub. A claim is a promise; the Hub only
     * learns it was kept when the produced asset comes back.
     */
    complete: (taskId: string, resultAssetId: string, generation?: string) => Promise<CompletedTask>;
    /** Re-send reports the Hub never acknowledged. Due entries only, oldest backoff first. */
    retryCompletions: () => Promise<CompletionRetryResult>;
    /** Re-file claims that never reached the execute queue. The claim is already spent. */
    retryQueueWrites: () => Promise<QueueRetryResult>;
    /**
     * The Hub claim behind an execute-queue id, or null when that id is not remote work.
     * A local task is free to be named `hub-anything`; only a registered claim is ours.
     */
    claimFor: (queueTaskId: string) => OwnedClaim | null;
}
export interface CommitmentDeps {
    read?: (dir: string, id: string) => QueueTask | null;
    ledgerPath: string;
    now: () => number;
    queueDir?: string;
    write: (dir: string, task: QueueTask) => void;
    remove?: (dir: string, id: string) => void;
}
export declare function unsentCommitments(ledgerPath: string, now: () => number): CommitmentWiring;
export declare function liveCommitments(client: AtpHubClient, deps: CommitmentDeps): CommitmentWiring;
/** The Hub task id behind an execute-queue id, or null when the task is local. */
export declare function hubTaskIdOf(queueTaskId: string): string | null;
export {};