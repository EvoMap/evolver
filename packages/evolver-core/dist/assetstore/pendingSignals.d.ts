import type { AssetStoreProvider } from './provider.js';
export interface PendingSignalsFile {
    signals?: unknown;
    note?: unknown;
}
export interface PendingSignalsConsumeResult {
    signals: string[];
    path?: string;
}
export interface PendingSignalsMergeResult {
    signals: string[];
    injected: number;
    path?: string;
}
export interface PendingSignalsContext {
    repoRoot?: string;
    cwd?: string;
}
export declare function pendingSignalsPath(baseDir: string): string;
export declare function consumePendingSignals(baseDir: string): PendingSignalsConsumeResult;
export declare function consumePendingSignalsForStore(store: AssetStoreProvider, context?: PendingSignalsContext): PendingSignalsConsumeResult;
export declare function mergePendingSignalsForStore(store: AssetStoreProvider, baseSignals: readonly string[], context?: PendingSignalsContext): PendingSignalsMergeResult;