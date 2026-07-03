import type { McpTool } from './tools.js';
export interface ToolListEntry {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
export interface ToolCallResult {
    ok: boolean;
    result?: unknown;
    error?: string;
}
export declare class UnknownToolError extends Error {
    readonly name: string;
    constructor(name: string);
}
/**
 * Evolver MCP server 核心(M5-1). 与传输无关(stdio 适配器薄薄一层包它),
 * 便于直接单测; listTools 给 agent 自然发现, callTool 分派 + 隔离错误.
 */
export declare class EvolverMcpServer {
    private readonly tools;
    /** Server-level onboarding text (#mcp-onboarding). A transport surfaces it as the MCP `initialize.instructions`
     *  field so any connecting client hands the evolver mechanism to its model. Empty string when not provided. */
    readonly instructions: string;
    constructor(tools: readonly McpTool[], opts?: {
        instructions?: string;
    });
    listTools(): ToolListEntry[];
    callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
    has(name: string): boolean;
}