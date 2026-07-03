import type { MessagesRequest, MessagesResponse, RouterLogger } from '../router/messagesRoute.js';
import type { ProviderRouteHandler } from '../router/providerRoutes.js';
export declare const DEFAULT_LLM_PORT = 19821;
/** /v1/messages bodies legitimately reach tens of MiB (long contexts); the 1 MiB IPC-style cap would break
 * real clients. Still bounded — an unauthenticated local writer must not be able to balloon memory. */
export declare const DEFAULT_LLM_MAX_BODY_BYTES: number;
export interface LlmProxyServerOptions {
    handler: (req: MessagesRequest) => Promise<MessagesResponse>;
    routes?: Record<string, ProviderRouteHandler>;
    /** Self-auth bearer token. Required: an unauthenticated LLM relay on loopback is an open proxy. */
    token: string;
    /** Base port; EADDRINUSE walks upward. 0 → kernel-assigned (tests). Default env EVOLVER_LLM_PORT or 19821. */
    port?: number;
    host?: string;
    maxBodyBytes?: number;
    logger?: RouterLogger;
    env?: NodeJS.ProcessEnv;
}
export declare class LlmProxyServer {
    private readonly opts;
    private server;
    private actualPort;
    private readonly log;
    private readonly env;
    private readonly maxBodyBytes;
    constructor(opts: LlmProxyServerOptions);
    private authed;
    start(): Promise<{
        port: number;
        url: string;
    }>;
    stop(): Promise<void>;
    private handle;
    private relayStream;
}