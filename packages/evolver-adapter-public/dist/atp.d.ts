import type { hub } from '@evomap/evolver-core';
import { ATP_EXECUTION_MODES, ATP_PROOF_STATUSES, ATP_ROLES, ATP_ROUTING_MODES, ATP_VERIFY_ACTIONS, ATP_VERIFY_MODES } from '@evomap/atp-sdk';
import { type FetchLike } from './hubFetch.js';
export { ATP_EXECUTION_MODES, ATP_PROOF_STATUSES, ATP_ROLES, ATP_ROUTING_MODES, ATP_VERIFY_ACTIONS, ATP_VERIFY_MODES, };
export type AtpVerifyMode = (typeof ATP_VERIFY_MODES)[number];
export type AtpVerifyAction = (typeof ATP_VERIFY_ACTIONS)[number];
export type AtpRoutingMode = (typeof ATP_ROUTING_MODES)[number];
export type AtpProofStatus = (typeof ATP_PROOF_STATUSES)[number];
export type AtpRole = (typeof ATP_ROLES)[number];
export type AtpExecutionMode = (typeof ATP_EXECUTION_MODES)[number];
export interface AtpResult<T = unknown> {
    ok: boolean;
    data?: T;
    error?: string;
    status?: number;
}
export interface AtpOrderOptions {
    capabilities: readonly string[];
    budget?: number;
    routingMode?: AtpRoutingMode | string;
    verifyMode?: AtpVerifyMode | string;
    question?: string;
    signals?: readonly string[];
    minReputation?: number;
}
export interface AtpListProofsOptions {
    nodeId?: string;
    role?: AtpRole | string;
    status?: AtpProofStatus | string;
    limit?: number;
}
export interface HubTaskFetchOptions {
    limit?: number;
    /** Questions to piggyback on the fetch; the Hub may turn them into bounties. */
    questions?: readonly {
        question: string;
        amount?: number;
        signals?: readonly string[];
    }[];
    /**
     * The envelope id the Hub dedupes on. Override it only to make two identical question
     * sets deliberately distinct; an ordinary retry needs nothing, because a fetch carrying
     * `questions` derives its id from the questions themselves and so repeats it.
     */
    messageId?: string;
}
export interface HubTaskClaimOptions {
    commitmentDeadline?: string;
}
export interface AtpClientOptions {
    baseUrl: string;
    auth: hub.AuthProvider;
    fetchFn: FetchLike;
    senderId: () => string | undefined;
}
export declare class AtpHubClient {
    private readonly opts;
    private readonly http;
    constructor(opts: AtpClientOptions);
    /**
     * The node every call of this client speaks for. Ownership checks must read it from
     * here rather than resolve their own: a filter that answers about a different node
     * than the one submitting is how work gets skipped or handed to the wrong claimant.
     */
    nodeId(): string | undefined;
    /**
     * The node id every task-protocol write is made under. These calls take and hand back
     * work on one node's behalf, so a request that cannot name that node is not a weaker
     * request — it is an unattributable one, and the Hub should never be asked to guess.
     */
    private requireSenderId;
    placeOrder<T = unknown>(opts: AtpOrderOptions): Promise<AtpResult<T>>;
    submitDelivery<T = unknown>(orderId: string, proofPayload?: unknown): Promise<AtpResult<T>>;
    verifyDelivery<T = unknown>(orderId: string, action?: AtpVerifyAction | string): Promise<AtpResult<T>>;
    settleOrder<T = unknown>(orderId: string): Promise<AtpResult<T>>;
    disputeOrder<T = unknown>(orderId: string, reason: string): Promise<AtpResult<T>>;
    getMerchantTier<T = unknown>(nodeId?: string): Promise<AtpResult<T>>;
    getOrderStatus<T = unknown>(orderId: string): Promise<AtpResult<T>>;
    listProofs<T = unknown>(opts?: AtpListProofsOptions): Promise<AtpResult<T>>;
    getAtpPolicy<T = unknown>(): Promise<AtpResult<T>>;
    listMyTasks<T = unknown>(limit?: number, nodeId?: string): Promise<AtpResult<T>>;
    /**
     * Available tasks the Hub is willing to hand this node. The Hub answers the
     * A2A `fetch` envelope with a `tasks` array; `tasks_only` keeps it from
     * piggybacking anything else onto the response.
     */
    fetchTasks<T = unknown>(opts?: HubTaskFetchOptions): Promise<AtpResult<T>>;
    /**
     * The id the Hub dedupes envelopes on. A plain read has no side effect and gets a fresh
     * id; a fetch carrying `questions` can create bounties, so its id is derived from the
     * questions themselves — retrying the same ask after a lost response repeats the id and
     * the Hub recognises it, instead of posting the same question a second time.
     */
    private static envelopeIdFor;
    /**
     * Take a task. `commitmentDeadline` is the promise the node makes back: the
     * Hub holds the task for this node until then, so a caller that cannot
     * finish in time must not send one it cannot keep.
     */
    claimTask<T = unknown>(taskId: string, opts?: HubTaskClaimOptions): Promise<AtpResult<T>>;
    /** Hand a claimed task back to the Hub with the asset the work produced. */
    completeTask<T = unknown>(taskId: string, assetId: string): Promise<AtpResult<T>>;
    /**
     * Take a deferred worker task. The Hub gates this channel separately from
     * `/a2a/task/claim` and answers `worker_disabled` while it is closed.
     */
    claimWorkerTask<T = unknown>(taskId: string): Promise<AtpResult<T>>;
    /** Hand a worker task back with the asset it produced. */
    completeWorkerTask<T = unknown>(taskId: string, assetId: string): Promise<AtpResult<T>>;
    private callResult;
}
export declare function normalizeAtpResult<T = unknown>(raw: unknown): AtpResult<T>;