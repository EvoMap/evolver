import type { LlmTurnTrace, RouterLogger } from '../router/messagesRoute.js';
import { type TraceBackfillStats, type TraceUploadMailboxStore } from './traceBackfill.js';
export declare const DEFAULT_TRACE_FILE_CAP_BYTES: number;
export interface JsonlTraceSinkOptions {
    dir: string;
    /** Injected clock (testability + day-file naming). Default Date.now. */
    now?: () => number;
    /** Per-day-file size cap; beyond it the day's writes are dropped (warned once). Disk is a hard budget for
     * an always-on proxy — dropping trace tails beats growing an unbounded JSONL until the daemon OOMs on it. */
    fileCapBytes?: number;
    logger?: RouterLogger;
    env?: NodeJS.ProcessEnv;
    /** Optional outbound mailbox path for Hub-decryptable trace envelopes. Failures are best-effort only. */
    mailboxStore?: TraceUploadMailboxStore;
    runtimeNamespace?: string;
    sourceAgent?: string;
    targetAgent?: string;
    nodeSecretVersion?: unknown;
    producerVersion?: string;
}
interface TraceNodeSecretMaterial {
    nodeSecret?: string;
    nodeSecretVersion?: number;
}
export declare function resolveTraceNodeSecretMaterial(env?: NodeJS.ProcessEnv, store?: Pick<TraceUploadMailboxStore, 'getState'>, explicitNodeSecretVersion?: unknown): TraceNodeSecretMaterial;
export declare function resolveTraceNodeSecretVersion(env?: NodeJS.ProcessEnv, store?: Pick<TraceUploadMailboxStore, 'getState'>, explicitNodeSecretVersion?: unknown): number | undefined;
/**
 * Append-only NDJSON sink, one file per UTC day (`llm-trace-YYYYMMDD.jsonl`). Fire-and-forget writes; any
 * failure (bad dir, full disk, cap reached) degrades to a single warn and NEVER propagates — trace capture
 * must not be able to break serving.
 */
export declare class JsonlTraceSink {
    private readonly opts;
    private readonly now;
    private readonly cap;
    private readonly log;
    private warned;
    private chmodWarned;
    private envelopeWarned;
    private plaintextWarned;
    private mailboxWarned;
    private cappedDay;
    private securedFiles;
    /** Appends are chained, not raced: two in-flight fs appends to one path have no ordering guarantee, and
     * out-of-order trace lines would corrupt the day-file as a timeline. Still fire-and-forget to callers. */
    private tail;
    constructor(opts: JsonlTraceSinkOptions);
    filePath(): string;
    /**
     * Await the appends queued so far. write() is fire-and-forget (it chains the fs append onto `tail` and returns),
     * so a caller that needs the trace durable on disk — a graceful shutdown, or a test asserting file contents —
     * must await this rather than guess a wall-clock delay. Never rejects: write() already swallows append errors
     * into `tail`.
     */
    flush(): Promise<void>;
    write: (record: LlmTurnTrace) => void;
    private secureTraceFile;
    private enqueueOutboundTrace;
    backfillExistingTraceUploads(): TraceBackfillStats | null;
}
export {};