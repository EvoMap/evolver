// Agent runtime trace instrumentation (Learning Ops slice 1).
// Aligns with evomap-hub Learning Ops data plane contract (schemaVersion `trace_event.v0` /
// `learning_packet.v0`): the runtime emits ordered TraceEvents over the agent-run lifecycle and
// assembles a LearningPacket DRAFT locally. Hub delivery goes through the LearningPacketSink port —
// core never hardcodes a hub endpoint (file/console/memory sinks let a run trace without hub access).
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export const TRACE_EVENT_SCHEMA = 'trace_event.v0';
export const LEARNING_PACKET_SCHEMA = 'learning_packet.v0';
/** Lifecycle vocabulary for slice 1. Kept flat + closed so hub-side eventType stays queryable. */
export const TRACE_EVENT_TYPES = [
    'run.started',
    'run.completed',
    'model.called',
    'tool.called',
    'tool.failed',
    'retry.attempted',
    'reflection.recorded',
    'intervention.received',
];
export class InMemoryTraceSink {
    events = [];
    emit(event) { this.events.push(event); }
}
/** JSONL append sink for local inspection / offline replay. */
export class FileTraceSink {
    path;
    constructor(path) {
        this.path = path;
    }
    emit(event) {
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
    }
}
export class ConsoleTraceSink {
    log;
    constructor(log = (line) => console.error(line)) {
        this.log = log;
    }
    emit(event) { this.log(`[trace] ${event.sequence} ${event.eventType} ${JSON.stringify(event.payload)}`); }
}
/**
 * Per-run trace recorder: the single hook surface the runtime calls at lifecycle points.
 * Sequence numbers are assigned here (monotonic per run), so downstream ordering never depends on
 * sink latency or clock resolution.
 */
export class AgentRunTraceRecorder {
    opts;
    sequence = 0;
    recorded = [];
    constructor(opts) {
        this.opts = opts;
    }
    get events() { return this.recorded; }
    get sessionId() { return this.opts.sessionId; }
    /**
     * Late-bind a session id discovered after run start (e.g. unique proxy llm_turn session).
     * Backfills already-recorded events so the whole trajectory carries the join key.
     * Fail closed on empty/whitespace values and conflicting rebinds.
     */
    bindSessionId(sessionId) {
        const next = sessionId.trim();
        if (next.length === 0) {
            throw new Error('sessionId must be a non-empty string');
        }
        const current = this.opts.sessionId;
        if (current !== undefined) {
            if (current === next)
                return;
            throw new Error(`sessionId already bound to ${current}; refusing to rebind to ${next}`);
        }
        this.opts.sessionId = next;
        for (const event of this.recorded) {
            event.sessionId = next;
        }
    }
    runStarted(input = {}) {
        return this.record('run.started', {
            ...(input.taskSummary !== undefined ? { taskSummary: input.taskSummary } : {}),
            ...(input.signals !== undefined ? { signals: [...input.signals] } : {}),
            ...(input.geneId !== undefined ? { geneId: input.geneId } : {}),
        }, input.metadata);
    }
    modelCalled(input = {}) {
        return this.record('model.called', {
            ...(input.provider !== undefined ? { provider: input.provider } : {}),
            ...(input.model !== undefined ? { model: input.model } : {}),
            ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
            ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
            ...(input.usage !== undefined ? { usage: input.usage } : {}),
            ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
        });
    }
    toolCalled(input) {
        return this.record('tool.called', {
            toolName: input.toolName,
            ...(input.callId !== undefined ? { callId: input.callId } : {}),
            ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        }, input.metadata);
    }
    toolFailed(input) {
        return this.record('tool.failed', {
            toolName: input.toolName,
            ...(input.callId !== undefined ? { callId: input.callId } : {}),
            error: input.error,
        });
    }
    retryAttempted(input) {
        return this.record('retry.attempted', {
            attempt: input.attempt,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...(input.target !== undefined ? { target: input.target } : {}),
        });
    }
    reflectionRecorded(input) {
        return this.record('reflection.recorded', {
            outcome: input.outcome,
            ...(input.action !== undefined ? { action: input.action } : {}),
            ...(input.summary !== undefined ? { summary: input.summary } : {}),
        });
    }
    interventionReceived(input) {
        return this.record('intervention.received', {
            kind: input.kind,
            ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
            ...(input.detail !== undefined ? { detail: input.detail } : {}),
        });
    }
    runCompleted(input) {
        return this.record('run.completed', {
            status: input.status,
            ...(input.score !== undefined ? { score: input.score } : {}),
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...(input.producedValue !== undefined ? { producedValue: input.producedValue } : {}),
            ...(input.failureKind !== undefined ? { failureKind: input.failureKind } : {}),
        });
    }
    /** Fold one normalized llm_turn (trace/trajectory.ts) into model.called + tool.called/tool.failed events. */
    recordLlmTurn(turn) {
        const out = [this.modelCalled({
                ...(turn.provider !== null ? { provider: turn.provider } : {}),
                ...(turn.chosen_model !== null ? { model: turn.chosen_model } : {}),
                ...(turn.request_id !== null ? { requestId: turn.request_id } : {}),
                ...(turn.latency_ms !== null ? { latencyMs: turn.latency_ms } : {}),
                ...(turn.usage !== undefined ? { usage: { ...turn.usage } } : {}),
                ...(typeof turn.stop_reason === 'string' ? { stopReason: turn.stop_reason } : {}),
            })];
        if (Array.isArray(turn.tool_calls)) {
            for (const call of turn.tool_calls) {
                const rec = call;
                const toolName = typeof rec.name === 'string' && rec.name.length > 0 ? rec.name : 'unknown_tool';
                const callId = typeof rec.id === 'string' ? rec.id : undefined;
                out.push(typeof rec.error === 'string' && rec.error.length > 0
                    ? this.toolFailed({ toolName, ...(callId !== undefined ? { callId } : {}), error: rec.error })
                    : this.toolCalled({ toolName, ...(callId !== undefined ? { callId } : {}) }));
            }
        }
        return out;
    }
    record(eventType, payload, metadata) {
        this.sequence += 1;
        const at = (this.opts.now ?? Date.now)();
        const event = {
            schemaVersion: TRACE_EVENT_SCHEMA,
            eventId: (this.opts.eventIdFactory ?? ((seq) => `${this.opts.runId}-${String(seq).padStart(4, '0')}`))(this.sequence),
            eventType,
            traceId: this.opts.runId,
            ...(this.opts.sessionId !== undefined ? { sessionId: this.opts.sessionId } : {}),
            ...(this.opts.taskId !== undefined ? { taskId: this.opts.taskId } : {}),
            sequence: this.sequence,
            occurredAt: new Date(at).toISOString(),
            payload,
            metadata: metadata ?? {},
        };
        this.recorded.push(event);
        this.opts.sink?.emit(event);
        return event;
    }
}
/* ── Root-event bridge: existing cycle lifecycle → trace events, via the sanctioned ObserverBus ── */
const BRIDGED_EVENT_TYPES = [
    'cycle.started', 'cycle.solidified', 'cycle.failed',
    'reflection.recorded',
    'actor.human.nudge', 'actor.human.intervene', 'actor.human.teach',
    'actor.human.review.approve', 'actor.human.review.reject',
];
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
/**
 * Bypass-side bridge (never blocks the write path): maps the engine's existing root events onto the
 * run's TraceEvent stream, so CycleEngine needs no code change for run start/completion, reflection,
 * or human intervention coverage.
 */
export function learningTraceObserver(deps) {
    const meta = {
        name: 'learning_trace',
        eventTypes: BRIDGED_EVENT_TYPES,
        idempotent: true,
        timeoutMs: deps.timeoutMs ?? 2_000,
    };
    return {
        meta,
        handle(event) {
            const payload = asRecord(event.payload) ?? {};
            if (event.type === 'cycle.started') {
                deps.recorder.runStarted({ metadata: { cycleId: payload['cycleId'] ?? null } });
                return;
            }
            if (event.type === 'cycle.solidified' || event.type === 'cycle.failed') {
                const outcome = asRecord(payload['outcome']);
                const status = event.type === 'cycle.solidified' ? 'success' : 'failed';
                const score = typeof outcome?.['score'] === 'number' ? outcome['score'] : undefined;
                const reason = typeof payload['error'] === 'string'
                    ? payload['error']
                    : typeof payload['reason'] === 'string' ? payload['reason'] : undefined;
                deps.recorder.runCompleted({
                    status,
                    ...(score !== undefined ? { score } : {}),
                    ...(reason !== undefined ? { reason } : {}),
                    ...(typeof payload['producedValue'] === 'boolean' ? { producedValue: payload['producedValue'] } : {}),
                    ...(typeof payload['failureKind'] === 'string' ? { failureKind: payload['failureKind'] } : {}),
                });
                return;
            }
            if (event.type === 'reflection.recorded') {
                deps.recorder.reflectionRecorded({
                    outcome: typeof payload['outcome'] === 'string' ? payload['outcome'] : 'unknown',
                    ...(typeof payload['action'] === 'string' ? { action: payload['action'] } : {}),
                    ...(typeof payload['summary'] === 'string' ? { summary: payload['summary'] } : {}),
                });
                return;
            }
            // actor.human.*: host/human intervention audit trail.
            deps.recorder.interventionReceived({
                kind: event.type.replace(/^actor\.human\./, ''),
                ...(event.actor.id !== undefined ? { actorId: event.actor.id } : {}),
                ...(typeof payload['detail'] === 'string' ? { detail: payload['detail'] } : {}),
            });
        },
    };
}
export function buildLearningPacketDraft(recorder, input) {
    const events = [...recorder.events].sort((a, b) => a.sequence - b.sequence);
    const first = events[0];
    const completed = [...events].reverse().find((e) => e.eventType === 'run.completed');
    const completedStatus = completed?.payload['status'];
    const failureKind = completed?.payload['failureKind'];
    const started = events.find((e) => e.eventType === 'run.started');
    const startedSummary = started?.payload['taskSummary'];
    return {
        schemaVersion: LEARNING_PACKET_SCHEMA,
        status: 'draft',
        source: { repo: input.sourceRepo, run: first?.traceId ?? 'unknown-run', type: 'agent_run', id: first?.traceId ?? 'unknown-run' },
        task: {
            taskId: first?.taskId ?? null,
            summary: input.taskSummary ?? (typeof startedSummary === 'string' ? startedSummary : null),
            signals: [...(input.signals ?? [])],
        },
        context: {
            sessionId: first?.sessionId ?? null,
            traceId: first?.traceId ?? 'unknown-run',
            environment: input.environment ?? {},
        },
        trajectory: events,
        artifacts: { placeholder: true, items: [] },
        evaluation: {
            placeholder: input.verification === undefined,
            outcomeStatus: completedStatus === 'success' ? 'success' : completedStatus === 'failed' ? 'failed' : 'unknown',
            verifier: input.verification?.verifier ?? null,
            ...(input.verification !== undefined ? { verifierPassed: input.verification.passed } : {}),
            ...(input.verification?.score !== undefined ? { verifierScore: input.verification.score } : {}),
            failureCategory: typeof failureKind === 'string' ? failureKind : null,
        },
        governance: { placeholder: true, redactionStatus: 'metadata_only', consentStatus: 'unknown', trainingEligible: false, retentionPolicy: 'standard' },
    };
}
export class InMemoryLearningPacketSink {
    drafts = [];
    async submit(draft) {
        this.drafts.push(draft);
        return { accepted: true };
    }
}
/** Writes one JSON file per run — the offline/no-hub path (and a manual-inspection artifact). */
export class FileLearningPacketSink {
    dir;
    constructor(dir) {
        this.dir = dir;
    }
    async submit(draft) {
        mkdirSync(this.dir, { recursive: true });
        const path = `${this.dir}/${draft.source.run}.learning-packet.json`;
        writeFileSync(path, `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
        return { accepted: true, reason: path };
    }
}