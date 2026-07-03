import type { AssetStoreProvider } from '../assetstore/provider.js';
import { ReviewLedger } from '../assetstore/reviewLedger.js';
import type { ReportEvent } from '../events/reports.js';
import type { GepCategory } from '../wire/index.js';
export type AntiGeneBenchmarkArm = 'baseline' | 'antiGene';
export type AntiGeneBenchmarkVerdict = 'anti_gene_better' | 'no_clear_improvement' | 'anti_gene_worse' | 'insufficient_samples';
export interface AntiGeneBenchmarkOutcomeSpec {
    status: 'success' | 'failed';
    repeatedFailure?: boolean;
    overblocked?: boolean;
    score?: number;
    reason?: string;
}
export interface AntiGeneBenchmarkTask {
    id: string;
    signals: string[];
    target?: string;
    expectedEffect?: string;
    category?: GepCategory;
    summary?: string;
    confidence?: number;
    expectedAntiWarnings?: string[];
    outcomes: {
        baseline: AntiGeneBenchmarkOutcomeSpec;
        antiGene: AntiGeneBenchmarkOutcomeSpec;
    };
}
export interface AntiGeneBenchmarkSuite {
    name: string;
    tasks: AntiGeneBenchmarkTask[];
}
export interface AntiGeneBenchmarkArmMetrics {
    arm: AntiGeneBenchmarkArm;
    n: number;
    failures: number;
    failureRate: number;
    repeatedFailures: number;
    overblocked: number;
    observedWarnings: number;
}
export interface AntiGeneBenchmarkTaskResult {
    taskId: string;
    baseline: AntiGeneBenchmarkRunResult;
    antiGene: AntiGeneBenchmarkRunResult;
}
export interface AntiGeneBenchmarkRunResult {
    status: 'success' | 'failed';
    score: number;
    repeatedFailure: boolean;
    overblocked: boolean;
    observedAntiWarnings: string[];
    missingExpectedWarnings: string[];
}
export interface AntiGeneBenchmarkReport {
    suite: string;
    tasks: number;
    baseline: AntiGeneBenchmarkArmMetrics;
    antiGene: AntiGeneBenchmarkArmMetrics;
    missingExpectedWarnings: number;
    overblocked: number;
    failureDelta: number;
    verdict: AntiGeneBenchmarkVerdict;
    taskResults: AntiGeneBenchmarkTaskResult[];
    taskResultsTruncated?: number;
}
export interface AntiGeneBenchmarkOptions {
    minSamples?: number;
    minFailureDelta?: number;
    now?: () => number;
    eventsPath?: string;
}
export interface AntiGeneBenchmarkDeps {
    store: AssetStoreProvider;
    review?: ReviewLedger;
}
export declare function runAntiGeneBenchmark(suite: AntiGeneBenchmarkSuite, deps: AntiGeneBenchmarkDeps, options?: AntiGeneBenchmarkOptions): Promise<AntiGeneBenchmarkReport>;
export declare function writeAntiGeneBenchmarkResult(report: AntiGeneBenchmarkReport, eventsPath: string, now?: () => number): Promise<void>;
export declare function antiGeneBenchmarkReportsFromEvents(events: readonly ReportEvent[]): AntiGeneBenchmarkReport[];
export declare function latestAntiGeneBenchmarkReport(events: readonly ReportEvent[]): AntiGeneBenchmarkReport | null;