import { type AcquireLockOptions } from '../util/fileLock.js';
import { type WorkflowErrorClass, type WorkflowSpec } from './dsl.js';
export declare const WORKFLOW_RUN_SCHEMA_VERSION = 4;
export declare const WORKFLOW_DEFINITION_SCHEMA_VERSION = 1;
declare const WORKFLOW_CONTROL_SCHEMA_VERSION = 1;
export declare const MAX_WORKFLOW_HISTORY_EVENTS = 4096;
export declare const MAX_WORKFLOW_HISTORY_BYTES: number;
export type WorkflowRunStatus = 'queued' | 'pending' | 'running' | 'retry_wait' | 'pause_requested' | 'paused' | 'cancel_requested' | 'cancelled' | 'waiting_approval' | 'succeeded' | 'failed' | 'unsafe_to_resume';
export type WorkflowSafeErrorClass = WorkflowErrorClass | 'sensitive_output' | 'interrupted_non_idempotent' | 'invalid_control_flow' | 'invalid_output' | 'approval_rejected' | 'resource_limit';
export interface WorkflowStepState {
    executionId: string;
    stepId: string;
    kind: 'script' | 'agent' | 'approval';
    idempotency: 'idempotent' | 'non_idempotent';
    status: 'pending' | 'running' | 'retry_wait' | 'waiting_approval' | 'succeeded' | 'failed';
    attempts: number;
    maxAttempts: number;
    nextAttemptAt?: string;
    lastErrorClass?: WorkflowSafeErrorClass;
    output?: unknown;
    startedAt?: string;
    completedAt?: string;
}
export interface WorkflowApprovalState {
    gateId: string;
    executionId: string;
    requestedAt: string;
}
export interface WorkflowRunState {
    schemaVersion: typeof WORKFLOW_RUN_SCHEMA_VERSION;
    workflowSchemaVersion: typeof WORKFLOW_DEFINITION_SCHEMA_VERSION;
    workflowId: string;
    definitionDigest: string;
    runId: string;
    workflowName: string;
    status: WorkflowRunStatus;
    spec: WorkflowSpec;
    context: {
        input: Record<string, unknown>;
        steps: Record<string, unknown>;
    };
    steps: Record<string, WorkflowStepState>;
    currentStep?: string;
    approval?: WorkflowApprovalState;
    lastErrorClass?: WorkflowSafeErrorClass;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
}
export type WorkflowHistoryEventType = 'run_created' | 'run_queued' | 'run_started' | 'run_succeeded' | 'run_failed' | 'step_started' | 'step_retry_scheduled' | 'step_succeeded' | 'step_failed' | 'pause_requested' | 'paused' | 'resume_requested' | 'cancel_requested' | 'cancelled' | 'approval_waiting' | 'approval_approved' | 'approval_rejected' | 'recovery_started' | 'unsafe_to_resume';
export interface WorkflowHistoryEvent {
    sequence: number;
    eventId: string;
    runId: string;
    workflowId: string;
    type: WorkflowHistoryEventType;
    status: WorkflowRunStatus;
    at: string;
    executionId?: string;
    stepId?: string;
    gateId?: string;
    attempt?: number;
    actor?: string;
    reason?: string;
    errorClass?: WorkflowSafeErrorClass;
}
export type WorkflowHistoryEventInput = Omit<WorkflowHistoryEvent, 'sequence' | 'eventId'>;
export interface WorkflowOperatorOptions {
    actor: string;
    reason?: string;
}
export interface WorkflowOperatorRequest extends WorkflowOperatorOptions {
    requestedAt: string;
}
export interface WorkflowApprovalDecision extends WorkflowOperatorRequest {
    gateId: string;
    executionId: string;
    decision: 'approved' | 'rejected';
}
export interface WorkflowControlState {
    schemaVersion: typeof WORKFLOW_CONTROL_SCHEMA_VERSION;
    pause?: WorkflowOperatorRequest;
    cancel?: WorkflowOperatorRequest;
    approvals: Record<string, WorkflowApprovalDecision>;
}
export declare class WorkflowStateError extends Error {
    readonly code: 'INVALID_ID' | 'INVALID_TRANSITION' | 'CORRUPT_STATE' | 'UNSUPPORTED_SCHEMA' | 'UNSAFE_PATH' | 'INSECURE_PERMISSIONS' | 'STATE_NOT_FOUND' | 'RESOURCE_LIMIT';
    constructor(message: string, code: 'INVALID_ID' | 'INVALID_TRANSITION' | 'CORRUPT_STATE' | 'UNSUPPORTED_SCHEMA' | 'UNSAFE_PATH' | 'INSECURE_PERMISSIONS' | 'STATE_NOT_FOUND' | 'RESOURCE_LIMIT');
}
export declare function assertStableId(value: string, label: string): void;
export declare function findWorkflowJsonViolation(value: unknown): string | null;
export declare function deriveWorkflowDefinitionDigest(spec: WorkflowSpec): string;
export interface WorkflowStateStoreOptions {
    lock?: AcquireLockOptions;
    maxHistoryEvents?: number;
    maxHistoryBytes?: number;
    /** Runs synchronously under the per-run commit lock; must not call back into this store. */
    onTransactionPhase?: (context: WorkflowTransactionPhaseContext) => void;
}
export type WorkflowTransactionPhase = 'wal_persisted' | 'state_projected' | 'control_projected' | 'history_projected' | 'before_wal_clear';
export interface WorkflowTransactionPhaseContext {
    runId: string;
    transactionId: string;
    mode: 'commit' | 'replay';
    phase: WorkflowTransactionPhase;
}
export interface WorkflowControlPatch {
    pause?: WorkflowOperatorRequest | null;
    cancel?: WorkflowOperatorRequest | null;
}
export declare class WorkflowStateStore {
    private readonly options;
    readonly root: string;
    private readonly maxHistoryEvents;
    private readonly maxHistoryBytes;
    constructor(root: string, options?: WorkflowStateStoreOptions);
    ensureConcurrencyLimit(limit: number): number;
    tryAcquireConcurrencySlot(limit: number): number | null;
    releaseConcurrencySlot(slot: number): void;
    private concurrencySlotPath;
    statePath(runId: string): string;
    private controlPath;
    private historyPath;
    private commitLockPath;
    private legacyControlLockPath;
    private legacyHistoryLockPath;
    private transactionPath;
    lockPath(runId: string): string;
    withRunLock<T>(runId: string, fn: () => T): T;
    acquireRunLock(runId: string): void;
    releaseRunLock(runId: string): void;
    readStored(runId: string): WorkflowRunState;
    private readStoredUnlocked;
    private readOptionalStoredUnlocked;
    read(runId: string): WorkflowRunState;
    listRunIds(): string[];
    list(): WorkflowRunState[];
    write(state: WorkflowRunState): void;
    commit(state: WorkflowRunState, history?: WorkflowHistoryEventInput[], controlPatch?: WorkflowControlPatch): WorkflowHistoryEvent[];
    /** Commit a completion only when no durable cancellation won the commit-lock race. */
    commitUnlessCancelled(state: WorkflowRunState, history?: WorkflowHistoryEventInput[]): WorkflowOperatorRequest | undefined;
    /** Last-resort state/control projection when bounded or corrupt history prevents a safety transition. */
    commitSafetyState(state: WorkflowRunState, controlPatch?: WorkflowControlPatch): void;
    readControl(runId: string): WorkflowControlState;
    private readControlUnlocked;
    requestPause(runId: string, options: WorkflowOperatorOptions, requestedAt?: string): void;
    requestPauseWithHistory(runId: string, options: WorkflowOperatorOptions, requestedAt?: string): void;
    clearPauseRequest(runId: string): void;
    requestCancel(runId: string, options: WorkflowOperatorOptions, requestedAt?: string): void;
    requestCancelWithHistory(runId: string, options: WorkflowOperatorOptions, requestedAt?: string): void;
    clearCancelRequest(runId: string): void;
    approve(runId: string, gateId: string, options: WorkflowOperatorOptions, requestedAt?: string): void;
    reject(runId: string, gateId: string, options: WorkflowOperatorOptions, requestedAt?: string): void;
    private decideApproval;
    appendHistory(input: WorkflowHistoryEventInput): WorkflowHistoryEvent;
    readHistory(runId: string): WorkflowHistoryEvent[];
    history(runId: string): WorkflowHistoryEvent[];
    private readHistoryUnlocked;
    private transact;
    private transactSelected;
    private requestControl;
    private requestControlOnly;
    private persistTransactionUnlocked;
    private replayTransactionUnlocked;
    private readTransactionUnlocked;
    private applyTransactionUnlocked;
    private assertProjectionBase;
    private notifyTransactionPhase;
    private patchControl;
    private withCommitLock;
}
export {};