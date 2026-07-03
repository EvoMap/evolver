import type { shadow } from '@evomap/evolver-core';
type ShadowRecord = shadow.ShadowRecord;
/** v1 actual 对照基准(由 v1 资产/真 hub 回执历史导出). */
export interface V1Reference {
    publishedAssetIds: readonly string[];
    settleCount: number;
    frozenAssetIds?: readonly string[];
}
export interface DivergenceReport {
    publishDecisionMatchRate: number;
    wouldPublishCount: number;
    wouldSettleCount: number;
    v1SettleCount: number;
    settleDelta: number;
    wouldStorePutCount: number;
    dedupCollisionCount: number;
    pushTypeDistribution: Record<string, number>;
    schemaGateRejectCount: number;
    green: boolean;
    reasons: string[];
}
/**
 * shadow 对账(M8-2-shadow-g). 比 v2 shadow 决策(WOULD_*) vs v1 actual, 算 divergenceMetrics.
 * enforce 门槛数据源: green=true 才允许团队签字切 enforce(配合 money-safety 复核)。
 */
export declare function divergenceAudit(records: readonly ShadowRecord[], v1: V1Reference, opts?: {
    schemaGateRejectCount?: number;
}): DivergenceReport;
export {};