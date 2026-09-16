/**
 * taskReceiver — pulls tasks the Hub offers this node, scores them, claims the
 * one worth doing, and shapes it for the execute queue.
 *
 * Ported from evolver v1 (`src/gep/taskReceiver.js`), which v2 dropped: the
 * adapter kept `listMyTasks` but nothing could fetch, score, claim or complete,
 * so a v2 node saw its tasks and could never take one.
 */
import { AtpHubClient } from '@evomap/evolver-adapter-public';
import { type CommitmentWiring, type OwnedClaim, type QueueTask } from './taskCommitments.js';
export { COMPLETION_LEDGER_FILENAME, HUB_QUEUE_PREFIX, completionLedgerPath, hubTaskIdOf, readCompletionLedger, type CompletedTask, type CompletionRetryResult, type OwnedClaim, type PendingClaim, type PendingCompletion, type PendingCompletionLedger, type QueueRetryResult, type QueueTask, } from './taskCommitments.js';
export declare const TASK_STRATEGIES: readonly ["greedy", "balanced", "conservative"];
export type TaskStrategy = (typeof TASK_STRATEGIES)[number];
export interface HubTask {
    task_id: string;
    title?: string;
    body?: string;
    description?: string;
    status?: string;
    claimed_by?: string | null;
    signals?: string[] | string | null;
    bounty_id?: string | null;
    bounty_amount?: number;
    complexity_score?: number | null;
    historical_completion_rate?: number | null;
    expires_at?: string | null;
    /** The Hub's own view of how long it is holding the task for its claimant. */
    commitment_deadline?: string | null;
    result_asset_id?: string | null;
}
export interface MemoryEvent {
    signals?: string[] | string | null;
    status?: string;
}
/** The cycle log as this module needs to see it: a type and whatever payload came with it. */
export interface CycleLogEvent {
    type: string;
    payload?: unknown;
}
/**
 * The node's own record of what it has finished, folded out of the cycle log: each terminal
 * cycle joined to the signals that drove it. Without this, capability matching scores every
 * task against an empty history and the strategy weights never touch a real decision.
 */
export declare function memoryEventsFromCycleLog(events: readonly CycleLogEvent[], window?: number): MemoryEvent[];
export interface TaskScore {
    composite: number;
    factors: {
        roi: number;
        capability: number;
        completion: number;
        bounty: number;
        difficulty: number;
    };
}
export declare function taskStrategy(env?: NodeJS.ProcessEnv): TaskStrategy;
export declare function minCapabilityMatch(env?: NodeJS.ProcessEnv): number;
export declare function parseSignals(signals: HubTask['signals']): string[];
/** How much this node's own history looks like the task, in [0, 1]. */
export declare function estimateCapabilityMatch(task: HubTask, memoryEvents?: readonly MemoryEvent[]): number;
export declare function localDifficultyEstimate(task: HubTask): number;
export declare function scoreTask(task: HubTask, capabilityMatch: number, strategy?: TaskStrategy): TaskScore;
export interface TaskSelection {
    task: HubTask;
    reason: 'resume' | 'scored';
    score?: TaskScore;
}
/**
 * Pick what to work on. A task this node already holds always wins — finishing
 * a commitment beats starting a better one.
 */
export declare function selectBestTask(tasks: readonly HubTask[], nodeId: string, memoryEvents?: readonly MemoryEvent[], env?: NodeJS.ProcessEnv): TaskSelection | null;
/**
 * Every task worth trying, best first. A ranked list rather than one winner: the
 * top candidate can turn out to be unusable — a lapsed commitment, a window too
 * short to promise — and one bad head must not hide the rest of the batch.
 */
export declare function rankTasks(tasks: readonly HubTask[], nodeId: string, memoryEvents?: readonly MemoryEvent[], env?: NodeJS.ProcessEnv): TaskSelection[];
/**
 * What this node can honestly promise: harder tasks get longer, but never past
 * the task's own expiry, and never a window too short to be worth claiming.
 */
export declare function estimateCommitmentDeadline(task: HubTask, now?: number): string | null;
export interface PrivacyParams {
    toolId: string;
    blobIds: string[];
}
/**
 * A privacy task carries its parameters as a fenced block in the body. Ported
 * from v1 `privacyClient.parsePrivacyParams`; the rest of that client (blob
 * upload, sealed execution) has no v2 counterpart yet.
 */
export declare function detectPrivacyTask(task: Pick<HubTask, 'body' | 'description'>): PrivacyParams | null;
/** Signals an execute-queue task should carry so the loop knows what it is. */
export declare function taskToSignals(task: HubTask): string[];
/** Same signals, plus the two a sealed-tool task needs so the loop routes it. */
export declare function taskToSignalsWithPrivacy(task: HubTask): string[];
export interface ReceiveOptions {
    nodeId: string;
    repo: string;
    /** The commitment behind a queue id, so a resume honours the promise that was made. */
    claimFor?: (queueTaskId: string) => OwnedClaim | null;
    memoryEvents?: readonly MemoryEvent[];
    env?: NodeJS.ProcessEnv;
    now?: () => number;
}
export interface ReceivedTask {
    claimed: boolean;
    reason: 'resume' | 'scored' | 'none' | 'claim_failed' | 'no_deadline' | 'fetch_failed' | 'queue_failed' | 'expired';
    /** Tasks the Hub offered this pass — the signal that fetching works at all. */
    seen: number;
    /** Offered tasks dropped because their id could not be a safe filename. */
    rejected?: number;
    task?: HubTask;
    score?: TaskScore;
    commitmentDeadline?: string | null;
    error?: string;
    queueTask?: QueueTask;
}
/**
 * One receive pass: ask, choose, claim. Returns what the execute queue should
 * run, or why nothing was taken.
 */
export declare function receiveTask(client: AtpHubClient, opts: ReceiveOptions): Promise<ReceivedTask>;
export interface TaskReceiverWiring extends CommitmentWiring {
    enabled: boolean;
    reason?: 'off' | 'no_node' | 'no_repo' | 'client_error';
    tick: () => Promise<ReceivedTask>;
}
export declare function isSafeTaskId(taskId: unknown): taskId is string;
/**
 * The Hub and the proxies in front of it serialize tasks either way, and the neighbouring
 * `/a2a/task/my` reader already accepts both. Read one shape here so a camelCase response
 * is not silently an empty task list.
 */
export declare function normalizeHubTask(raw: unknown): HubTask | null;
export interface TaskReceiverDeps {
    client?: AtpHubClient;
    repo?: string;
    queueDir?: string;
    /** Read per tick, not captured once: history the daemon writes as it runs must count. */
    memoryEvents?: () => readonly MemoryEvent[];
    /** Whether the loop is already running this queue id — a file it took is not a file lost. */
    inFlight?: (queueTaskId: string) => boolean;
    nodeId?: string;
    now?: () => number;
    completionLedgerPath?: string;
    writeQueueTask?: (dir: string, task: QueueTask) => void;
}
export declare function isTaskReceiverEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare function resolveTaskReceiver(env?: NodeJS.ProcessEnv, deps?: TaskReceiverDeps): TaskReceiverWiring;