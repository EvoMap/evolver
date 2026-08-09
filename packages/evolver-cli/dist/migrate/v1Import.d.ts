import { assetstore } from '@evomap/evolver-core';
import { type V1Kind } from './fieldMap.js';
declare const IMPORT_V1_PLAN_SCHEMA: "evolver.migration.import-v1-plan.v1";
declare const IMPORT_V1_SOURCE_ROLES: readonly ["gene-envelope", "gene-jsonl", "capsule-envelope", "capsule-jsonl", "event-jsonl", "mailbox-jsonl", "memory-graph-jsonl", "candidates-jsonl", "failed-capsules-json"];
type ImportV1SourceRole = (typeof IMPORT_V1_SOURCE_ROLES)[number];
export interface ImportV1PlanSource {
    role: ImportV1SourceRole;
    path: string;
    bytes: number;
    sha256: string;
    records: number;
}
export interface ImportV1PlanReport {
    schema: typeof IMPORT_V1_PLAN_SCHEMA;
    sourceSchemaVersions: Readonly<Record<string, number>>;
    targetAuthoringSchemaVersion: string;
    sources: readonly ImportV1PlanSource[];
    assets: Readonly<Record<V1Kind, {
        candidates: number;
        verified: number;
        unverified: number;
        frozen: number;
        recomputed: number;
        writes: number;
        deduped: number;
    }>>;
    provenance: {
        candidates: number;
        writes: number;
        preserved: number;
    };
    extensions: {
        candidates: number;
        appends: number;
        deduped: number;
    };
    mailbox: {
        found: boolean;
        candidates: number;
        inserts: number;
        updates: number;
        protected: number;
    };
    memoryGraph: {
        found: boolean;
        candidates: number;
        importable: number;
        deduped: number;
        rejected: number;
        deferred: number;
        disposition: 'import' | 'defer' | 'absent';
    };
    validationReports: {
        found: boolean;
        candidates: number;
        disposition: 'preserve_source_no_v2_mapping' | 'absent';
    };
    candidates: {
        found: boolean;
        candidates: number;
        disposition: 'skip_non_wire' | 'absent';
    };
    failedCapsules: {
        found: boolean;
        candidates: number;
        disposition: 'preserve_manual_recovery' | 'absent';
    };
    planDigest: string;
}
export interface ImportV1Plan {
    readonly report: ImportV1PlanReport;
    dispose(): void;
}
export interface ImportReport {
    imported: Record<V1Kind, number>;
    frozen: number;
    recomputed: number;
    unverifiedFrozen: number;
    deduped: number;
    sidecarExtensions: number;
    memoryGraphArchived: boolean;
    memoryGraphImported: number;
    memoryGraphDeferred: boolean;
    mailboxFound: boolean;
    mailboxImported: number;
    candidatesSkipped: boolean;
}
/**
 * v1→v2 只读迁移(M8-2). 只读 v1(无双写); 冻结存量 asset_id; 非 schema 字段(avoid)落 sidecar;
 * memory_graph 不强转(语义不符)→ 归档只读; candidates 候选池不属 wire 资产 → 跳过.
 */
export interface ImportV1Options {
    workspace?: string;
    userId?: string;
    /** Test seam used to deterministically exercise source-path races. */
    sourceSnapshotTestHook?: (stage: 'before-open' | 'after-open' | 'after-snapshot', source: string, snapshotPath?: string) => void;
    /** Test seam used to prove extension metadata is durable before the asset write. */
    sidecarAppendTestHook?: (stage: 'before-append' | 'after-append', path: string) => void;
    /** Test seam used to exercise completion-marker publication failures. */
    memoryGraphMarkerTestHook?: (stage: 'before-publish', temporaryPath: string, markerPath: string) => void;
    /** Test seam used to deterministically exercise output-root rebinding races. */
    outputRootTestHook?: (stage: 'before-secure', path: string) => void;
    /** Test seam used to deterministically exercise owned-plan cleanup failures. */
    disposeTestHook?: (stage: 'before-remove', snapshotDir: string) => void;
}
export declare function planImportV1(v1Dir: string, outDir: string, options?: ImportV1Options): Promise<ImportV1Plan>;
export declare function applyImportV1Plan(plan: ImportV1Plan, store: assetstore.LocalJsonlProvider | undefined, outDir: string, options?: ImportV1Options): Promise<ImportReport>;
export declare function importV1(v1Dir: string, store: assetstore.LocalJsonlProvider, outDir: string, options?: ImportV1Options): Promise<ImportReport>;
export declare function validateMigrationRoots(v1Dir: string, outDir: string): {
    sourceRoot: string;
    outputRoot: string;
};
export {};