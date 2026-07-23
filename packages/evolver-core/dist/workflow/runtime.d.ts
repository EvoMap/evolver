import { type CoreFn, type WorkflowErrorClass, type WorkflowSpec } from './dsl.js';
import type { AgentBridge, WorkflowContext } from './engine.js';
import { WorkflowStateError, WorkflowStateStore, type WorkflowControlState, type WorkflowOperatorOptions, type WorkflowRunState, type WorkflowStateStoreOptions, type WorkflowStepState } from './stateStore.js';
export declare const MAX_WORKFLOW_DEFINITION_STEPS = 256;
export declare const MAX_WORKFLOW_NESTING_DEPTH = 16;
export declare const MAX_WORKFLOW_FOREACH_ITEMS = 1000;
export interface WorkflowRuntimeDeps {
    agent: AgentBridge;
    stateDir?: string;
    core?: Record<string, CoreFn>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    classifyError?: (error: unknown) => WorkflowErrorClass;
    generateRunId?: () => string;
    maxConcurrentRuns?: number;
    maxQueuedRuns?: number;
    maxStepExecutions?: number;
    /** Test/embedding seam invoked only after a durable checkpoint has completed. */
    afterCheckpoint?: (state: Readonly<WorkflowRunState>) => void | Promise<void>;
    /** Synchronous fault-injection seam invoked under the commit lock; callbacks must not re-enter the store. */
    onTransactionPhase?: WorkflowStateStoreOptions['onTransactionPhase'];
    /** Bounded startup-recovery diagnostic; raw errors are never exposed. */
    onRecoveryFailure?: (failure: WorkflowRecoveryFailure) => void;
    lock?: {
        maxTries?: number;
        waitMs?: number;
    };
}
export interface WorkflowRecoveryFailure {
    runId: string;
    code: WorkflowStateError['code'] | 'RUN_FAILED' | 'RECOVERY_FAILED';
}
export interface WorkflowRunResult {
    runId: string;
    workflowId: string;
    status: WorkflowRunState['status'];
    output: unknown;
    ctx: WorkflowContext;
}
export declare class WorkflowRuntimeError extends Error {
    readonly code: 'SENSITIVE_STATE' | 'INVALID_STATE' | 'UNSUPPORTED_PARALLELISM' | 'RUN_NOT_RESUMABLE' | 'INVALID_RETRY' | 'INVALID_CONCURRENCY' | 'RESOURCE_LIMIT';
    constructor(message: string, code: 'SENSITIVE_STATE' | 'INVALID_STATE' | 'UNSUPPORTED_PARALLELISM' | 'RUN_NOT_RESUMABLE' | 'INVALID_RETRY' | 'INVALID_CONCURRENCY' | 'RESOURCE_LIMIT');
}
export declare class WorkflowRunFailedError extends Error {
    readonly runId: string;
    readonly status: 'failed' | 'unsafe_to_resume';
    readonly errorClass: WorkflowStepState['lastErrorClass'];
    constructor(runId: string, status: 'failed' | 'unsafe_to_resume', errorClass: WorkflowStepState['lastErrorClass']);
}
export declare class ClassifiedWorkflowError extends Error {
    readonly errorClass: WorkflowErrorClass;
    constructor(errorClass: WorkflowErrorClass, message?: string);
}
export declare function defaultWorkflowStateDir(): string;
export declare function deriveWorkflowId(spec: WorkflowSpec): string;
export declare function assertValidWorkflowSpec(value: unknown): asserts value is WorkflowSpec;
export declare class DurableWorkflowRuntime {
    private readonly deps;
    readonly store: WorkflowStateStore;
    private readonly core;
    private readonly now;
    private readonly sleep;
    private readonly classifyError;
    private readonly generateRunId;
    private readonly scheduler;
    private readonly maxConcurrentRuns;
    private readonly maxStepExecutions;
    private readonly inFlight;
    constructor(deps: WorkflowRuntimeDeps);
    start(spec: WorkflowSpec, options?: {
        runId?: string;
    } | string): Promise<WorkflowRunResult>;
    resume(runId: string, options?: WorkflowOperatorOptions): Promise<WorkflowRunResult>;
    operatorResume(runId: string, options: WorkflowOperatorOptions): Promise<WorkflowRunResult>;
    pause(runId: string, options: WorkflowOperatorOptions): Promise<WorkflowRunResult>;
    cancel(runId: string, options: WorkflowOperatorOptions): Promise<WorkflowRunResult>;
    approve(runId: string, gateId: string, options: WorkflowOperatorOptions): Promise<WorkflowRunResult>;
    reject(runId: string, gateId: string, options: WorkflowOperatorOptions): Promise<WorkflowRunResult>;
    status(runId: string): WorkflowRunState;
    history(runId: string): ReturnType<WorkflowStateStore['readHistory']>;
    recoverPending(): Promise<WorkflowRunResult[]>;
    protected isRecoveryCandidate(state: WorkflowRunState, control: WorkflowControlState): boolean;
    protected recoverRuns(shouldRecover: (runId: string) => boolean | Promise<boolean>, reportFailure: (runId: string, error: unknown) => void): Promise<WorkflowRunResult[]>;
    private scheduleRecoveryRun;
    private scheduleRun;
    private resumeLocked;
    private withLockedRun;
    private withConcurrencySlot;
    private validateResumeStateOrFail;
    private execute;
    private runSteps;
    private runStep;
    private lastStepOutput;
    private failState;
    private runApproval;
    private runLeaf;
    private runAgentAttempt;
    private observeCancellation;
    private checkpointCompletion;
    private enforceControlBoundary;
    private finalizeCancellation;
    private checkpoint;
    private safetyCheckpoint;
    private ensureApprovalDecisionHistory;
    private appendHistoryUnlessUnavailable;
    private historyEvent;
    private timestamp;
    private result;
    private reportRecoveryFailure;
}