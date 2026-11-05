import { type SqliteDatabase } from '../util/sqlite.js';
import { AuditBudget, type AuditFileHandle } from './boundedAudit.js';
import { type RawEvent, type RootEvent } from './eventSchema.js';
export declare class RootOperationError extends Error {
    readonly reason: string;
    constructor(reason: string);
}
export interface IdempotentEventAdmission {
    operationId: string;
    deadlineAt?: number;
    signal?: AbortSignal;
    /** Only schema-1 activity recovery may adopt an event written without this replay key. */
    legacyActivityId?: string;
    namespaceId?: string;
}
export interface RootOperationTicket {
    schema: 1;
    operationId: string;
    requestHash: string;
    namespaceId: string;
}
export declare function validateRootOperationTicket(value: unknown, raw: RawEvent, operationId: string): RootOperationTicket;
export interface RootOperationLocator {
    identity: string;
    offset: number;
    archive?: string;
}
export interface RootOperationRecord extends RootOperationLocator {
    operationId: string;
    requestHash: string;
    line: string;
    prefixHash: string;
    state: 'planned' | 'committed';
}
export interface RootHistoryRecord extends RootOperationLocator {
    event: RootEvent;
    line: string;
}
export declare function validateRootOperationId(value: unknown): asserts value is string;
/** Normalize the writer's public envelope before the first await. Never hash caller-owned toJSON twice. */
export declare function snapshotRootOperation(raw: RawEvent): RawEvent;
export declare function rootOperationRequestHash(raw: RawEvent): string;
export declare function rootOperationEventHash(event: RootEvent): string;
export declare function validateRootOperationReceipt(value: unknown, raw: RawEvent, admission: IdempotentEventAdmission): RootEvent;
export declare function rootOperationFileIdentity(path: string): string;
export declare class RootOperationJournal {
    private readonly db;
    private readonly target;
    private readonly identity;
    private readonly budget;
    constructor(db: SqliteDatabase, target: string, identity: string, budget: AuditBudget);
    private checkBinding;
    private check;
    namespaceId(): string;
    /** Finish receipt confirmation after root readback/fsync, without renewing admission. */
    confirmNamespace(): string;
    assertTicket(namespaceId: string, operationId: string, requestHash: string): void;
    admission(id: string, requestHash: string, namespaceId?: string): RootOperationRecord | undefined;
    get(id: string): RootOperationRecord | undefined;
    private checkHistorySequence;
    assertHistorySequence(seq: number): void;
    private checkOtherPlan;
    assertNoOtherPlan(id?: string): void;
    prepare(record: RootOperationRecord, historySequence?: number): void;
    committed(id: string, locator: RootOperationLocator): void;
}
/** Only the root lock owner may open this journal. A failed close retains that exact connection. */
export declare function withRootOperationJournal<T>(target: string, budget: AuditBudget, body: (journal: RootOperationJournal) => Promise<T>, existingOnly?: boolean): Promise<T>;
export declare function rootOperationRootOwned(path: string): boolean;
/** Synchronous/ordinary writers and rotation must not pass an unresolved operation's reserved suffix. */
export declare function assertNoPendingRootOperation(target: string): void;
/** Read active and immutable archives under the caller's root lock, on checked existing descriptors. */
export declare function readRootOperationHistory(path: string, active: AuditFileHandle, budget: AuditBudget, maxBytes: number): Promise<RootHistoryRecord[]>;
export declare function rootOperationPrefixHash(handle: AuditFileHandle, offset: number, budget: AuditBudget): Promise<string>;
/** Existing-only readback: missing receipt evidence is never permission to append again. */
export declare function confirmRootOperation(path: string, active: AuditFileHandle, record: RootOperationRecord, journal: RootOperationJournal, budget: AuditBudget, maxBytes: number, submitted?: boolean): Promise<RootEvent>;
/** The lock and exact prefix/identity prove that a dead writer's reserved suffix may be repaired. */
export declare function repairRootOperation(path: string, handle: AuditFileHandle, record: RootOperationRecord, budget: AuditBudget): Promise<boolean>;