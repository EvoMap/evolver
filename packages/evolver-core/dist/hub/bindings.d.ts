import type { HubCapability, HubBindings } from './capability.js';
import { type LeakCheckMode } from './sanitize.js';
/** publish 回执非 accepted → 抛此错; SyncEngine 据 terminal 决定是否重试. */
export declare class PublishRejectedError extends Error {
    readonly status: string;
    readonly terminal: boolean;
    readonly retryAfterMs?: number | undefined;
    readonly retryable?: boolean | undefined;
    constructor(status: string, terminal: boolean, reason?: string, retryAfterMs?: number | undefined, retryable?: boolean | undefined);
}
/** makeHubBindings options. Pre-publish sanitize is on by default (both public + private adapters share this single chokepoint). */
export interface HubBindingsOptions {
    sanitize?: {
        /** Default true: deep-redact + leak-scan before egress. Off = raw publish (tests / special cases only). */
        enabled?: boolean;
        /** Source for the env reverse-scan + EVOLVER_LEAK_CHECK. Defaults to process.env. */
        env?: Record<string, string | undefined>;
        /** Override the leak-check mode (strict = refuse / warn = log only / off = skip scan). Defaults to reading env, which defaults to strict. */
        mode?: LeakCheckMode;
    };
}
/**
 * 把 HubCapability 接到 core 两 seam(M6-1):
 * - asProxyHandler: Dispatcher.handlers.proxy — 按 envelope.type 路由到 hub. 抛错→store.fail()重试;
 *   但 publish 终态(reject/quarantine/402)抛 PublishRejectedError{terminal:true}, 调用方据此不重试(money-safety).
 * - asAssetTransport: assetstore RemoteTransport — 落库前 core normalizeForPut, 不信任远端 asset_id.
 */
export declare function makeHubBindings(cap: HubCapability, options?: HubBindingsOptions): HubBindings;