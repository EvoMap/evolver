import type { Observer } from '../observers/observerBus.js';
import type { TraceTurnDraft } from './trajectory.js';
export declare const TRACE_EVENT_SCHEMA = "trace_event.v0";
export declare const LEARNING_PACKET_SCHEMA = "learning_packet.v0";
/** Lifecycle vocabulary for slice 1. Kept flat + closed so hub-side eventType stays queryable. */
export declare const TRACE_EVENT_TYPES: readonly ["run.started", "run.completed", "model.called", "tool.called", "tool.failed", "retry.attempted", "reflection.recorded", "intervention.received"];
export type TraceEventType = (typeof TRACE_EVENT_TYPES)[number];
/** Mirrors hub LearningOpsTraceEvent columns (eventId/eventType/traceId/sessionId/taskId/sequence/occurredAt/payload/metadata). */
export interface TraceEvent {
    schemaVersion: typeof TRACE_EVENT_SCHEMA;
    eventId: string;
    eventType: TraceEventType;
    /** Run-scoped trace id; every event of one agent run shares it. */
    traceId: string;
    sessionId?: string;
    taskId?: string;
    /** 1-based, strictly increasing per run — hub-side ordering key. */
    sequence: number;
    occurredAt: string;
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
}
export interface TraceSink {
    emit(event: TraceEvent): void;
}
export declare class InMemoryTraceSink implements TraceSink {
    readonly events: TraceEvent[];
    emit(event: TraceEvent): void;
}
/** JSONL append sink for local inspection / offline replay. */
export declare class FileTraceSink implements TraceSink {
    private readonly path;
    constructor(path: string);
    emit(event: TraceEvent): void;
}
export declare class ConsoleTraceSink implements TraceSink {
    private readonly log;
    constructor(log?: (line: string) => void);
    emit(event: TraceEvent): void;
}
export interface AgentRunTraceRecorderOptions {
    /** Stable run identity; becomes traceId and the packet sourceRun. */
    runId: string;
    sessionId?: string;
    taskId?: string;
    sink?: TraceSink;
    /** Injected clock for deterministic tests. */
    now?: () => number;
    /** Injected id factory for deterministic tests. */
    eventIdFactory?: (sequence: number) => string;
}
export interface RunStartedInput {
    taskSummary?: string;
    signals?: readonly string[];
    geneId?: string;
    metadata?: Record<string, unknown>;
}
export interface RunCompletedInput {
    status: 'success' | 'failed';
    score?: number;
    reason?: string;
    producedValue?: boolean;
    failureKind?: string;
}
export interface ModelCalledInput {
    provider?: string;
    model?: string;
    requestId?: string;
    latencyMs?: number;
    usage?: Record<string, unknown>;
    stopReason?: string;
}
export interface ToolCalledInput {
    toolName: string;
    callId?: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
}
export interface ToolFailedInput {
    toolName: string;
    callId?: string;
    error: string;
}
export interface RetryInput {
    attempt: number;
    reason?: string;
    target?: string;
}
export interface ReflectionInput {
    outcome: string;
    action?: string;
    summary?: string;
}
export interface InterventionInput {
    kind: string;
    actorId?: string;
    detail?: string;
}
/**
 * Per-run trace recorder: the single hook surface the runtime calls at lifecycle points.
 * Sequence numbers are assigned here (monotonic per run), so downstream ordering never depends on
 * sink latency or clock resolution.
 */
export declare class AgentRunTraceRecorder {
    private readonly opts;
    private sequence;
    private readonly recorded;
    constructor(opts: AgentRunTraceRecorderOptions);
    get events(): readonly TraceEvent[];
    runStarted(input?: RunStartedInput): TraceEvent;
    modelCalled(input?: ModelCalledInput): TraceEvent;
    toolCalled(input: ToolCalledInput): TraceEvent;
    toolFailed(input: ToolFailedInput): TraceEvent;
    retryAttempted(input: RetryInput): TraceEvent;
    reflectionRecorded(input: ReflectionInput): TraceEvent;
    interventionReceived(input: InterventionInput): TraceEvent;
    runCompleted(input: RunCompletedInput): TraceEvent;
    /** Fold one normalized llm_turn (trace/trajectory.ts) into model.called + tool.called/tool.failed events. */
    recordLlmTurn(turn: TraceTurnDraft): TraceEvent[];
    private record;
}
/**
 * Bypass-side bridge (never blocks the write path): maps the engine's existing root events onto the
 * run's TraceEvent stream, so CycleEngine needs no code change for run start/completion, reflection,
 * or human intervention coverage.
 */
export declare function learningTraceObserver(deps: {
    recorder: AgentRunTraceRecorder;
    timeoutMs?: number;
}): Observer;
export interface LearningPacketDraftInput {
    /** e.g. 'evolver-v2'. Hub column sourceRepo. */
    sourceRepo: string;
    taskSummary?: string;
    signals?: readonly string[];
    environment?: Record<string, unknown>;
}
/** Local draft aligned with hub LearningOpsPacket ingest fields; placeholders are explicit, not implied. */
export interface LearningPacketDraft {
    schemaVersion: typeof LEARNING_PACKET_SCHEMA;
    status: 'draft';
    source: {
        repo: string;
        run: string;
        type: 'agent_run';
        id: string;
    };
    task: {
        taskId: string | null;
        summary: string | null;
        signals: string[];
    };
    context: {
        sessionId: string | null;
        traceId: string;
        environment: Record<string, unknown>;
    };
    trajectory: TraceEvent[];
    artifacts: {
        placeholder: true;
        items: never[];
    };
    evaluation: {
        placeholder: true;
        outcomeStatus: 'success' | 'failed' | 'unknown';
        verifier: null;
        failureCategory: string | null;
    };
    governance: {
        placeholder: true;
        redactionStatus: 'metadata_only';
        consentStatus: 'unknown';
        trainingEligible: false;
        retentionPolicy: 'standard';
    };
}
export declare function buildLearningPacketDraft(recorder: AgentRunTraceRecorder, input: LearningPacketDraftInput): LearningPacketDraft;
export interface LearningPacketSubmitResult {
    accepted: boolean;
    reason?: string;
}
export interface LearningPacketSink {
    submit(draft: LearningPacketDraft): Promise<LearningPacketSubmitResult>;
}
export declare class InMemoryLearningPacketSink implements LearningPacketSink {
    readonly drafts: LearningPacketDraft[];
    submit(draft: LearningPacketDraft): Promise<LearningPacketSubmitResult>;
}
/** Writes one JSON file per run — the offline/no-hub path (and a manual-inspection artifact). */
export declare class FileLearningPacketSink implements LearningPacketSink {
    private readonly dir;
    constructor(dir: string);
    submit(draft: LearningPacketDraft): Promise<LearningPacketSubmitResult>;
}