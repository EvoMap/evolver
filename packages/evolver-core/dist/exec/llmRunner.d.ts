import type { AgentRunner, AgentRunnerOptions } from './runnerRegistry.js';
export declare const LLM_DEFAULT_BASE_URL = "https://api.openai.com/v1";
export declare const LLM_DEFAULT_MODEL = "gpt-4.1";
export interface LlmRunnerConfig {
    baseUrl: string;
    model: string;
    apiKey: string;
    maxTurns: number;
    maxFileBytes: number;
}
/** Why this node cannot run a model, in the words an operator needs to fix it. */
export declare class LlmRunnerNotConfiguredError extends Error {
    constructor(missing: string);
}
export declare function readLlmRunnerConfig(env?: NodeJS.ProcessEnv): LlmRunnerConfig;
/**
 * The model's reach. Every path is resolved against the run's own directory and refused
 * if it lands outside — the model never names a file this run was not given.
 */
export interface Workspace {
    list(dir: string): string;
    read(path: string): string;
    write(path: string, content: string): string;
    touched(): string[];
    /** Put back every file this run changed. A failed run must leave no half-done edit. */
    undo(): void;
}
export declare function workspaceAt(root: string, maxFileBytes?: number): Workspace;
export type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
}) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
}>;
export interface LlmRunnerDeps {
    config?: LlmRunnerConfig;
    fetchFn?: FetchLike;
    workspace?: (cwd: string) => Workspace;
}
/**
 * Build a runner that drives a model through the workspace tools. `opts` is accepted for
 * registry symmetry: this runner has no host permission prompts to bypass and no vendor
 * tool names to allowlist, because the tools are the three defined above.
 */
export declare function makeLlmHeadlessRunner(_opts?: AgentRunnerOptions, deps?: LlmRunnerDeps): AgentRunner;