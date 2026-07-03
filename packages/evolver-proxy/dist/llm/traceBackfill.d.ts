import { mailbox } from '@evomap/evolver-core';
import type { HubDecryptableTraceEnvelope } from './traceEnvelope.js';
import { type ProxyTraceUploadPayload } from './traceUploadPayload.js';
export interface TraceUploadMailboxStore {
    send(e: mailbox.Envelope): {
        receiptId: string;
        stored: boolean;
    };
    countPending?(handler?: string, runtimeNamespace?: string): number;
    getState?(key: string): string | undefined;
    setState?(key: string, value: string): void;
    hasMessageWithIdempotencyKey?(idempotencyKey: string): boolean;
    hasMessageWithPayload?(type: string, payload: unknown): boolean;
}
export interface TraceBackfillStats {
    scanned: number;
    queued: number;
    duplicates: number;
    skipped: number;
    files: number;
    reasons: Record<string, number>;
}
type TraceDecryptStateStore = Pick<TraceUploadMailboxStore, 'getState'>;
export declare function isHubDecryptableTraceEnvelope(record: unknown): record is HubDecryptableTraceEnvelope;
export declare function traceUploadBlockedReason(record: HubDecryptableTraceEnvelope): string | undefined;
export declare function normalizeProxyTraceOutboundPayload(payload: unknown, env?: NodeJS.ProcessEnv, store?: TraceDecryptStateStore): {
    ok: true;
    payload: ProxyTraceUploadPayload;
} | {
    ok: false;
    reason: string;
};
export declare function traceUploadIdempotencyKey(record: HubDecryptableTraceEnvelope): string;
export declare function enqueueTraceEnvelope(store: TraceUploadMailboxStore, record: HubDecryptableTraceEnvelope, opts?: {
    now?: number;
    runtimeNamespace?: string;
    sourceAgent?: string;
    targetAgent?: string;
    env?: NodeJS.ProcessEnv;
}): {
    queued: boolean;
    duplicate: boolean;
};
export declare function backfillProxyTraceUploads(opts: {
    dir: string;
    store: TraceUploadMailboxStore;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    runtimeNamespace?: string;
    sourceAgent?: string;
    targetAgent?: string;
}): TraceBackfillStats;
export {};