/** Every runtime in the setup matrix (#217), in a stable order — used for usage text and the unsupported reason. */
export const SETUP_RUNTIMES = [
    'claude-code', 'codex', 'cursor', 'opencode', 'kiro', 'openclaw', 'mcp-generic', 'http-agent', 'server',
];
/** Runtimes v2 can write config/hooks for and verify. */
const INSTALLED_RUNTIMES = new Set(['claude-code', 'codex', 'cursor']);
/** Runtimes with no v2 auto-installer but a real manual path. The reason is the short, honest "do it by hand"
 *  line; the precise wiring text is a separate concern (#217 slice 2), not hard-coded here. */
const MANUAL_RUNTIMES = new Map([
    ['opencode', 'opencode is consumed passively today; register the evolver MCP server in its config by hand'],
    ['kiro', 'kiro is consumed passively today; register the evolver MCP server in its config by hand'],
    ['openclaw', 'no v2 auto-installer yet; wire the evolver MCP server (or PrivateHub HTTP/A2A) by hand'],
    ['mcp-generic', 'no config writer for a generic MCP client; register the evolver MCP server by hand'],
    ['http-agent', 'no config writer for an HTTP/API-only agent; wire it to PrivateHub HTTP/A2A by hand'],
    ['server', 'v2 does not manage service lifecycle; use the server/service startup guidance by hand'],
]);
/**
 * Classify a runtime id into the setup matrix (#217). Takes a RAW string (not the SetupRuntime union) so the
 * unsupported branch is reachable: an unrecognized id is the `unsupported` case, with a reason that lists the
 * runtimes v2 does recognize. This is the single source of truth the CLI uses to decide install vs print vs refuse.
 */
export function runtimeSupport(runtime) {
    if (INSTALLED_RUNTIMES.has(runtime))
        return { runtime, outcome: 'installed' };
    const reason = MANUAL_RUNTIMES.get(runtime);
    if (reason !== undefined)
        return { runtime, outcome: 'manual', reason };
    return { runtime, outcome: 'unsupported', reason: `unknown runtime '${runtime}' (supported: ${SETUP_RUNTIMES.join(', ')})` };
}
/**
 * 按 runtime 规划 MCP 工具注入(M5-5). MVP: CC(hooks)+codex(plugin) 做工具注入,
 * 其余仅被动会话日志消费(待确认 a / 批注#39). 注入方式差异大, 故每 runtime 一策略.
 */
export function planInjection(runtime, server) {
    switch (runtime) {
        case 'claude-code':
            return {
                runtime, mode: 'mcp-hooks',
                // CC 成熟: .mcp.json 注册 MCP server, agent 在 tool list 自然发现
                config: { mcpServers: { evolver: { command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) } } },
                note: 'CC: 写 .mcp.json + SessionStart hook; agent 经 MCP tool list 自然发现 evolver 能力',
            };
        case 'codex':
            return {
                runtime, mode: 'mcp-plugin',
                // codex loads TOML (~/.codex or project .codex/config.toml). Real schema: an MCP stdio server under
                // [mcp_servers.<id>] (command/args/env) — the installer also adds a [[hooks.SessionStart]] hook so
                // codex gets the same hybrid as CC. Config mirrors the codex [mcp_servers.evolver] table shape.
                config: { mcp_servers: { evolver: { command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) } } },
                note: 'codex: 写 .codex/config.toml [mcp_servers.evolver] + [[hooks.SessionStart]]; agent 经 MCP tool list 发现 evolver 能力',
            };
        case 'cursor':
            return {
                runtime, mode: 'cursor-rules',
                // cursor has no MCP-server-config + SessionStart-hook hybrid; its stable injection point is a project
                // rules file. The active path renders quiet top-gene hints into .cursor/rules/evolver.mdc
                // (alwaysApply:true) and a daemon rewrites it on gene-set change. This is gene-memory
                // injection (NOT MCP tool discovery), so it carries no MCP server config here.
                config: {},
                note: 'cursor: 渲染静默 top-gene hints 进 .cursor/rules/evolver.mdc (alwaysApply:true); daemon 在 gene 集变化时重写',
            };
        case 'kiro':
        case 'opencode':
            return {
                runtime, mode: 'passive',
                config: {},
                note: `${runtime}: MVP 仅被动消费会话日志(无工具注入); 接入方式待补`,
            };
        default: {
            const _exhaustive = runtime;
            throw new Error(`未知 runtime: ${String(_exhaustive)}`);
        }
    }
}
/** 哪些 runtime 经 MCP server 注入工具发现(CC+codex). cursor 注入的是 gene 记忆(rules 文件)而非 MCP 工具,
 *  故不计入此处;passive runtime 也为 false. */
export function injectsTools(runtime) {
    const mode = planInjection(runtime, { command: 'x' }).mode;
    return mode === 'mcp-hooks' || mode === 'mcp-plugin';
}
/** 是否为 active 注入(任何把 gene 价值推回 runtime 的方式:MCP 工具发现 或 cursor rules 记忆注入). */
export function isActiveInjection(runtime) {
    return planInjection(runtime, { command: 'x' }).mode !== 'passive';
}