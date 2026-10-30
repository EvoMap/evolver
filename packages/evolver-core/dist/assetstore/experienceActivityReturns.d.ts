import type { AuditBudget } from '../events/boundedAudit.js';
import { type AssetFileIdentity } from './assetStoreStorage.js';
export interface ActivityReturnIdentity {
    operationId: string;
}
export interface ActivityReturnRecord<T> {
    intent: T;
    state: 'awaiting_return' | 'acknowledged';
}
export declare class ActivityReturnError extends Error {
    readonly reason: string;
    readonly code = "ACTIVITY_RETURN_INVALID";
    constructor(reason: string);
}
/** Immutable return receipts, not another experience-content store. Mutations hold the activity lock. */
export declare class ExperienceActivityReturns<T extends ActivityReturnIdentity> {
    readonly baseDir: string;
    private readonly validate;
    readonly path: string;
    private owner?;
    constructor(baseDir: string, validate: (raw: string) => T);
    private decode;
    private use;
    withSession<R>(directory: AssetFileIdentity, run: (returns: ExperienceActivityReturns<T>) => Promise<R>): Promise<R>;
    rollbackPending(directory: AssetFileIdentity): boolean;
    awaiting(budget?: AuditBudget, directory?: AssetFileIdentity): T[];
    lookup(operationId: string, directory?: AssetFileIdentity): ActivityReturnRecord<T> | undefined;
    save(intent: T, directory: AssetFileIdentity): ActivityReturnRecord<T>;
    acknowledge(intent: T, directory: AssetFileIdentity): void;
}