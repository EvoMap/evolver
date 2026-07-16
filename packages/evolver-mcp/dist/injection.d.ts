export type RuntimeId = 'claude-code' | 'codex' | 'cursor' | 'antigravity' | 'kiro' | 'opencode';
export type InjectionMode = 'mcp-hooks' | 'mcp-plugin' | 'mcp-config' | 'cursor-rules' | 'passive';
/**
 * Setup support contract (#217). A bootstrapper that delegates runtime onboarding to evolver v2 needs a
 * DETERMINISTIC answer for every runtime it might ask about — not just the ones v2 can write config for.
 * The three outcomes are the whole contract:
 *  - `installed`   v2 can write the runtime config/hooks and verify it (claude-code, codex, cursor, antigravity).
 *  - `manual`      v2 cannot mutate this runtime's config, but the path is real: it prints precise MCP/HTTP
 *                  wiring the operator does by hand (opencode, openclaw, mcp-generic, http-agent, server).
 *  - `unsupported` v2 refuses with a clear reason (an unrecognized runtime id).
 * This split is what stops the bootstrapper from reporting a runtime as installed when it is not (#217 AC).
 */
export type SetupOutcome = 'installed' | 'manual' | 'unsupported';
/**
 * The runtimes a bootstrapper may ask `evolver setup-hooks` about (#217). A superset of RuntimeId: the extra
 * ids (openclaw, mcp-generic, http-agent, server) have no auto-installer, so they live ONLY in this setup-level
 * type and never reach `planInjection` (whose RuntimeId switch stays exhaustive over the runtimes v2 can inject).
 */
export type SetupRuntime = RuntimeId | 'openclaw' | 'mcp-generic' | 'http-agent' | 'server';
/** The declared support class for a runtime (the static matrix entry), plus a reason for manual/unsupported. */
export interface RuntimeSupport {
    /** The runtime id as asked (echoed back so a caller parsing --json sees what it requested). */
    runtime: string;
    outcome: SetupOutcome;
    /** Human reason — present for `manual` (what to do by hand) and `unsupported` (why refused); absent for installed. */
    reason?: string;
}
/** Every runtime in the setup matrix (#217), in a stable order — used for usage text and the unsupported reason. */
export declare const SETUP_RUNTIMES: readonly SetupRuntime[];
/**
 * Classify a runtime id into the setup matrix (#217). Takes a RAW string (not the SetupRuntime union) so the
 * unsupported branch is reachable: an unrecognized id is the `unsupported` case, with a reason that lists the
 * runtimes v2 does recognize. This is the single source of truth the CLI uses to decide install vs print vs refuse.
 */
export declare function runtimeSupport(runtime: string): RuntimeSupport;
export interface InjectionPlan {
    runtime: RuntimeId;
    mode: InjectionMode;
    config: Record<string, unknown>;
    note: string;
}
export interface McpServerCmd {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}
/**
 * 按 runtime 规划 MCP 工具注入(M5-5). MVP: CC(hooks)+codex(plugin) 做工具注入,
 * 其余仅被动会话日志消费(待确认 a / 批注#39). 注入方式差异大, 故每 runtime 一策略.
 */
export declare function planInjection(runtime: RuntimeId, server: McpServerCmd): InjectionPlan;
/** 哪些 runtime 经 MCP server 注入工具发现(CC+codex). cursor 注入的是 gene 记忆(rules 文件)而非 MCP 工具,
 *  故不计入此处;passive runtime 也为 false. */
export declare function injectsTools(runtime: RuntimeId): boolean;
/** 是否为 active 注入(任何把 gene 价值推回 runtime 的方式:MCP 工具发现 或 cursor rules 记忆注入). */
export declare function isActiveInjection(runtime: RuntimeId): boolean;