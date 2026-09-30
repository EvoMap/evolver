import { hub } from '@evomap/evolver-core';
import { DiscoveryError } from './discovery.js';
export class UnknownToolError extends Error {
    name;
    constructor(name) {
        super(`未知 MCP 工具: ${name}`);
        this.name = name;
        this.name = 'UnknownToolError';
    }
}
/**
 * Evolver MCP server 核心(M5-1). 与传输无关(stdio 适配器薄薄一层包它),
 * 便于直接单测; listTools 给 agent 自然发现, callTool 分派 + 隔离错误.
 */
export class EvolverMcpServer {
    tools = new Map();
    /** Server-level onboarding text (#mcp-onboarding). A transport surfaces it as the MCP `initialize.instructions`
     *  field so any connecting client hands the evolver mechanism to its model. Empty string when not provided. */
    instructions;
    constructor(tools, opts = {}) {
        for (const t of tools)
            this.tools.set(t.name, t);
        this.instructions = opts.instructions ?? '';
    }
    listTools() {
        return [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
        }));
    }
    async callTool(name, args = {}) {
        const tool = this.tools.get(name);
        if (!tool)
            throw new UnknownToolError(name);
        try {
            return { ok: true, result: await tool.handler(args) };
        }
        catch (e) {
            if (e instanceof hub.RecipeExecutionError || e instanceof DiscoveryError)
                return { ok: false, error: e.code, code: e.code, status: e.status, ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) };
            if (name === 'evolver_recipe_search')
                return { ok: false, error: 'discovery_failed', code: 'discovery_failed', status: 502 };
            if (name.startsWith('evolver_recipe_'))
                return { ok: false, error: 'recipe_execution_failed', code: 'recipe_execution_failed', status: 502 };
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }
    has(name) { return this.tools.has(name); }
}