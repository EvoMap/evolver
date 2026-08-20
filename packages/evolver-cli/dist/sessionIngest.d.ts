import { events, material as materialNs } from '@evomap/evolver-core';
import { type RuntimeSessionMaterialSnapshotV1 } from './materialSnapshot.js';
import { type RuntimeSessionParseDiagnostics, type RuntimeSessionSource } from './runtimeSessionSource.js';
/**
 * Stamp a resolved canonical task domain onto each source when turn/signal text carries exactly one
 * valid `task_domain:` token. Never invents domains; absent/ambiguous/invalid → leave field unset.
 * Additive only — does not mutate parse diagnostics or turn content.
 */
export declare function stampResolvedTaskDomain(sources: readonly RuntimeSessionSource[]): RuntimeSessionSource[];
/** Material consumer group shared by ingestion and the downstream cycle consumer. */
export declare const INGEST_CONSUMER_GROUP = "cycle";
/** Injectable substrate dependencies for session and trace ingestion. */
export interface IngestDeps {
    materialStore?: materialNs.MaterialStore;
    watermarkStore?: materialNs.WatermarkStore;
    ingestor?: events.Ingestor;
    /** User home whose native runtime directories may contribute resumable session identities. */
    nativeSessionHome?: string;
}
export interface SessionIngestTickResult {
    recorded: number;
    sourceAgents: string[];
    signalKinds: string[];
    signalStrengths: string[];
    invalidJsonRows?: number;
    /** Cursor databases that could not be opened or parsed; no path or native error text is exposed. */
    parseFailures?: number;
}
export declare function resolveIngestDeps(deps: IngestDeps): {
    materialStore: materialNs.MaterialStore;
    watermarkStore: materialNs.WatermarkStore;
    ingestor: events.Ingestor;
};
export declare function toMaterialSourceAgent(agent: string): materialNs.BuildMaterialInput['sourceAgent'] | undefined;
export declare function recordSessionMaterial(sourceAgent: materialNs.BuildMaterialInput['sourceAgent'], absPath: string, signalCount: number, deps: ReturnType<typeof resolveIngestDeps>, recordCount?: number, payload?: RuntimeSessionMaterialSnapshotV1, diagnostics?: RuntimeSessionParseDiagnostics): Promise<{
    recorded: boolean;
    emitted: boolean;
    materialId?: string;
}>;
/** Recursively enumerate recognized runtime-session sources, skipping inaccessible directories. */
export declare function scanSessionDirs(dirs: readonly string[]): string[];
/** Record all new or changed runtime sessions as material for the auto-distill loop. */
export declare function runSessionIngestTick(dirs: readonly string[], deps?: IngestDeps): Promise<SessionIngestTickResult>;