import { Ingestor } from '../events/ingest.js';
import { type ReviewRecord } from './reviewLedger.js';
import { type ExperienceSource } from './experienceSources.js';
import { type AssetRecord } from './provider.js';
export declare const EXPERIENCE_SCHEMA = "evolver.experience.v1";
export declare const EXPERIENCE_PLAN_TTL = 120000;
export declare const EXPERIENCE_PAUSED = "experience:paused";
export declare const EXPERIENCE_REMOVED = "experience:removed";
export type ExperienceAction = 'capture' | 'approve' | 'pause' | 'resume' | 'remove';
export interface ExperienceInput {
    title: string;
    task: string;
    material: string;
    conditions: string[];
    steps: string[];
    signals: string[];
}
export interface ExperienceItem {
    assetId: string;
    title: string;
    task: string;
    material: string;
    conditions: string[];
    steps: string[];
    signals: string[];
    state: 'pending' | 'active' | 'paused' | 'removed' | 'untrusted';
    review: string;
    verification: 'not_verified';
}
export interface ExperiencePlanConfirmation {
    schema: 'evolver.experience-plan-confirmation.v1';
    nonce: string;
    hash: string;
}
export interface ExperiencePlan {
    schema: typeof EXPERIENCE_SCHEMA;
    id: string;
    confirmation?: ExperiencePlanConfirmation;
    action: ExperienceAction;
    assetId: string;
    rootIdentity: string;
    expectedRevision: string;
    expiresAt: number;
    asset?: AssetRecord;
    source?: ExperienceSource;
    expectedReview: ReviewRecord | null;
    provenanceRevision: string;
    expectedFiles: Record<string, string>;
    auditTarget: string;
    expectedRoot?: string;
}
export interface ExperienceSourceRecoveryPlan {
    schema: 'evolver.experience-source-recovery.v1';
    id: string;
    confirmation?: ExperiencePlanConfirmation;
    rootIdentity: string;
    assetId: string;
    sourceDigest: string;
    auditTarget: string;
    expectedRoot?: string;
    expectedFiles: Record<string, string>;
    expiresAt: number;
}
export interface ExperienceList {
    schema: typeof EXPERIENCE_SCHEMA;
    items: ExperienceItem[];
    revision: string;
    hasMore: boolean;
}
export interface ExperienceDeps {
    audit?: Partial<Pick<Ingestor, 'ingest' | 'ingestExperienceAuditV1' | 'path'>>;
    now?: () => number;
    /** Synchronous test seam; never an environment-controlled product crash switch. */
    checkpoint?: (phase: string) => void;
}
export declare class ExperienceError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** Local curated Gene management. Never publishes, runs a strategy, or upgrades provenance trust. */
export declare class ExperienceLibrary {
    private readonly deps;
    readonly baseDir: string;
    private readonly now;
    constructor(baseDir: string, deps?: ExperienceDeps);
    private journalForConfirmedPlan;
    private snapshot;
    private files;
    private rootGeneration;
    private stableSnapshot;
    private currentItem;
    list(query?: string, limit?: number, offset?: number): Promise<ExperienceList>;
    search(query: string, limit?: number): Promise<ExperienceItem[]>;
    plan(action: ExperienceAction, assetId?: string, input?: ExperienceInput): Promise<ExperiencePlan>;
    private audit;
    private auditEvent;
    private completion;
    private project;
    planSourceRecovery(assetId: string): Promise<ExperienceSourceRecoveryPlan>;
    executeSourceRecovery(input: ExperienceSourceRecoveryPlan): Promise<{
        operationId: string;
        assetId: string;
        state: string;
        originalMaterialPreserved: boolean;
    }>;
    operationStatus(limit?: number, offset?: number): import("./experienceJournal.js").ExperienceOperationStatus[];
    recover(operationId?: string, limit?: number): Promise<{
        hasMore: boolean;
        operations: import("./experienceJournal.js").ExperienceOperationStatus[];
        remaining: number;
        totalPending: number;
        nextOperationId?: string;
        business: "none" | "aborted" | "committed";
        projected: number;
        pending: string[];
    }>;
    private executionEvidence;
    execute(inputPlan: ExperiencePlan): Promise<ExperienceItem>;
}