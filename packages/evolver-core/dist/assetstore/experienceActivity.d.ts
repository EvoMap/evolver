import { Ingestor } from '../events/ingest.js';
import { type RootOperationTicket } from '../events/rootEventOperations.js';
import type { RootEvent } from '../events/eventSchema.js';
import { type ExperienceItem } from './experience.js';
export interface ExperienceClient {
    connectionId: string;
    transport: 'mcp_stdio' | 'cli';
    clientName: string;
    runtime?: string;
}
export interface ExperienceActivityRow {
    id: string;
    kind: 'check_requested' | 'check_received' | 'task_requested' | 'delivered' | 'use_reported';
    at: string;
    code?: string;
    expiresAt?: number;
    runtime?: string;
    taskId?: string;
    title?: string;
    query?: string;
    assetIds?: string[];
    deliveryId?: string;
    outcome?: string;
    validation?: 'not_requested' | 'passed' | 'failed';
    validator?: 'iso-date-sort.v1';
    input?: string[];
    output?: string[];
    client?: ExperienceClient;
    hostIdentityVerified?: false;
    usageEvidence?: 'application_report';
}
interface PendingActivity {
    schema: 1 | 2;
    row: ExperienceActivityRow;
    human: boolean;
    audited?: boolean;
    operationId?: string;
    auditPath?: string;
    requestHash?: string;
    legacyActivityId?: string;
    ticket?: RootOperationTicket;
    receipt?: RootEvent;
}
export type ExperienceActivityAudit = Pick<Ingestor, 'prepareIdempotent' | 'ingestIdempotent' | 'path'>;
/** Read-only recovery witness; shares the transaction's exact journal/ticket validation. */
export declare function readExperienceActivityPending(baseDir: string): PendingActivity | undefined;
/** Only an exact known, still-unclaimed operation authorizes caller recovery. */
export declare function readExperienceActivityRecovery(baseDir: string, operationId: string): PendingActivity | undefined;
/** Receipts are actual local tool operations, not configuration checks or authenticated vendor identities. */
export declare class ExperienceActivity {
    readonly baseDir: string;
    private readonly audit?;
    private readonly path;
    private readonly now;
    constructor(baseDir: string, audit?: ExperienceActivityAudit | undefined, now?: () => number);
    records(): ExperienceActivityRow[];
    private transaction;
    private checkTransaction;
    private verifyReturn;
    private pending;
    private recoverPending;
    private projection;
    private append;
    startCheck(runtime: string): Promise<ExperienceActivityRow>;
    check(code: string, source: ExperienceClient): Promise<ExperienceActivityRow>;
    startTask(title: string, query: string, validationInput?: string[]): Promise<ExperienceActivityRow>;
    search(query: string, source: ExperienceClient, taskId?: string): Promise<{
        items: ExperienceItem[];
        deliveryId: string;
    }>;
    report(deliveryId: string, assetId: string, taskId: string, outcome: string, source: ExperienceClient, output?: string[]): Promise<ExperienceActivityRow>;
    history(limit?: number): ExperienceActivityRow[];
    checkStatus(id: string): ExperienceActivityRow | null;
}
export {};