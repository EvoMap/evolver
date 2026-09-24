import { type Workspace } from './llmWorkspace.js';
export { workspaceAt, type Workspace } from './llmWorkspace.js';
export { reservePrivateWorkspace, type WorkspaceLease } from './workspaceLease.js';
export type { WorkspaceRecovery } from './workspaceRecovery.js';
import type { AgentRunner, AgentRunnerOptions } from './runnerRegistry.js';
export declare const LLM_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export declare const LLM_DEFAULT_MODEL = "gpt-4.1";
export interface LlmRunnerConfig {
    baseUrl: string;
    model: string;
    apiKey: string;
    maxTurns: number;
    maxFileBytes: number;
    /** Operator-configured headers; names are case-insensitive and override the defaults. */
    extraHeaders?: Readonly<Record<string, string>>;
}
/** Why this node cannot run a model, in the words an operator needs to fix it. */
export declare class LlmRunnerNotConfiguredError extends Error {
    constructor(missing: string);
}
export declare function readLlmRunnerConfig(env?: NodeJS.ProcessEnv): LlmRunnerConfig;
export type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    redirect?: 'error';
}) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
}>;
export interface LlmRunnerDeps {
    config?: LlmRunnerConfig;
    fetchFn?: FetchLike;
    /** Trusted host decorator. The supplied workspace already holds the run's validated lease. */
    workspace?: (cwd: string, ownedWorkspace: Workspace) => Workspace;
}
/**
 * Build a runner that drives a model through the workspace tools. `opts` is accepted for
 * registry symmetry: this runner has no host permission prompts to bypass and no vendor
 * tool names to allowlist, because the tools are the three defined above.
 */
export declare function makeLlmHeadlessRunner(_opts?: AgentRunnerOptions, deps?: LlmRunnerDeps): AgentRunner;