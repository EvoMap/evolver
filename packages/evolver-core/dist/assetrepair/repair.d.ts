import type { AssetRecord } from '../assetstore/index.js';
export type RepairStatus = 'already_valid' | 'repaired' | 'unrepairable';
export interface RepairIssue {
    path: string;
    keyword: string;
    message: string;
    /** `schema` = found by the local gep-sdk gate; `hub` = reported by the network in its rejection body. */
    source: 'schema' | 'hub';
}
export interface RepairChange {
    path: string;
    action: 'added' | 'removed' | 'replaced';
    note: string;
}
export interface RepairReport {
    status: RepairStatus;
    /** The accepted-by-schema record. Absent only when blockers remain (`status: 'unrepairable'`). */
    asset?: AssetRecord;
    changes: RepairChange[];
    blockers: RepairIssue[];
}
export interface RepairOptions {
    /** Field-level issues the network itself reported — see `hubRejectionIssues`. Stricter than the GEP schema
     *  (the Hub adds envelope rules of its own), so they are folded in rather than re-derived locally. */
    hubIssues?: readonly RepairIssue[];
}
type JsonRecord = Record<string, unknown>;
/**
 * Repair `input` into a record the GEP schema (and, when supplied, the Hub's own rules) accepts.
 * Pure: `input` is never mutated, and nothing is written anywhere — the caller decides what to do with the result.
 */
export declare function repairAssetRecord(input: JsonRecord, options?: RepairOptions): RepairReport;
export {};