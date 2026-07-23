/**
 * Dynamic workflow DSL(M4B, 轨B 孵化). 声明式 + 受限表达式, **无任意 JS**(从语言层消除一类风险).
 * 表达式表示为**结构化对象**(非字符串解析): 引用 Ref + 白名单 core 调用, 安全 by-construction.
 */
/** 引用: input.<k> / steps.<id>.<k> / item(foreach 内). */
export interface Ref {
    ref: string;
}
export type Literal = string | number | boolean | null;
export type Value = Literal | Ref;
export declare function isRef(v: unknown): v is Ref;
/** 白名单 core 调用(受限求值的唯一计算手段). */
export interface CoreCall {
    fn: string;
    args: Value[];
}
export type WorkflowErrorClass = 'transient' | 'permanent' | 'safety' | 'unknown';
export declare function containsWorkflowSensitiveText(value: string): boolean;
export interface WorkflowRetryPolicy {
    maxAttempts: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
}
export interface DurableStepOptions {
    /** Agent steps default to non-idempotent; script steps default to idempotent. */
    idempotency?: 'idempotent' | 'non_idempotent';
    retry?: WorkflowRetryPolicy;
}
export interface ScriptStep extends DurableStepOptions {
    id: string;
    kind: 'script';
    setOutput: string;
    call: CoreCall;
}
export interface AgentStep extends DurableStepOptions {
    id: string;
    kind: 'agent';
    prompt: string;
    outputKey?: string;
}
export interface ForeachStep {
    id: string;
    kind: 'foreach';
    over: Ref;
    as: string;
    parallel?: boolean;
    body: WorkflowStep[];
    collect?: string;
}
export interface IfStep {
    id: string;
    kind: 'if';
    cond: Value;
    then: WorkflowStep[];
    else?: WorkflowStep[];
}
/** Durable human gate. Execution stops before subsequent steps until an operator approves or rejects it. */
export interface ApprovalStep {
    id: string;
    kind: 'approval';
    label?: string;
}
export type WorkflowStep = ScriptStep | AgentStep | ForeachStep | IfStep | ApprovalStep;
export interface WorkflowSpec {
    /** Stable caller-supplied identity. If omitted, the durable runtime derives one from the definition. */
    workflowId?: string;
    name: string;
    input?: Record<string, unknown>;
    steps: WorkflowStep[];
    output?: Ref;
}
/** 白名单 core 函数表(受限). 起步集: 列表/过滤/字符串/逻辑. 不含 fs/net/eval. */
export type CoreFn = (...args: unknown[]) => unknown;
export declare const CORE_WHITELIST: Record<string, CoreFn>;