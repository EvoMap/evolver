import type { AssetStoreProvider } from '../assetstore/provider.js';
import { ReviewLedger } from '../assetstore/reviewLedger.js';
import type { ReportEvent } from '../events/reports.js';
import { type CycleInput } from '../algo/cycleEngine.js';
import type { GepCategory } from '../wire/index.js';
import { type AntiGeneOverblockSummary } from './antiGeneImpact.js';
export type AntiGeneRolloutArm = 'baseline' | 'antiGene';
export type AntiGeneRolloutVerdict = 'anti_gene_better' | 'no_clear_improvement' | 'anti_gene_worse' | 'insufficient_samples';
export interface AntiGeneRolloutTask {
    id: string;
    signals: string[];
    target?: string;
    expectedEffect?: string;
    category?: GepCategory;
    summary?: string;
    confidence?: number;
    expectedAntiWarnings?: string[];
}
export interface AntiGeneRolloutSuite {
    name: string;
    validation?: string[];
    tasks: AntiGeneRolloutTask[];
}
export interface AntiGeneRolloutArmMetrics {
    arm: AntiGeneRolloutArm;
    n: number;
    failures: number;
    failureRate: number;
    repeatedFailures: number;
    overblocked: number;
    observedWarnings: number;
}
export interface AntiGeneRolloutRunResult {
    status: 'success' | 'failed';
    score: number;
    repeatedFailure: boolean;
    overblocked: boolean;
    observedAntiWarnings: string[];
    missingExpectedWarnings: string[];
    selectedGeneId?: string | null;
}
export interface AntiGeneRolloutTaskResult {
    taskId: string;
    baseline: AntiGeneRolloutRunResult;
    antiGene: AntiGeneRolloutRunResult;
}
export interface AntiGeneRolloutReport {
    suite: string;
    tasks: number;
    baseline: AntiGeneRolloutArmMetrics;
    antiGene: AntiGeneRolloutArmMetrics;
    missingExpectedWarnings: number;
    overblocked: number;
    overblockedAntiGenes: AntiGeneOverblockSummary[];
    failureDelta: number;
    verdict: AntiGeneRolloutVerdict;
    taskResults: AntiGeneRolloutTaskResult[];
    taskResultsTruncated?: number;
}
export interface AntiGeneRolloutExecuteContext {
    arm: AntiGeneRolloutArm;
    task: AntiGeneRolloutTask;
    store: AssetStoreProvider;
    review: ReviewLedger;
    armDir: string;
}
export type AntiGeneRolloutExecuteFactory = (context: AntiGeneRolloutExecuteContext) => CycleInput['execute'];
export interface AntiGeneRolloutDeps {
    store: AssetStoreProvider;
    review?: ReviewLedger;
    makeExecute: AntiGeneRolloutExecuteFactory;
}
export interface AntiGeneRolloutOptions {
    minSamples?: number;
    minFailureDelta?: number;
    now?: () => number;
    eventsPath?: string;
}
export declare function runAntiGeneRollout(suite: AntiGeneRolloutSuite, deps: AntiGeneRolloutDeps, options?: AntiGeneRolloutOptions): Promise<AntiGeneRolloutReport>;
export declare function writeAntiGeneRolloutResult(report: AntiGeneRolloutReport, eventsPath: string, now?: () => number): Promise<void>;
export declare function antiGeneRolloutReportsFromEvents(events: readonly ReportEvent[]): AntiGeneRolloutReport[];
export declare function latestAntiGeneRolloutReport(events: readonly ReportEvent[]): AntiGeneRolloutReport | null;