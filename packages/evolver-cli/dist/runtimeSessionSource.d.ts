import { type NormalizedTurn } from '@evomap/evolver-runtime-adapters';
export interface RuntimeSessionSource {
    agent: string;
    label: string;
    sessionId?: string;
    turns: NormalizedTurn[];
}
export declare function isRuntimeSessionSourcePath(path: string): boolean;
export declare function parseRuntimeSessionSources(path: string, readSource?: (path: string) => string): RuntimeSessionSource[];