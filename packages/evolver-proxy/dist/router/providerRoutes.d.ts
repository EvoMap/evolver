import type { AnthropicProxy, MessagesResponse, RouterLogger, TraceSink } from './messagesRoute.js';
import { type Tier } from './modelRouter.js';
export interface ProviderRouteRequest {
    body: Record<string, unknown>;
    headers?: Record<string, string | undefined>;
    params?: Record<string, string>;
    query?: Record<string, string>;
}
export type ProviderRouteHandler = (req: ProviderRouteRequest) => Promise<MessagesResponse>;
export interface ProviderRouteOptions {
    anthropicProxy: AnthropicProxy;
    openAIProxy: AnthropicProxy;
    geminiProxy: AnthropicProxy;
    ollamaProxy: AnthropicProxy;
    vertexProxy: AnthropicProxy;
    logger?: RouterLogger;
    onTrace?: TraceSink;
    clock?: () => number;
    env?: NodeJS.ProcessEnv;
}
export declare const OPENAI_RESPONSE_HEADER_ALLOWLIST: Set<string>;
export declare const GEMINI_RESPONSE_HEADER_ALLOWLIST: Set<string>;
type OpenAIRoute = '/v1/responses' | '/v1/chat/completions';
export declare function copyOpenAIResponseHeaders(headers?: Record<string, string | undefined>): Record<string, string>;
export declare function copyGeminiResponseHeaders(headers?: Record<string, string | undefined>): Record<string, string>;
export declare function resolveOpenAITierModels(env?: NodeJS.ProcessEnv, route?: OpenAIRoute): Partial<Record<Tier, string>>;
export declare function parseModelAction(modelAction: string): {
    model: string;
    action: string;
};
export declare function detectModelsProvider(headers?: Record<string, string | undefined>): 'anthropic' | 'openai';
export declare function vertexBaseUrl(location: string, env?: NodeJS.ProcessEnv): string;
export declare function buildOpenAIResponsesHandler(opts: Pick<ProviderRouteOptions, 'openAIProxy' | 'logger' | 'onTrace' | 'clock' | 'env'>): ProviderRouteHandler;
export declare function buildOpenAIChatCompletionsHandler(opts: Pick<ProviderRouteOptions, 'openAIProxy' | 'logger' | 'onTrace' | 'clock' | 'env'>): ProviderRouteHandler;
export declare function buildGeminiHandler(opts: Pick<ProviderRouteOptions, 'geminiProxy' | 'logger' | 'onTrace' | 'clock' | 'env'>): ProviderRouteHandler;
export declare function buildOllamaHandler(opts: Pick<ProviderRouteOptions, 'ollamaProxy' | 'logger' | 'onTrace' | 'clock' | 'env'> & {
    apiPath: '/api/chat' | '/api/generate';
}): ProviderRouteHandler;
export declare function buildVertexHandler(opts: Pick<ProviderRouteOptions, 'vertexProxy' | 'logger' | 'onTrace' | 'clock' | 'env'>): ProviderRouteHandler;
export declare function buildModelsHandler(opts: Pick<ProviderRouteOptions, 'anthropicProxy' | 'openAIProxy' | 'logger'>): ProviderRouteHandler;
export declare function buildProviderRoutes(opts: ProviderRouteOptions): Record<string, ProviderRouteHandler>;
export {};