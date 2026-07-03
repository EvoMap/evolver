import type { AnthropicProxy } from '../router/messagesRoute.js';
export declare const DEFAULT_UPSTREAM_URL = "https://api.anthropic.com";
export declare const DEFAULT_OPENAI_UPSTREAM_URL = "https://api.openai.com/v1";
export declare const DEFAULT_GEMINI_UPSTREAM_URL = "https://generativelanguage.googleapis.com";
export declare const DEFAULT_OLLAMA_UPSTREAM_URL = "http://127.0.0.1:11434";
/** Time allowed for upstream RESPONSE HEADERS to arrive. Never applied to the body: a healthy SSE stream
 * routinely outlives any fixed deadline, so an AbortSignal.timeout-style cap on the whole fetch would kill
 * long generations mid-stream (a real v1 hazard). Body lifetime is bounded by the client connection instead. */
export declare const DEFAULT_HEADERS_TIMEOUT_MS = 120000;
export type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
}) => Promise<{
    status: number;
    headers: {
        entries(): IterableIterator<[string, string]>;
    };
    body: unknown | null;
    text(): Promise<string>;
}>;
export interface AnthropicUpstreamOptions {
    /** Injected env (testability). Default process.env, read per request so creds/URL hot-swap without restart. */
    env?: NodeJS.ProcessEnv;
    /** Injected fetch (testability). Default globalThis.fetch. */
    fetchImpl?: FetchLike;
    /** Injected Bedrock runtime (testability). Default lazy-loads @aws-sdk/client-bedrock-runtime only in bedrock mode. */
    bedrockRuntime?: BedrockRuntimeFactory;
    headersTimeoutMs?: number;
}
export type ProviderUpstreamOptions = AnthropicUpstreamOptions;
export interface BedrockInvokeInput {
    modelId: string;
    contentType: string;
    accept: string;
    body: string;
}
export interface BedrockRuntimeClientLike {
    send(command: unknown, options?: {
        abortSignal?: AbortSignal;
    }): Promise<unknown>;
}
export interface BedrockRuntimeFactory {
    createClient(args: {
        region: string;
        endpoint?: string;
    }): BedrockRuntimeClientLike;
    createInvokeModelCommand(input: BedrockInvokeInput): unknown;
    createInvokeModelWithResponseStreamCommand(input: BedrockInvokeInput): unknown;
}
export declare function resolveOpenAIUpstreamUrl(env?: NodeJS.ProcessEnv): string;
/** Resolve the upstream base URL. OpenAI-compatible routes never inherit the Anthropic-wide override. */
export declare function resolveUpstreamUrl(env?: NodeJS.ProcessEnv, upstreamMode?: string): string;
export declare function resolveGeminiUpstreamUrl(env?: NodeJS.ProcessEnv): string;
export declare function resolveOllamaUpstreamUrl(env?: NodeJS.ProcessEnv): string;
export declare function buildForwardHeaders(inbound: Record<string, string | undefined>, env: NodeJS.ProcessEnv, upstreamMode?: string): Record<string, string>;
export declare function buildOpenAIHeaders(inbound: Record<string, string | undefined>, env: NodeJS.ProcessEnv): Record<string, string>;
export declare function buildGeminiHeaders(inbound: Record<string, string | undefined>, env: NodeJS.ProcessEnv): Record<string, string>;
export declare function buildOllamaHeaders(env: NodeJS.ProcessEnv): Record<string, string>;
export declare function buildVertexHeaders(env: NodeJS.ProcessEnv): Record<string, string>;
/** Build the production AnthropicProxy. Streaming is detected from the upstream content-type
 * (text/event-stream → expose the response body stream; anything else → buffered text()). */
export declare function makeAnthropicUpstream(opts?: AnthropicUpstreamOptions): AnthropicProxy;
export declare function makeOpenAIUpstream(opts?: ProviderUpstreamOptions): AnthropicProxy;
export declare function makeGeminiUpstream(opts?: ProviderUpstreamOptions): AnthropicProxy;
export declare function makeOllamaUpstream(opts?: ProviderUpstreamOptions): AnthropicProxy;
export declare function makeVertexUpstream(opts?: ProviderUpstreamOptions): AnthropicProxy;