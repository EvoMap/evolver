import { schema } from '@evomap/evolver-core';
import { type RuntimeSessionEvidenceCoverage, type RuntimeSessionEvidenceCounts, type RuntimeSessionEvidenceGapCode, type RuntimeSessionEvidenceSummary } from '@evomap/evolver-runtime-adapters';
import { type RuntimeSessionSource } from './runtimeSessionSource.js';
export declare const MATERIAL_RUNTIME_SESSION_SNAPSHOT_SCHEMA = "evolver.material.runtime_session_snapshot.v1";
interface SnapshotTurn {
    role: RuntimeSessionSource['turns'][number]['role'];
    text: string;
    isMeta?: boolean;
    toolName?: string;
    errorMessage?: string;
}
interface SnapshotSource {
    agent: string;
    label: string;
    sessionId?: string;
    resumeIdentityProvenance?: 'canonical_native_transcript';
    evidenceSummary: RuntimeSessionEvidenceSummary;
    turns: SnapshotTurn[];
}
export interface RuntimeSessionMaterialSnapshotV1 {
    schema: typeof MATERIAL_RUNTIME_SESSION_SNAPSHOT_SCHEMA;
    sourceKind: 'runtime_session';
    kind: 'session_log';
    sources: SnapshotSource[];
    sourceCount: number;
    omittedSourceCount: number;
    omittedEvidenceAggregate?: RuntimeSessionEvidenceAggregate;
    truncated: boolean;
    maxChars: number;
}
export interface RuntimeSessionEvidenceSummarySource {
    agent: string;
    label: string;
    sessionId?: string;
    resumeIdentityProvenance?: 'canonical_native_transcript';
    evidenceSummary: RuntimeSessionEvidenceSummary;
}
export interface RuntimeSessionEvidenceAggregate {
    sourceCount: number;
    coverageCounts: Record<RuntimeSessionEvidenceCoverage, number>;
    counts: RuntimeSessionEvidenceCounts;
    gapCodes: RuntimeSessionEvidenceGapCode[];
}
export interface RuntimeSessionEvidenceSummaryCollection {
    sourceCount: number;
    omittedSourceCount: number;
    summaries: RuntimeSessionEvidenceSummarySource[];
    omittedEvidenceAggregate?: RuntimeSessionEvidenceAggregate;
}
export declare function buildRuntimeSessionMaterialSnapshot(sources: readonly RuntimeSessionSource[], maxChars?: number): RuntimeSessionMaterialSnapshotV1;
export declare function runtimeSessionSourcesFromMaterialPayload(payload: unknown): RuntimeSessionSource[];
export declare function runtimeSessionEvidenceSummariesFromMaterialPayload(payload: unknown): RuntimeSessionEvidenceSummaryCollection | null;
export declare function materialHasRuntimeSessionSnapshot(material: schema.Material): boolean;
export declare function materialSourceAvailable(material: schema.Material): boolean;
export interface RuntimeSessionMaterialSources {
    sources: RuntimeSessionSource[];
    liveSources?: RuntimeSessionSource[];
    sourceError?: unknown;
}
export declare function runtimeSessionSourcesForMaterialDetails(material: schema.Material, readSource?: (path: string) => string, nativeSessionHome?: string): RuntimeSessionMaterialSources;
export declare function runtimeSessionSourcesForMaterial(material: schema.Material, readSource?: (path: string) => string, nativeSessionHome?: string): RuntimeSessionSource[];
export {};