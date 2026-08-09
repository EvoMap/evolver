import { type NormalizedTurn } from '@evomap/evolver-runtime-adapters';
export interface RuntimeSessionSource {
    agent: string;
    label: string;
    sessionId?: string;
    resumeIdentityProvenance?: 'canonical_native_transcript';
    turns: NormalizedTurn[];
}
export interface RuntimeSessionParseDiagnostics {
    rowsScanned: number;
    rowsRead: number;
    invalidJson: number;
}
export interface RuntimeSessionParseResult {
    sources: RuntimeSessionSource[];
    diagnostics: RuntimeSessionParseDiagnostics;
}
export declare function isRuntimeSessionSourcePath(path: string): boolean;
export declare function parseRuntimeSessionSourcesWithDiagnostics(path: string, readSource?: (path: string) => string, nativeSessionHome?: string): RuntimeSessionParseResult;
export declare function parseRuntimeSessionSources(path: string, readSource?: (path: string) => string, nativeSessionHome?: string): RuntimeSessionSource[];