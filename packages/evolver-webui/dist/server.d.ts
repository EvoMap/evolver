import { events as ev, assetstore, mailbox as mb, ops } from '@evomap/evolver-core';
import { type EventSnapshotSource } from './eventSnapshot.js';
export interface MemoryGraphStatus {
    recovery: 'healthy' | 'degraded' | 'recovered' | 'empty';
    compactedRecords: number;
    activeRecords: number;
    corruptLines: number;
    oversizedLines: number;
    oversizedFiles: number;
    archives: number;
    selectionReason?: string;
}
export type MemoryGraphStatusResponse = ({
    available: true;
} & MemoryGraphStatus) | {
    available: false;
    error?: 'memory_graph_unavailable';
};
type MaybePromise<T> = T | Promise<T>;
export interface WorkflowRunSummary {
    runId: string;
    workflowId: string;
    status: string;
    currentStep: string | null;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
}
export interface WorkflowHistoryEntry {
    sequence: number;
    timestamp: string;
    type: string;
    status?: string | null;
    stepId?: string | null;
    executionId?: string | null;
    gateId?: string | null;
    attempt?: number | null;
    actorId?: string | null;
    errorClass?: string | null;
}
/** Operator-safe workflow projection. Filesystem paths and raw durable state remain owned by the composition layer. */
export interface WorkflowProvider {
    listRuns(): MaybePromise<readonly WorkflowRunSummary[]>;
    getRun(runId: string): MaybePromise<WorkflowRunSummary | null>;
    getHistory(runId: string): MaybePromise<readonly WorkflowHistoryEntry[] | null>;
}
export interface WebUIServerDeps {
    eventsPath: string;
    ingestor?: ev.Ingestor;
    store?: assetstore.AssetStoreProvider;
    /** 人审队列用的 review ledger(#117 人审门）。缺省由 LocalJsonlProvider store 的 baseDir 推导。 */
    review?: assetstore.ReviewLedger;
    /** Optional provenance sidecar; inferred for a LocalJsonlProvider when absent. */
    provenance?: assetstore.ProvenanceStore;
    mailbox?: mb.MailboxStore;
    now?: () => number;
    host?: string;
    /** 人工操作记的 actor id. */
    actorId?: string;
    /** Bearer token required for all /api/* routes; auto-generated if absent. Loopback alone is not an
     *  auth boundary on shared hosts. The launcher passes it in a URL fragment; ?token= remains compatible. */
    token?: string;
    /** One-time launcher ticket exchanged for an HttpOnly session cookie. */
    launchTicket?: string;
    /** Value-card data provider (#113). Injected by the composition layer wired to ops.loadValueSummary over the
     *  proxy traces + root_events + the adapter's price table — the WebUI stays a THIN shell (it never prices or
     *  re-derives savings; M7 克制). Absent → /api/value reports an empty summary instead of failing. */
    valueSummary?: (window: ops.SummaryWindow, events: readonly ev.ReportEvent[]) => ops.ValueSummary;
    /** Shared core retention report provider. Kept injectable so WebUI never owns filesystem policy or paths. */
    retentionReport?: () => ev.RetentionReport;
    /** Read-only, already scoped MemoryGraph operator status. Re-read for every request; WebUI only exposes a sanitized allowlist. */
    memoryGraphStatus?: () => MemoryGraphStatus;
    /** Injectable file/source seam for versioned root-event snapshots. */
    eventSource?: EventSnapshotSource;
    /** Optional bounded diagnostics providers. Each source degrades independently. */
    personalityDiagnostics?: () => unknown | Promise<unknown>;
    logDiagnostics?: () => unknown | Promise<unknown>;
    githubPrDiagnostics?: () => unknown | Promise<unknown>;
    /** Durable workflow visibility provider. Only safe summaries/history metadata may cross this boundary. */
    workflow?: WorkflowProvider;
}
/**
 * WebUI 控台(M7): 可观测 + 保活. node:http + 自包含 HTML, 仅绑 loopback.
 * 复用 core events/reports 报表 + assetstore + mailbox; 人工操作 Observe/Nudge/Intervene/Teach 走 ingest(actor.kind=human).
 */
export declare class WebUIServer {
    private readonly deps;
    private readonly server;
    private readonly ingestor;
    private readonly host;
    private readonly now;
    private readonly actorId;
    /** Review ledger backing the human-review queue. Undefined when no LocalJsonlProvider store is available. */
    private readonly review;
    private readonly provenance;
    /** Token guarding /api/*; supplied by the browser via Bearer, with ?token= retained for compatibility. */
    readonly token: string;
    readonly launchTicket: string;
    private launchTicketAvailable;
    private readonly eventSnapshots;
    constructor(deps: WebUIServerDeps);
    listen(port?: number): Promise<number>;
    private listenOnce;
    close(): Promise<void>;
    private handle;
    private readJson;
    private json;
    private apiError;
    private methodNotAllowed;
    private send;
}
export {};