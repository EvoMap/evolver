import { type WorkflowSpec, type CoreFn } from './dsl.js';
export interface WorkflowContext {
    input: Record<string, unknown>;
    steps: Record<string, unknown>;
    item?: unknown;
}
export interface AgentBridgeOptions {
    /** Cooperative cancellation for the current durable attempt. */
    signal?: AbortSignal;
}
/** agent step 桥(注入 runtime; 孵化期可注 stub). */
export type AgentBridge = (prompt: string, ctx: WorkflowContext, options?: AgentBridgeOptions) => Promise<unknown> | unknown;
export interface WorkflowEngineDeps {
    core?: Record<string, CoreFn>;
    agent: AgentBridge;
}
export declare class WorkflowError extends Error {
    constructor(message: string);
}
/**
 * Workflow 执行引擎(M4B-2 孵化). 解释 DAG: script(受限 core)/agent(桥)/foreach(可并行)/if.
 * 无 eval/无任意 JS; 编排层声明式, 计算只走白名单 core.
 */
export declare class WorkflowEngine {
    private readonly deps;
    private readonly core;
    constructor(deps: WorkflowEngineDeps);
    run(spec: WorkflowSpec): Promise<{
        output: unknown;
        ctx: WorkflowContext;
    }>;
    private runSteps;
    private runStep;
}