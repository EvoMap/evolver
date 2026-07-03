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
}
export interface ProxyFetchArgs {
    assetId?: string;
    assetIds?: string[];
}
export interface ProxyAssetBundle {
    assets: unknown[];
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
}
export declare class EvolverProxyClient {
    private baseUrl;
    private token;
    private readonly fetchFn;
    private readonly reloadSettings;
    constructor(opts: EvolverProxyClientOptions);
    status(opts?: {
        signal?: AbortSignal;
    }): Promise<unknown>;
    search(args: ProxySearchArgs): Promise<unknown>;
    fetchAsset(args: ProxyFetchArgs): Promise<unknown>;
    submitAsset(asset: unknown): Promise<unknown>;
    /** Pre-publish dry-run: the hub runs its quality + content-safety gate but stores nothing and charges no credits. */
    validateAsset(asset: unknown): Promise<unknown>;
    validateAssetBundle(bundle: ProxyAssetBundle): Promise<unknown>;
    distillConversation(input: unknown): Promise<unknown>;
    recordReuseResult(args: ProxyReuseResultArgs): Promise<unknown>;
    call(method: string, path: string, body?: unknown, opts?: {
        signal?: AbortSignal;
    }): Promise<unknown>;
    private callOnce;
    private reloadFromSettings;
    private proxyError;
}
export declare function proxyClientFromEnv(env?: Record<string, string | undefined>): EvolverProxyClient | undefined;
export declare function reachableProxyClientFromEnv(env?: Record<string, string | undefined>, opts?: {
    fetchFn?: ProxyFetch;
    timeoutMs?: number;
}): Promise<EvolverProxyClient | undefined>;