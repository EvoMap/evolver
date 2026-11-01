import { AuditBudget } from './boundedAudit.js';
import { type RawEvent, type RootEvent } from './eventSchema.js';
export declare function isExperienceAuditKey(value: string | undefined): boolean;
interface Locator {
    identity: string;
    offset: number;
    archive?: string;
}
export declare class ExperienceAuditError extends Error {
    readonly code: string;
    constructor(code: string);
}
/** Called with the root lock held, including by ordinary append, truncate recovery and archive. */
export declare function recoverExperienceAuditUnderLock(path: string, check?: () => void): void;
export declare function snapshotExperienceAuditV1(raw: RawEvent): RawEvent;
/** Versioned, exact-slot projection. It never uses a history search to certify non-commit. */
export declare function appendExperienceAudit(path: string, raw: RawEvent, key: string, options: {
    budget: AuditBudget;
    maxFileBytes: number;
    capacity(incoming: number): void;
    lastSeq(): number;
    assertHistory(check: () => void): void;
    expectedNamespace?: string;
    created?(): void;
    validate?(): void;
}): Promise<RootEvent>;
export declare function relocateExperienceAudit(path: string, locate: (line: string) => Locator | undefined): void;
export declare function experienceAuditKey(phase: 'request' | 'completion' | 'recovery', namespace: string, operationId: string): string;
export {};