import { hub, type reference } from '@evomap/evolver-core';
export interface ProxyFetch {
    (url: string, init: {
        method: string;
        headers: Record<string, string>;
        body?: string;
        signal?: AbortSignal;
    }): Promise<{
        ok: boolean;
        status: number;
        json(): Promise<unknown>;
    }>;
}
export interface EvolverProxyClientOptions {
    baseUrl: string;
    token: string;
    expectedHubMode?: 'public' | 'private';
    fetchFn?: ProxyFetch;
    reloadSettings?: () => EvolverProxyClientOptions | undefined;
}
export interface ProxySearchArgs {
    text?: string;
    signalsAny?: string[];
    kind?: string;
    category?: string;
    gene?: string;
    limit?: number;
    expectedHubMode?: 'public' | 'private';
}
export interface ProxyRecipeSearchArgs {
    q?: string;
    limit?: number;
    cursor?: string;
    sort?: string;
    expectedHubMode?: 'public' | 'private';
}
export type ProxyRecipeExpressArgs = hub.RecipeExecutionInputs['express'];
export interface ProxyFetchArgs {
    assetId?: string;
    assetIds?: string[];
    expectedHubMode?: 'public' | 'private';
}
export interface ProxyAssetBundle {
    assets: unknown[];
    /** 宿主签发的 sidecar，proxy 必须验证自己的 durable ledger；客户端不自签。 */
    publish_receipt?: unknown;
    expected_hub_mode?: 'public' | 'private';
    compose_recipe?: boolean;
}
export interface ProxyAssetReverification {
    assets: unknown[];
    persist?: boolean;
    expected_hub_mode?: 'public' | 'private';
}
/** 仅用于恢复诊断，不是执行凭证或发布授权；null 表示本次调用无法确认。 */
export interface ProxyReverificationRecovery {
    stored: boolean | null;
    binding_registered: boolean | null;
    source_asset_ids: string[];
    asset_ids: string[];
}
export declare function safeReverificationRecovery(value: unknown): ProxyReverificationRecovery;
export declare class ProxyReverificationError extends Error {
    readonly recovery: ProxyReverificationRecovery;
    constructor(reason: string, recovery: unknown);
}
export interface ProxyReuseResultArgs {
    assetId: string;
    outcome: 'success' | 'failed' | 'mismatched' | 'stale' | 'unsafe';
    taskId?: string;
    traceId?: string;
    /** Deprecated compatibility field. Scalar self-reported savings are not forwarded as audited ROI. */
    tokensSaved?: number;
    timeSavedSeconds?: number;
    reason?: string;
    expectedHubMode?: 'public' | 'private';
}
export interface ProxyAgentSearchArgs {
    query?: string;
    signals?: string[];
    availability?: string;
    sort?: string;
    order?: string;
    cursor?: string;
    limit?: number;
    timeoutMs?: number;
}
export interface ProxyAgentDiscoverArgs extends ProxyAgentSearchArgs {
    title: string;
    description?: string;
}
export declare class EvolverProxyClient {
    private baseUrl;
    private token;
    private readonly fetchFn;
    private readonly expectedHubMode?;
    private readonly reloadSettings;
    constructor(opts: EvolverProxyClientOptions);
    status(opts?: {
        signal?: AbortSignal;
    }): Promise<unknown>;
    reference(operation: 'import' | 'fetch' | 'search' | 'context', input: {
        batch?: unknown;
        query?: reference.ReferenceQuery;
        max_chars?: number;
    }): Promise<unknown>;
    search(args: ProxySearchArgs): Promise<unknown>;
    searchRecipes(args: ProxyRecipeSearchArgs): Promise<unknown>;
    expressRecipe(args: ProxyRecipeExpressArgs): Promise<hub.RecipeExecutionOutputs['express']>;
    recipeExecution<K extends hub.RecipeExecutionOperation>(operation: K, input: hub.RecipeExecutionInputs[K]): Promise<hub.RecipeExecutionOutputs[K]>;
    private callRecipe;
    private recipeIdentity;
    private assertRecipeIdentity;
    private recipeResult;
    fetchAsset(args: ProxyFetchArgs): Promise<unknown>;
    searchAgents(args: ProxyAgentSearchArgs): Promise<unknown>;
    getAgentProfile(agentId: string, timeoutMs?: number): Promise<unknown>;
    discoverAgentsForTask(args: ProxyAgentDiscoverArgs): Promise<unknown>;
    submitAsset(asset: unknown): Promise<unknown>;
    submitAssetBundle(bundle: ProxyAssetBundle): Promise<unknown>;
    authorizeAssetPublication(bundle: ProxyAssetBundle, opts?: {
        signal?: AbortSignal;
    }): Promise<unknown>;
    reverifyAssets(input: ProxyAssetReverification, opts?: {
        signal?: AbortSignal;
    }): Promise<unknown>;
    private verificationSignal;
    /** Pre-publish dry-run: the hub runs its quality + content-safety gate but stores nothing and charges no credits. */
    validateAsset(asset: unknown): Promise<unknown>;
    validateAssetBundle(bundle: ProxyAssetBundle): Promise<unknown>;
    distillConversation(input: unknown): Promise<unknown>;
    recordReuseResult(args: ProxyReuseResultArgs): Promise<unknown>;
    private modeBoundBody;
    call(method: string, path: string, body?: unknown, opts?: {
        signal?: AbortSignal;
    }): Promise<unknown>;
    private verifyExpectedHubMode;
    private verifyReloadedHubMode;
    private acceptResult;
    private callOnce;
    private connectionSnapshot;
    private reloadFromSettings;
    private proxyError;
}
export declare function proxyClientFromEnv(env?: Record<string, string | undefined>): EvolverProxyClient | undefined;
export declare function reachableProxyClientFromEnv(env?: Record<string, string | undefined>, opts?: {
    fetchFn?: ProxyFetch;
    timeoutMs?: number;
}): Promise<EvolverProxyClient | undefined>;