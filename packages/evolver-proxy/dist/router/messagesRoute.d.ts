import { type Tier, type RouterFeatures } from './modelRouter.js';
import { type SseUsage } from './sseScan.js';
export type LlmRoute = '/v1/messages' | '/v1/responses' | '/v1/chat/completions';
export type LlmWireApi = 'anthropic_messages' | 'openai_responses' | 'openai_chat_completions' | 'gemini_generate_content' | 'ollama_api' | 'vertex_gemini';
export interface UpstreamResult {
    status: number;
    headers?: Record<string, string | undefined>;
    stream?: unknown | null;
    text?: () => Promise<string> | string;
    traceRequestBody?: unknown;
    transportMetadata?: unknown;
}
export interface UpstreamCallOptions {
    inboundHeaders: Record<string, string | undefined>;
    upstreamMode: string;
    method?: string;
    baseUrl?: string;
}
export type AnthropicProxy = (path: string, body: unknown, opts: UpstreamCallOptions) => Promise<UpstreamResult>;
export interface RouterLogger {
    log?: (line: string) => void;
    warn?: (line: string) => void;
}
export type LlmUsage = SseUsage;
export interface LlmTraceAttempt {
    attempt_index: number;
    model: string | null;
    provider: string;
    upstream_mode: string;
    status: number | null;
    error?: string;
    requestBody?: string;
    responseBody?: string;
    body_truncated?: boolean;
}
/** One record per /v1/messages turn — the trace material the proxy exists to capture. METADATA ONLY: routing
 * decision, status, latency, token usage, stop_reason. Prompt/completion content never enters a record. */
export interface LlmTurnTrace {
    ts: string;
    event: 'llm_turn';
    id: string;
    request_id: string | null;
    route: string;
    provider: string;
    wire_api: LlmWireApi;
    client: 'claude-code' | 'cursor' | 'codex' | 'unknown';
    /** Raw inbound User-Agent header (clipped), kept as a structured field so buyers can fingerprint the client
     *  beyond the coarse `client` bucket. Omitted when absent. (FIX-10) */
    user_agent?: string;
    /** Stable account hash derived from request metadata.user_id/user. For Claude-style
     *  `user_...__session_<uuid>` values this strips the volatile session suffix. */
    user_id_hash?: string;
    /** Normalized reasoning/thinking effort for this turn, derived from the request body across providers:
     *  Anthropic `thinking` (type/budget_tokens), OpenAI `reasoning.effort`, `output_config.effort`, or metadata.
     *  Shape: { effort?: 'minimal'|'low'|'medium'|'high'|string, budget_tokens?: number, type?: string }. (FIX-9) */
    thinking_effort?: ThinkingEffort;
    session_id: string | null;
    response_id?: string;
    previous_response_id?: string;
    original_model: string | null;
    chosen_model: string | null;
    tier: Tier | null;
    reason: string | null;
    fallback: string | null;
    router_enabled: boolean;
    upstream_mode: string;
    status: number | null;
    stream: boolean;
    /** ms from request arrival to upstream response headers (null if upstream was never reached). */
    ttfb_ms: number | null;
    /** ms from request arrival to trace emission (stream end for streams, body parse for JSON). */
    latency_ms: number;
    features?: RouterFeatures;
    usage?: LlmUsage;
    stop_reason?: string | null;
    error?: string;
    requestBody?: string;
    responseBody?: string;
    redaction?: string;
    body_truncated?: boolean;
    request_headers?: unknown;
    response_headers?: unknown;
    transport_metadata?: unknown;
    attempts?: LlmTraceAttempt[];
}
export type TraceSink = (record: LlmTurnTrace) => void;
export interface MessagesHandlerOptions {
    anthropicProxy: AnthropicProxy;
    logger?: RouterLogger;
    /** Explicit override wins (hermetic tests); else read from env EVOMAP_ROUTER_ENABLED==='1' at construction. */
    routerEnabled?: boolean;
    /** Injected env (testability). Default process.env. */
    env?: NodeJS.ProcessEnv;
    /** Trace-capture seam: called exactly once per turn. Sink errors are swallowed — capture never breaks serving. */
    onTrace?: TraceSink;
    /** Injected clock for latency fields (testability). Default Date.now. */
    clock?: () => number;
}
export interface MessagesRequest {
    route?: LlmRoute;
    body: {
        model?: unknown;
        messages?: unknown;
    } & Record<string, unknown>;
    headers?: Record<string, string | undefined>;
}
export interface MessagesResponse {
    status: number;
    body?: unknown;
    stream?: unknown;
    headers?: Record<string, string>;
}
export declare function captureTraceMetadata(value: unknown, env?: NodeJS.ProcessEnv): unknown;
export declare function resolveTierModels(env?: NodeJS.ProcessEnv): Partial<Record<Tier, string>>;
interface ClaudeId {
    family: string;
    major: number;
    minor: number;
}
export declare function parseClaudeId(modelId: unknown): ClaudeId | null;
/** Block an intra-family generational DOWNGRADE (opus-4-7 → opus-4-1). Cross-family (opus→haiku) is allowed. */
export declare function isIntraFamilyDowngrade(chosen: unknown, original: unknown): boolean;
export declare function resolveBedrockAliases(env?: NodeJS.ProcessEnv): Record<string, string>;
/** Canonicalize a short Claude ID to its operator-configured Bedrock alias. Unmapped/unknown → unchanged. */
export declare function canonicalizeForBedrock(modelId: unknown, aliases: Record<string, string>): unknown;
export declare function supportsAdaptiveThinking(modelId: unknown): boolean;
export interface ThinkingEffort {
    effort?: string;
    budget_tokens?: number;
    type?: string;
}
export declare function extractThinkingEffort(body: unknown): ThinkingEffort | undefined;
/**
 * Build the /v1/messages handler. `enabled` (env EVOMAP_ROUTER_ENABLED, or the explicit override) gates the
 * whole router — when off, the body forwards unmodified (a pure passthrough). Returns {status, body|stream}.
 */
export declare function buildMessagesHandler(opts: MessagesHandlerOptions): (req: MessagesRequest) => Promise<MessagesResponse>;
export {};