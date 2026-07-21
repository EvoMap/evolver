import { mailbox } from '@evomap/evolver-core';
import type { ForceUpdateDirective, SelfUpdateResult } from './executor.js';
import type { SelfUpdateRecoveryResult } from './transaction.js';
type MailboxStore = mailbox.MailboxStore;
type LastUpdateStatus = 'success' | 'failed' | 'skipped' | 'pending';
export interface LastUpdatePayload {
    to_version: string;
    status: LastUpdateStatus;
    finished_at: number;
    from_version?: string;
    directive_id?: string;
    error?: string;
    /**
     * Which download channel produced the bytes that got applied: `'binary'` is
     * the precompiled-asset happy path, `'tarball'` means Channel 1b fallback
     * (release `.tar.gz`) was used. Persisted while confirmation is pending and on success so the hub can see
     * "primary CDN is degraded — fallback carrying production" without having
     * to mine telemetry. Absent on non-success or when the executor predates
     * the appliedVia field.
     */
    applied_via?: 'binary' | 'tarball';
}
export interface LastUpdateAck {
    ok?: boolean;
    reason?: string;
}
export declare function readPendingLastUpdate(store: MailboxStore, now?: number): LastUpdatePayload | undefined;
export declare function clearLastUpdateOnAck(store: MailboxStore, sent: LastUpdatePayload, now?: number): boolean;
export declare function writeLastUpdate(store: MailboxStore, payload: LastUpdatePayload, now?: number): boolean;
export declare function shouldClearForLastUpdateAck(ack: LastUpdateAck | undefined): boolean;
export declare function isLastUpdateRelatedError(value: unknown): boolean;
export declare function reportSelfUpdateLastUpdate(store: MailboxStore, directive: ForceUpdateDirective, result: SelfUpdateResult, opts?: {
    fromVersion: string;
    now?: number;
}): boolean;
export declare function reportPendingSelfUpdateLastUpdate(store: MailboxStore, directive: ForceUpdateDirective, opts?: {
    fromVersion: string;
    now?: number;
}): boolean;
export declare function finalizeSelfUpdateRecoveryLastUpdate(store: MailboxStore, recovery: SelfUpdateRecoveryResult, now?: number): boolean;
export declare function lastUpdateFromSelfUpdateResult(directive: ForceUpdateDirective, result: SelfUpdateResult, opts: {
    fromVersion: string;
    now: number;
}): LastUpdatePayload | undefined;
export {};