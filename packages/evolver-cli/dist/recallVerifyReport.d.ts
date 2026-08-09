import type { PublishRecallState } from '@evomap/evolver-proxy';
export interface RecallVerifyRow {
    assetType: string;
    total: number;
    ok: number;
    missing: number;
    mismatch: number;
    error: number;
    skipped: number;
    successRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    p50AgeMs: number;
    p95AgeMs: number;
    p99AgeMs: number;
}
export interface RecallVerifyReport {
    since: string | null;
    retainedOutcomes: number;
    queued: number;
    rows: RecallVerifyRow[];
    totals: RecallVerifyRow;
    gate: 'GREEN' | 'YELLOW' | 'RED';
    retentionNotice: string;
}
export interface RecallVerifyReportDeps {
    env?: NodeJS.ProcessEnv;
    storePath?: string;
    readState?: (key: string) => string | undefined;
    now?: () => number;
    log?: (line: string) => void;
    err?: (line: string) => void;
}
export declare function aggregateRecallVerifyState(state: PublishRecallState | undefined, sinceMs: number | null): RecallVerifyReport;
export declare function runRecallVerifyReport(argv: readonly string[], deps?: RecallVerifyReportDeps): Promise<number>;
export declare const runRecallVerifyReportCommand: (argv: string[]) => Promise<number>;