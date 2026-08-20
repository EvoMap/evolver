import type { hub } from '@evomap/evolver-core';
type HeadersLike = {
    get(name: string): string | null | undefined;
} | Record<string, string | undefined>;
export interface HubFetchResponse {
    status: number;
    headers?: HeadersLike;
    body: unknown | null;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
}
export interface HubFetchInit {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'manual';
}
export type FetchLike = (url: string, init: HubFetchInit) => Promise<HubFetchResponse>;
export declare const HUB_ERROR_TEXT_MAX_BYTES: number;
export declare const HUB_JSON_TEXT_MAX_BYTES: number;
export declare const HUB_UNREACHABLE_BACKOFF_BASE_MS = 60000;
export declare const HUB_UNREACHABLE_BACKOFF_MAX_MS: number;
export declare const HUB_GENERAL_TIMEOUT_MS = 15000;
export declare const HUB_SEARCH_TIMEOUT_MS = 8000;
export declare const HUB_HEARTBEAT_TIMEOUT_MS = 10000;
export declare const HUB_EVENT_POLL_TIMEOUT_MS = 60000;
export declare const HUB_HELLO_TIMEOUT_MS = 15000;
export interface HubOperationTimeouts {
    generalMs: number;
    searchMs: number;
    heartbeatMs: number;
    pollMs: number;
    helloMs: number;
}
export type HubOperation = 'general' | 'search' | 'heartbeat' | 'poll' | 'hello';
export interface HubDeadlineScheduler {
    set(callback: () => void, delayMs: number): unknown;
    clear(handle: unknown): void;
}
export declare class AuthError extends Error {
    readonly status: number;
    readonly body?: unknown | undefined;
    readonly errorCode: string | undefined;
    constructor(status: number, body?: unknown | undefined);
}
export declare class HubClientError extends Error {
    readonly status: number;
    readonly body: unknown;
    readonly retryAfterMs?: number | undefined;
    constructor(status: number, body: unknown, retryAfterMs?: number | undefined);
}
export declare class HubUnreachableError extends Error {
    readonly details: {
        status?: number;
        contentType?: string;
        bodySnippet?: string;
        context?: string;
        retryAfterMs?: number;
        operation?: HubOperation;
        timeoutMs?: number;
    };
    readonly code = "HUB_UNREACHABLE";
    constructor(message: string, details?: {
        status?: number;
        contentType?: string;
        bodySnippet?: string;
        context?: string;
        retryAfterMs?: number;
        operation?: HubOperation;
        timeoutMs?: number;
    });
    get retryAfterMs(): number;
}
export interface HubFetchDeps {
    baseUrl: string;
    auth: hub.AuthProvider;
    fetchFn: FetchLike;
    senderId: () => string | undefined;
    now?: () => number;
    env?: Record<string, string | undefined>;
    operationTimeouts?: Partial<HubOperationTimeouts>;
    authTimeoutMs?: number;
    deadlineScheduler?: HubDeadlineScheduler;
}
/**
 * 公版 hub HTTP 客户端(M6-6). 每请求经 AuthProvider 取凭证: legacy node_secret 对 GET 与 strict
 * GEP envelope POST 走 **Authorization: Bearer <node_secret>** 头，绝不进入 query 或 envelope body；
 * 其余兼容 REST POST 保留既有 body contract。sender_id 是标识非凭证, 留 query/body.
 * 401/403→AuthError(reauth), 4xx→HubClientError(终态), 5xx→重试.
 * 非 JSON Hub 响应(WAF/HTML/captive portal/gateway text)→HubUnreachableError, 不触发 auth recovery.
 */
export declare class HubFetch {
    private readonly deps;
    private readonly operationTimeouts;
    private readonly deadlineScheduler;
    constructor(deps: HubFetchDeps);
    call<T>(method: string, path: string, bodyObj?: Record<string, unknown>, query?: Record<string, string | number | undefined>, requestHeaders?: Readonly<Record<string, string>>): Promise<T>;
}
export declare function resolveHubOperationTimeouts(env?: Record<string, string | undefined>, overrides?: Partial<HubOperationTimeouts>): HubOperationTimeouts;
export declare function hubResponseContentType(res: Pick<HubFetchResponse, 'headers'> | undefined): string;
export declare function isHubApiResponse(res: Pick<HubFetchResponse, 'headers'> | undefined): boolean;
export declare function hubUnreachableBackoffMs(failureCount: number): number;
export declare function isHubUnreachableError(err: unknown): boolean;
export declare function isHubUnreachableResponse(res: Pick<HubFetchResponse, 'headers'> | undefined): boolean;
export declare function drainHubResponse(res: Pick<HubFetchResponse, 'body'> | undefined, opts?: {
    signal?: AbortSignal;
}): Promise<void>;
export declare function readHubResponseText(res: Pick<HubFetchResponse, 'body' | 'text'>, opts?: {
    maxBytes?: number;
    signal?: AbortSignal;
}): Promise<string>;
export declare function readHubResponseJson(res: Pick<HubFetchResponse, 'body' | 'text'>, opts?: {
    maxBytes?: number;
    signal?: AbortSignal;
}): Promise<unknown>;
export declare function throwIfHubUnreachableResponse(res: HubFetchResponse, context?: string): Promise<void>;
/** https-only scheme guard: throws on invalid URL or non-https (unless the escape hatch is set). Called at both request and transport layers (defense in depth). */
export declare function assertHubUrlSecure(url: string, env?: Record<string, string | undefined>): void;
export type HubIpFamilyPolicy = 'ipv4first' | 'ipv4only' | 'auto';
export declare const HUB_CONNECT_TIMEOUT_MS = 10000;
export declare const HUB_IPV4FIRST_PRIMARY_CONNECT_TIMEOUT_MS = 2500;
export declare const HUB_TCP_KEEPALIVE_IDLE_MS = 15000;
interface HubConnectOptions {
    rejectUnauthorized: true;
    timeout: number;
    family?: 4;
    autoSelectFamily?: boolean;
    autoSelectFamilyAttemptTimeout?: number;
}
export interface HubFetchTransportConfig {
    hubIpFamily: HubIpFamilyPolicy;
    connectTimeoutMs: number;
    ipv4FirstPrimaryConnectTimeoutMs: number;
    connectOpts: HubConnectOptions;
    primaryConnectOpts: HubConnectOptions;
    fallbackConnectOpts: HubConnectOptions | null;
}
export declare function resolveHubIpFamily(env?: Record<string, string | undefined>): HubIpFamilyPolicy;
export declare function _getHubFetchConfigForTest(env?: Record<string, string | undefined>): HubFetchTransportConfig;
export declare function _shouldFallbackFromIpv4ForTest(err: unknown, hubIpFamily?: HubIpFamilyPolicy): boolean;
export declare function _configureHubSocketForTest(socket: unknown): void;
type RawFetch = (url: string, init: Record<string, unknown>) => Promise<HubFetchResponse>;
export declare function _setFetchImplForTest(fn?: RawFetch): void;
/** Test seam: reset the one-time insecure-warning latch. */
export declare function _resetInsecureWarningForTest(): void;
/** Default production transport: secure mode = https guard + forced TLS dispatcher; escape-hatch mode = skip both (local dev). */
export declare const globalFetchLike: FetchLike;
export {};