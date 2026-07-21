export type MemoryGraphOutcomeStatus = 'success' | 'failed';
export interface MemoryGraphOutcomeRecord {
    version: 2;
    kind: 'outcome';
    provenance: 'v2_local' | 'v1_import';
    workspaceScope: string;
    userScope: string;
    signalFingerprint: string;
    signals: readonly string[];
    geneId: string;
    status: MemoryGraphOutcomeStatus;
    score: number;
    at: string;
    /** Stable local-source identity used to make one-time imports crash-retry safe. */
    sourceFingerprint?: string;
    successCount?: number;
    failCount?: number;
}
export interface MemoryGraphGeneEvidence {
    geneId: string;
    boost: number;
    expectedSuccess: number;
    successCount: number;
    failCount: number;
    attempts: number;
    similarity: number;
    lastAt: string;
}
export interface MemoryGraphDiagnostics {
    bytesRead: number;
    recordsRead: number;
    corruptLines: number;
    oversizedLines: number;
    scopeRejected: number;
    provenanceRejected: number;
    truncated: boolean;
    recovery: 'healthy' | 'degraded' | 'recovered' | 'empty';
    /** The graph was healthy enough to address, but another process held its maintenance lock. */
    busy?: boolean;
}
export interface MemoryGraphAdvice {
    genes: readonly MemoryGraphGeneEvidence[];
    diagnostics: MemoryGraphDiagnostics;
}
export interface MemoryGraphQueryInput {
    workspace: string;
    signals: readonly string[];
}
export interface MemoryGraphRecordInput extends MemoryGraphQueryInput {
    geneId: string;
    status: MemoryGraphOutcomeStatus;
    score: number;
    at: string;
}
export interface MemoryGraphProvider {
    query(input: MemoryGraphQueryInput): Promise<MemoryGraphAdvice> | MemoryGraphAdvice;
    recordOutcome(input: MemoryGraphRecordInput): Promise<void> | void;
}
export declare function normalizeMemorySignals(signals: readonly string[]): string[];
export declare function memorySignalFingerprint(signals: readonly string[]): string;
export declare function safeMemoryGeneId(value: string): string;
export declare function deriveMemoryGraphAdvice(records: readonly MemoryGraphOutcomeRecord[], signals: readonly string[], nowMs: number, diagnostics: MemoryGraphDiagnostics): MemoryGraphAdvice;