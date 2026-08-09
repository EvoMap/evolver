import { type CycleFailureClass } from '../algo/cycleFailureClassifier.js';
/** root_events 行(报表读视图). */
export interface ReportEvent {
    type: string;
    seq: number;
    ts: string;
    human?: {
        title?: string;
        detail?: string;
        why?: string;
        next?: string;
        severity?: string;
    };
    payload?: Record<string, unknown>;
}
export declare function readEvents(eventsPath?: string): ReportEvent[];
export interface StatusReport {
    totalEvents: number;
    byType: Record<string, number>;
    cycles: number;
    lastTs: string | null;
}
export declare function statusReport(evts: readonly ReportEvent[]): StatusReport;
export interface CycleSummary {
    cycleId: string;
    events: number;
    finalStage: string;
    lastTs: string;
    failureClass?: CycleFailureClass;
    failureSuppressed?: boolean;
}
export declare function listCycles(evts: readonly ReportEvent[]): CycleSummary[];
export interface CycleTimeline {
    cycleId: string;
    timeline: Array<{
        type: string;
        title: string;
        why?: string;
        ts: string;
        seq: number;
        payload?: Record<string, unknown>;
    }>;
}
export declare function showCycle(evts: readonly ReportEvent[], cycleId: string): CycleTimeline;
export interface TriggerRow {
    patternId: string;
    triggered: boolean;
    value: number;
    reasons: string[];
}
export declare function listTriggers(evts: readonly ReportEvent[]): TriggerRow[];
/** 每日总结(保活, M7-4): 当日 cycle 数/成功率/触发数. */
export interface DailySummary {
    date: string;
    cycles: number;
    solidified: number;
    failed: number;
    triggered: number;
    suppressed: number;
    failureBuckets: Partial<Record<CycleFailureClass, number>>;
    suppressedFailures: number;
}
export declare function dailySummary(evts: readonly ReportEvent[], dayPrefix: string): DailySummary;
/** 统计指定日期前缀的 capsule.produced 事件数. */
export declare function dailyCapsuleCount(evts: readonly ReportEvent[], dayPrefix: string): number;
export type NarrativeOutcome = 'success' | 'failed' | 'inert' | 'unknown';
export interface NarrativeEntry {
    seq: number;
    ts: string;
    type: string;
    title: string;
    cycleId?: string;
    summary?: string;
    action?: string;
    outcome?: NarrativeOutcome;
    geneId?: string;
    score?: number;
}
export interface NarrativeSnapshot {
    totalEvents: number;
    includedEvents: number;
    cycles: number;
    reflections: number;
    outcomes: Record<NarrativeOutcome, number>;
    entries: NarrativeEntry[];
}
export interface NarrativeSnapshotOptions {
    limit?: number;
}
export declare const NARRATIVE_DEFAULT_LIMIT = 30;
export declare const NARRATIVE_MAX_LIMIT = 200;
export declare function buildNarrativeSnapshot(evts: readonly ReportEvent[], opts?: NarrativeSnapshotOptions): NarrativeSnapshot;