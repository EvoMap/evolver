import type { AssetRecord, AssetKind, SearchQuery, PutResult } from '../assetstore/provider.js';
import type { Envelope } from '../mailbox/envelope.js';
import type { AgentDirectoryCapability } from './agentDirectory.js';
/** publish 投递回执. hub 侧做 gate(经济/治理/RBAC 全在 hub), core 只读 status+reason. */
export interface PublishReceipt {
    /** hub 返回的回执 id(公版=AgentEvent/decision id; 私有=审计 id). */
    receiptId: string;
    /** hub gate 决议. quarantine 仅公版可能出现, core 当 rejected 的软态处理. */
    status: 'accepted' | 'rejected' | 'quarantine';
    /** rejected/quarantine 时的人读原因(core 不解释经济/治理语义, 原样回灌 Material). */
    reason?: string;
    /** hub 计算后的 asset_id(必须与 core normalizeForPut 逐字节一致, 命门, conformance 校验). */
    assetId?: string;
    /** bundle 发布: hub 返回的 bundle_id + 全资产 asset_id(实测公版 /a2a/publish 收 [Gene,Capsule,Event] 捆绑). */
    bundleId?: string;
    assetIds?: string[];
    /** 终态标记: true=不可重试(reject/quarantine/402), SyncEngine 不得 incrementRetry(money-safety risk). */
    terminal?: boolean;
    /** M8-1: 公版经济侧只读回执(core 不解释经济语义, 仅透传供观测/UI). private hub 多为空. */
    economic?: {
        creditShortage?: boolean;
        required?: number;
        available?: number;
        balanceKind?: 'user_balance' | 'node_balance';
        gdiScore?: number;
    };
}
/** 资产查询. 复用 assetstore SearchQuery, 不发明第二套查询 DSL. */
export type HubQuery = SearchQuery;
/** task 子系统事件(订阅流元素). 公版含经济上下文(bounty/credit), 私有仅 workflow. */
export interface TaskEvent {
    taskId: string;
    type: string;
    payload: unknown;
    priority: 'high' | 'medium' | 'low';
    createdAt: number;
}
/**
 * Explicit task identity needed by hubs whose completion wire does not use their
 * adapter-specific claim handle. claimId remains opaque and must never be parsed
 * to recover either field.
 */
export interface TaskCompleteContext {
    taskId: string;
    assetId: string;
}
/** Proactive Hub question that a runtime may submit for ecosystem help. */
export interface HubQuestion {
    question: string;
    amount?: number;
    signals?: readonly string[];
}
/** Flexible receipt for hubs that turn submitted questions into tasks/bounties. */
export interface QuestionSubmitReceipt {
    question?: string;
    taskId?: string;
    bountyId?: string;
    error?: string;
    raw?: unknown;
}
/** mailbox 通用事件. inbound 用 hub 原始 wire shape, 由 adapter 翻成 core Envelope 落 MailboxStore. */
export interface AgentEvent {
    id: string;
    type: string;
    payload: unknown;
    priority: 'high' | 'medium' | 'low';
    cursor?: string;
    createdAt: number;
    refId?: string;
    expiresAt?: number;
}
export interface MailboxPushOutcome {
    id: string;
    status: 'accepted' | 'failed';
    reason?: string;
    retryable?: boolean;
    terminal?: boolean;
    retryAfterMs?: number;
    raw?: unknown;
}
export interface MailboxPushManyResult {
    outcomes: MailboxPushOutcome[];
}
/**
 * mailbox.poll 结果. **焊入短轮询背压**(对应 hub issue #1195 的 next_poll_after_ms 提案):
 * hub 给出建议的下次轮询间隔, SyncEngine 优先遵守(有事件→0/有 backlog→小, 空→大, 降载→更大),
 * 缺省时回退 SyncEngine 默认节奏. 这让 adapter 对 hub 长轮询→短轮询迁移**零改动前向兼容**.
 */
export interface MailboxPollResult {
    events: AgentEvent[];
    /** hub 建议下次 poll 间隔 ms(#1195). 缺省=adapter 用默认节奏. */
    nextPollAfterMs?: number;
    /** 还有更多 backlog 未拉完 → adapter 应 drain 而非 idle(防限流饿死). */
    hasMore?: boolean;
}
export type ReuseResultOutcome = 'success' | 'failed' | 'mismatched' | 'stale' | 'unsafe';
/** Reuse outcome report. Hub owns attribution, RBAC, and audit policy; runtime only forwards the claim. */
export interface ReuseResultReport {
    assetId: string;
    outcome: ReuseResultOutcome;
    taskId?: string;
    traceId?: string;
    /** Deprecated compatibility field. A scalar without measurement metadata is self-reported and must not count as ROI. */
    tokensSaved?: number;
    timeSavedSeconds?: number;
    reason?: string;
}
/** Reuse-result reporting is best-effort; failures must not break fetch or solve paths. */
export interface ReuseResultReceipt {
    recorded: boolean;
    reason?: string;
    id?: string;
}
export type LearningAssetType = 'memory' | 'skill' | 'playbook' | 'eval';
export type LearningAssetStatus = 'pending_review' | 'active' | 'disabled' | 'stale' | 'archived';
export type LearningAssetEffectiveStatus = LearningAssetStatus | 'expired';
export type LearningAssetUsageOutcome = ReuseResultOutcome;
export interface LearningAssetOwner {
    node_id?: string | null;
    user_id?: string | null;
    org_id?: string | null;
    workspace_id?: string | null;
}
/** Hub-owned learning asset record. Core keeps it opaque; adapters own wire shape and auth. */
export interface LearningAssetRecord {
    asset_id: string;
    type: LearningAssetType;
    source_packet_id?: string;
    scope?: string[];
    owner?: LearningAssetOwner;
    title?: string;
    summary?: string;
    confidence?: number;
    last_used_at?: string | null;
    usage_count?: number;
    success_count?: number;
    success_rate?: number;
    expires_at?: string | null;
    conflicts_with?: string[];
    status?: LearningAssetStatus;
    effective_status?: LearningAssetEffectiveStatus;
    status_reason?: string;
    provenance?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    created_at?: string | null;
    updated_at?: string | null;
    [k: string]: unknown;
}
export interface LearningAssetListOptions {
    type?: LearningAssetType;
    scope?: readonly string[];
    status?: LearningAssetStatus | readonly LearningAssetStatus[];
    includeExpired?: boolean;
    includePayload?: boolean;
    limit?: number;
}
export interface LearningAssetListResult {
    assets: LearningAssetRecord[];
    limit: number;
    reason?: string;
}
export interface LearningAssetUsageReport {
    assetId?: string;
    usedAssetIds?: readonly string[];
    outcome: LearningAssetUsageOutcome;
    score?: number;
    sourceEventId: string;
    reason?: string;
}
export interface LearningAssetUsageResultRow {
    asset_id: string;
    recorded: boolean;
    duplicated?: boolean;
    error?: string;
    [k: string]: unknown;
}
/** Learning-asset usage reporting is best-effort; failures must not break runtime solve paths. */
export interface LearningAssetUsageReceipt {
    recorded: boolean;
    reason?: string;
    results: LearningAssetUsageResultRow[];
}
/**
 * Pre-publish dry-run result. The hub runs the same hub-side quality + content-safety
 * gate as publish but stores nothing and charges no credits, so an agent can check a
 * bundle before paying to publish. Proxy callers sanitize and leak-check before invoking
 * hub validate, mirroring the publish path. A dry-run is never a dependency of a cycle,
 * so the adapter degrades every failure (quality/safety reject, 5xx, network) to
 * valid:false.
 */
export interface ValidateReceipt {
    valid: boolean;
    /** Human-readable rejection cause when valid:false (hub quality/safety reason, or transport error). */
    reason?: string;
    /** hub 原始 payload 透传(target_asset_id / content_safety_warning / privacy_guidance 等); core 不解释. */
    raw?: unknown;
}
export type RecipeAssetType = 'Gene' | 'Capsule';
/** A recipe step references an owned Gene/Capsule asset by content id. */
export interface RecipeStep {
    assetId: string;
    assetType: RecipeAssetType;
    position?: number;
}
/** Create a draft recipe; publishing is a separate explicit action. */
export interface RecipeCreateRequest {
    title: string;
    steps: readonly RecipeStep[];
    description?: string;
    pricePerExecution?: number;
    currency?: string;
    maxConcurrent?: number;
    idempotencyKey?: string;
}
export interface RecipePublishOptions {
    idempotencyKey?: string;
}
export interface RecipeReceipt {
    recipeId?: string;
    status?: string;
    raw: unknown;
}
export interface RecipeFetchReceipt extends RecipeReceipt {
    recipe?: unknown;
}
export interface RecipeExpressRequest {
    inputPayload?: Record<string, unknown>;
}
export interface RecipeExpressionReceipt extends RecipeReceipt {
    organismId?: string;
}
/** Optional Hub recipe/DNA capability. Core stays wire-agnostic; adapters own REST shape. */
export interface RecipeCapability {
    create(request: RecipeCreateRequest): Promise<RecipeReceipt>;
    publish(recipeId: string, options?: RecipePublishOptions): Promise<RecipeReceipt>;
    get(recipeId: string): Promise<RecipeFetchReceipt>;
    express(recipeId: string, request?: RecipeExpressRequest): Promise<RecipeExpressionReceipt>;
}
export type HubCapabilityName = 'publish' | 'fetch' | 'search' | 'task' | 'mailbox' | 'auth' | 'audit' | 'air_gap' | 'tenant_isolation' | 'marketplace' | 'economy' | 'questions' | 'recipes' | 'agent_directory' | 'learning_assets';
/** hub 能力清单(可选). core 据此动态适配 UI/行为, "按需耦合". */
export interface HubManifest {
    capabilities: HubCapabilityName[] | string[];
    protocolVersion: string;
    economyEnabled?: boolean;
    authKinds?: CredentialKind[];
    /** enterprise/public 差异表达为能力与策略, core 不分支判断 edition/repo. */
    auditEnabled?: boolean;
    airGap?: boolean;
    tenantIsolation?: boolean;
    marketplaceAccess?: boolean;
}
export type CredentialKind = 'oauth_device_token' | 'keypair' | 'enterprise_sso';
export type Credential = {
    id: string;
    kind: CredentialKind;
    device?: string;
    publicKey?: string;
    expiresAt?: number;
    refreshToken?: string;
} & ({
    token: string;
} | {
    privateKey: string;
});
/** 给一个待发请求加凭证/签名后的结果(adapter 注入 HTTP 层). */
export interface SignedRequest {
    headers: Record<string, string>;
    bodySignature?: string;
    /** 注入请求体的凭证字段(gep-a2a: node_secret 走 body 而非 header — 实测 dev 契约). */
    bodyFields?: Record<string, unknown>;
}
/** 待签请求的最小描述. */
export interface HttpRequestLike {
    method: string;
    path: string;
    body?: string;
}
/**
 * Pluggable auth. Example implementations: public OAuth device token / Ed25519 keypair / enterprise SSO (OIDC/LDAP).
 * node_secret dual-track transition is wrapped by LegacyAuthShim. (The enterprise SSO impl lives in the enterprise repo; the public repo only defines the interface.)
 */
export interface AuthProvider {
    kind: CredentialKind;
    /** 首次认证: 浏览器 OAuth / device code flow / 无头 keypair. 持久化到 ~/.evomap. */
    login(): Promise<Credential>;
    /** 给请求加凭证/签名(每个出站 HTTP 调一次). 审计级动作必须 keypair 签 body. */
    authenticate(req: HttpRequestLike): Promise<SignedRequest>;
    /** 轮换. token 自动(提前 6h); keypair 用旧私钥签 revoke 后换新. */
    rotate(): Promise<Credential>;
    /** 撤销凭证(机器丢失/泄露). */
    revoke(credentialId: string): Promise<void>;
}
export interface HubCapability {
    /**
     * 异步发布. 公版 /a2a/publish 收 **bundle**[Gene,Capsule,(EvolutionEvent)](一个 cycle 的产物一起发, +GDI);
     * 传单资产=[asset]。core 已 normalizeForPut(算/校验 asset_id), hub 做经济/治理/质量 gate。
     */
    publish(bundle: AssetRecord[]): Promise<PublishReceipt>;
    /** 拉取资产. hub 侧排序/scope(公版 GDI, 私有 RBAC); core 不重排. */
    fetch(query: HubQuery): Promise<AssetRecord[]>;
    /** 搜索资产. 与 fetch 同 shape, 差异在 hub 侧召回策略. */
    search(query: HubQuery): Promise<AssetRecord[]>;
    /** 可选: 按 content-addressed asset_id 拉单个 full asset. private adapter/proxy 用它保证只 fetch 一个 winner. */
    fetchAssetById?(assetId: string): Promise<AssetRecord | null>;
    /** 可选: 报告某个资产被复用后的结果. PHub/enterprise adapter 实现; 不支持时 runtime 应明确降级. */
    recordReuseResult?(report: ReuseResultReport): Promise<ReuseResultReceipt>;
    /** 可选: 列出 hub 端 runtime learning assets. Missing means the adapter does not support this MVP surface. */
    listLearningAssets?(options?: LearningAssetListOptions): Promise<LearningAssetListResult>;
    /** 可选: 上报 learning asset 使用结果. Best-effort; failures must never break solve paths. */
    recordLearningAssetUsage?(report: LearningAssetUsageReport): Promise<LearningAssetUsageReceipt>;
    /**
     * 可选: 发布前 dry-run 校验(公版 POST /a2a/validate). 跑与 publish 相同的 hub 端质量门禁 + 内容安全扫描,
     * 但不落库、不计费; 经由 Proxy 暴露时调用方需先执行与 publish 相同的客户端脱敏/泄漏拦截.
     * 让 agent 在花 credits 发布前先确认. 不支持的 hub 不实现此方法; proxy/runtime 据此降级.
     */
    validate?(bundle: AssetRecord[]): Promise<ValidateReceipt>;
    /** task 子系统. 公版含经济(在 hub), 私有仅内部 workflow; core 两边同接口. */
    task: {
        claim(taskId: string): Promise<{
            claimId: string;
        }>;
        complete(claimId: string, result: unknown, context?: TaskCompleteContext): Promise<{
            status: 'completed';
        }>;
        subscribe(filter: unknown): AsyncIterable<TaskEvent>;
    };
    /** Optional proactive question seam. Public Hub currently accepts these on /a2a/fetch payload.questions. */
    questions?: {
        submit(questions: readonly HubQuestion[]): Promise<QuestionSubmitReceipt[]>;
    };
    /** Optional recipe/DNA seam. Recipe creation is draft-first; publishing remains explicit. */
    recipes?: RecipeCapability;
    /** Optional agent discovery seam. Missing means the adapter does not support directory/profile discovery. */
    agentDirectory?: AgentDirectoryCapability;
    /** mailbox 队列. poll/ack/push/status 四端点解耦(公版 /a2a/mailbox/*). */
    mailbox: {
        poll(): Promise<MailboxPollResult>;
        ack(eventId: string): Promise<void>;
        push(event: AgentEvent): Promise<void>;
        pushMany?(events: readonly AgentEvent[]): Promise<void | MailboxPushManyResult>;
        status(): Promise<{
            pending: number;
        }>;
    };
    /** 可插拔认证. proxy 持唯一凭证代调; core 只经此签请求, 不碰密钥存储. */
    auth: AuthProvider;
    /** 可选: hub 广告支持的能力, core 动态适配. 缺省时 core 假设全能力在线. */
    capabilities?(): Promise<HubManifest>;
}
/**
 * HubCapability 接到 core 两个 seam 的工厂(adapter 不直接 new Dispatcher):
 * - asProxyHandler: 包成 Dispatcher.handlers.proxy(e: Envelope)=>Promise<unknown>, 按 e.type
 *   路由到 publish / task 子系统 / mailbox.push; 抛错触发 store.fail() 重试.
 * - asAssetTransport: 包成 assetstore RemoteTransport(put/get/search/list), 落库前 core normalizeForPut.
 */
export interface HubBindings {
    asProxyHandler(): (e: Envelope) => Promise<unknown>;
    asAssetTransport(): {
        putRemote(record: AssetRecord): Promise<{
            stored: boolean;
        }>;
        getRemote(assetId: string): Promise<AssetRecord | null>;
        searchRemote(query: HubQuery): Promise<AssetRecord[]>;
        listRemote(kind: AssetKind | undefined, limit: number): Promise<AssetRecord[]>;
    };
}
export type { AssetRecord, AssetKind, SearchQuery, PutResult, Envelope };