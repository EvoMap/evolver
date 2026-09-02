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
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }
    has(name) { return this.tools.has(name); }
}