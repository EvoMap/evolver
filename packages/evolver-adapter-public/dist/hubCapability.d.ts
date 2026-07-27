import { type hub } from '@evomap/evolver-core';
import { type FetchLike } from './hubFetch.js';
import { type AntiAbuseTelemetryOptions } from './antiAbuseTelemetry.js';
export declare const INBOUND_LIMIT = 100;
export declare const OUTBOUND_MAX_BATCH = 50;
export declare const OUTBOUND_MAX_BODY_BYTES: number;
export declare const PUBLIC_PROTOCOL_VERSION = "gep-a2a/1.0.0";
export declare const PUBLIC_HUB_CAPABILITIES: hub.HubCapabilityName[];
export declare const USED_ASSET_IDS_MAX = 50;
export declare const USED_ASSET_ID_MAX_LEN = 200;
export declare const LEARNING_ASSET_IDS_MAX = 50;
export declare const LEARNING_ASSET_ID_MAX_LEN = 128;
/**
 * An outcome the agent reports back to the hub's memory graph after a cycle.
 * `usedAssetIds` is the fetch->outcome attribution claim: which hub assets the
 * agent actually APPLIED while producing this outcome. The hub treats the list
 * as a claim, never a fact — each id is cross-verified server-side against its
 * own fetch ledger (the asset must really have been fetched by this node,
 * cross-owner, before the outcome). Without this claim the hub cannot attribute
 * outcomes to assets at all, so reuse never credits the publisher.
 */
export interface OutcomeReport {
    signals: readonly string[];
    status: 'success' | 'failed';
    geneId?: string;
    score?: number;
    summary?: string;
    usedAssetIds?: readonly string[];
}
/** recordOutcome never throws: failures come back as `recorded:false` + reason. */
export interface OutcomeReceipt {
    recorded: boolean;
    reason?: string;
}
export type MemoryGraphEventKind = 'attempt' | 'validation' | 'skill_emit' | 'outcome' | 'mutation_draft' | 'solidify';
export interface MemoryGraphEventReport {
    kind: MemoryGraphEventKind;
    event: Record<string, unknown>;
}
/** recordMemoryEvent never throws: failures come back as `recorded:false` + reason. */
export interface MemoryGraphEventReceipt {
    recorded: boolean;
    reason?: string;
}
export type AccountAssetScope = 'purchased' | 'published';
export type AccountAssetTypeFilter = 'Gene' | 'Capsule';
export type AccountAssetStatusFilter = 'draft' | 'promoted' | 'all';
export interface AccountAssetListOptions {
    scope: AccountAssetScope;
    type?: AccountAssetTypeFilter;
    status?: AccountAssetStatusFilter;
    limit?: number;
    cursor?: string;
}
export interface AccountAssetListResult {
    assets: hub.AssetRecord[];
    count?: number;
    hasMore: boolean;
    nextCursor?: string;
}
/** 完整 GEP-A2A 信封(实测 dev: publish/fetch/validate 等协议消息端点必须全信封, 非仅 protocol+message_type). */
export declare function gepEnvelope(messageType: string, payload: unknown): Record<string, unknown>;
export interface PublicHubOptions {
    baseUrl: string;
    auth: hub.AuthProvider;
    fetchFn: FetchLike;
    senderId: () => string | undefined;
    /** task.subscribe 轮询节奏(默认 10s). */
    subscribePollMs?: number;
    /** Public Hub anti-abuse heartbeat metadata. Defaults to env-controlled heartbeat mode. */
    antiAbuse?: AntiAbuseTelemetryOptions;
}
export interface PublicHelloResult {
    ok: boolean;
    authError?: boolean;
    nodeId?: string;
    nodeSecretVersion?: number;
    rateLimitUntilMs?: number;
    error?: string;
    details?: unknown;
    retryAfterMs?: number;
    status?: string;
    httpStatus?: number;
    secretDiverged?: boolean;
}
export interface PublicHelloOptions {
    rotate: boolean;
    evolverVersion?: string;
    /** Keep trust probes from adopting or clearing local credential state. */
    preserveCredentials?: boolean;
}
export interface PublicHeartbeatOptions {
    evolverVersion?: string;
    lastUpdate?: PublicLastUpdatePayload;
}
export interface PublicLastUpdatePayload {
    to_version: string;
    status: string;
    finished_at: number;
    from_version?: string;
    directive_id?: string;
    error?: string;
}
export interface PublicForceUpdateDirective {
    required_version?: string;
    manifest?: unknown;
    reason?: string;
    release_url?: string;
    update_channels?: readonly string[];
    directive_id?: string;
    deadline_ms?: number;
    stagger_window_ms?: number;
}
export interface PublicHeartbeatResult {
    ok: boolean;
    authError?: boolean;
    error?: string;
    details?: unknown;
    retryAfterMs?: number;
    status?: string;
    httpStatus?: number;
    lastUpdateAck?: {
        ok?: boolean;
        reason?: string;
    };
    forceUpdate?: PublicForceUpdateDirective;
}
export declare function isHubDryRunEnabled(env?: Record<string, string | undefined>): boolean;
export declare function outboundMaxBodyBytes(env?: Record<string, string | undefined>): number;
/**
 * 公版 hub 的 HubCapability 实现(M6-6). 打 /a2a/{publish,fetch,mailbox/*,events/poll}.
 * 唯一懂公版 wire shape 的地方; 经 wireMap 规约成 core 类型. 真链路冒烟在 M6-7(dev.evomap.ai).
 */
export declare class PublicHubCapability implements hub.HubCapability {
    private readonly opts;
    private readonly http;
    readonly auth: hub.AuthProvider;
    readonly recipes: hub.RecipeCapability;
    constructor(opts: PublicHubOptions);
    hello(opts: PublicHelloOptions): Promise<PublicHelloResult>;
    heartbeat(opts?: PublicHeartbeatOptions): Promise<PublicHeartbeatResult>;
    private heartbeatMeta;
    publish(bundle: hub.AssetRecord[]): Promise<hub.PublishReceipt>;
    fetch(query: hub.HubQuery): Promise<hub.AssetRecord[]>;
    fetchAssetById(assetId: string): Promise<hub.AssetRecord | null>;
    /**
     * #69: search != fetch. Free-text is the hub's vector endpoint (GET /a2a/assets/semantic-search?q=);
     * signals/id queries fall through to fetch. /a2a/fetch does NOT do semantic, so text must not go there.
     */
    search(query: hub.HubQuery): Promise<hub.AssetRecord[]>;
    agentDirectory: hub.AgentDirectoryCapability;
    listAccountAssets(opts: AccountAssetListOptions): Promise<AccountAssetListResult>;
    /**
     * Report a cycle outcome to the hub's memory graph (POST /a2a/memory/record).
     * Unlike the protocol-message endpoints (publish/fetch), memory/record takes a
     * FLAT body — no GEP envelope. Reporting is observability for the network's
     * attribution loop, never a dependency of the cycle itself, so this method
     * NEVER throws: auth/4xx/5xx/network failures all degrade to `recorded:false`.
     * Costs hub credits per the hub's memory pricing (caller gates on enablement).
     */
    recordOutcome(report: OutcomeReport): Promise<OutcomeReceipt>;
    recordMemoryEvent(report: MemoryGraphEventReport): Promise<MemoryGraphEventReceipt>;
    recordReuseResult(report: hub.ReuseResultReport): Promise<hub.ReuseResultReceipt>;
    listLearningAssets(options?: hub.LearningAssetListOptions): Promise<hub.LearningAssetListResult>;
    recordLearningAssetUsage(report: hub.LearningAssetUsageReport): Promise<hub.LearningAssetUsageReceipt>;
    /**
     * Pre-publish dry-run (POST /a2a/validate). The hub runs the same hub-side quality +
     * content-safety gate as publish but stores nothing and charges no credits. This adapter is
     * the raw HubCapability; proxy-facing callers sanitize/leak-check before invoking it so the
     * public tool matches publish's local egress guard. Like publish, the payload is the
     * {assets:[…]} bundle wrapped in a FULL GEP-A2A envelope — /a2a/validate is a strict protocol endpoint
     * (validateProtocol(["validate","publish"])) and 400s on a bare body. A dry-run is never
     * a dependency of the cycle, so this NEVER throws: quality reject (400) / content-safety
     * reject (422) / 5xx / network all degrade to { valid:false, reason }.
     */
    validate(bundle: hub.AssetRecord[]): Promise<hub.ValidateReceipt>;
    createRecipe(request: hub.RecipeCreateRequest): Promise<hub.RecipeReceipt>;
    publishRecipe(recipeId: string, options?: hub.RecipePublishOptions): Promise<hub.RecipeReceipt>;
    getRecipe(recipeId: string): Promise<hub.RecipeFetchReceipt>;
    expressRecipe(recipeId: string, request?: hub.RecipeExpressRequest): Promise<hub.RecipeExpressionReceipt>;
    task: {
        claim: (taskId: string) => Promise<{
            claimId: string;
        }>;
        complete: (claimId: string, _result: unknown, context?: hub.TaskCompleteContext) => Promise<{
            status: "completed";
        }>;
        subscribe: (filter: unknown) => AsyncIterable<hub.TaskEvent>;
    };
    questions: {
        submit: (questions: readonly hub.HubQuestion[]) => Promise<hub.QuestionSubmitReceipt[]>;
    };
    private submitQuestions;
    private subscribeTasks;
    mailbox: {
        poll: () => Promise<hub.MailboxPollResult>;
        ack: (eventId: string) => Promise<void>;
        push: (event: hub.AgentEvent) => Promise<void>;
        pushMany: (events: readonly hub.AgentEvent[]) => Promise<hub.MailboxPushManyResult>;
        status: () => Promise<{
            pending: number;
        }>;
    };
    capabilities(): Promise<hub.HubManifest>;
}