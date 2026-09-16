import type { AssetRecord } from '../assetstore/provider.js';
import type { SourceAccessEvidence, SourceQualificationRequest } from '../assetstore/sourceQualification.js';
import { type ReferenceBinding, type ReferencePair, type ReferencePolicy } from './referenceAccess.js';
interface AccessPayload {
    schema: 'benchmark-reference-access.v1';
    benchmarkId: string;
    runId: string;
    policyDigest: string;
    key: string;
    callId: string;
    resourceDigest: string;
    locator: string;
    kind: SourceAccessEvidence['kind'];
    origin: 'controlled' | 'observed';
    phase: 'attempt' | 'result';
    outcome: 'attempted' | 'read' | 'failed' | 'blocked' | 'unknown';
    reason?: string;
    operationReason?: string;
    resultDigest?: string;
    sourceEventDigest?: string;
    sourceTrajectoryDigest?: string;
    bindingDigest?: string;
    startLine?: number;
    endLine?: number;
}
export interface ReferenceAccessReceipt extends AccessPayload {
    journalEventId: string;
    journalTs: string;
    eventDigest: string;
}
export declare class ReferenceAccessError extends Error {
    readonly code: string;
    readonly receipt?: ReferenceAccessReceipt | undefined;
    readonly operationCode?: string | undefined;
    readonly retryCleanup?: (() => Promise<void>) | undefined;
    constructor(code: string, receipt?: ReferenceAccessReceipt | undefined, operationCode?: string | undefined, retryCleanup?: (() => Promise<void>) | undefined);
}
export interface ReferenceAccessOptions {
    policy: unknown;
    runId: string;
    eventsPath: string;
    mode: 'enforce' | 'observe';
    timeoutMs?: number;
}
/** 只控制本对象提供的GET/file-read；不宣称任意Pi/shell进程已被OS隔离。 */
export declare class ReferenceAccessController {
    readonly policy: ReferencePolicy;
    readonly policyDigest: string;
    private readonly runId;
    private readonly mode;
    private readonly timeoutMs;
    private readonly ingestor;
    private readonly lockPath;
    private readonly token;
    private readonly lockIdentity;
    private readonly history;
    private readonly journalProofs;
    private readonly claimed;
    private readonly callIdentity;
    private readonly observing;
    private readonly pending;
    private readonly abort;
    private closing;
    private readonly journalParent;
    private readonly parentIdentity;
    private readonly fileRoots;
    private journalIdentity;
    private observedTrajectory;
    private fileReader;
    private nativeClosed;
    constructor(options: ReferenceAccessOptions);
    capabilities(): {
        mode: "enforce" | "observe";
        httpGet: boolean;
        fileRead: boolean;
        arbitraryProcessContainment: boolean;
        observationCoverage: "partial";
    };
    private assertLease;
    private receipt;
    private assertJournalIdentity;
    private assertCurrentJournal;
    private append;
    private base;
    private filePolicy;
    private track;
    private perform;
    get(callId: string, urlValue: string, signal?: AbortSignal): Promise<{
        data: Uint8Array;
        receipt: ReferenceAccessReceipt;
    }>;
    readFile(callId: string, path: string): Promise<{
        data: Uint8Array;
        receipt: ReferenceAccessReceipt;
    }>;
    observe(trajectoryDigest: string, pair: ReferencePair, binding: ReferenceBinding): Promise<ReferenceAccessReceipt>;
    qualification(asset: AssetRecord, trajectoryDigest: string): {
        request: SourceQualificationRequest;
        total: number;
        omitted: number;
    };
    close(): Promise<void>;
}
export {};