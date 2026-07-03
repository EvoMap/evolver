/**
 * shadow 对账(M8-2-shadow-g). 比 v2 shadow 决策(WOULD_*) vs v1 actual, 算 divergenceMetrics.
 * enforce 门槛数据源: green=true 才允许团队签字切 enforce(配合 money-safety 复核)。
 */
export function divergenceAudit(records, v1, opts = {}) {
    const publishes = records.filter((r) => r.action === 'WOULD_PUBLISH');
    const wouldPublishIds = publishes.map((r) => r.assetId).filter((x) => !!x);
    const v1Set = new Set(v1.publishedAssetIds);
    const matched = [...new Set(wouldPublishIds)].filter((id) => v1Set.has(id)).length;
    const publishDecisionMatchRate = v1Set.size > 0 ? matched / v1Set.size : (wouldPublishIds.length === 0 ? 1 : 0);
    const wouldSettleCount = records.filter((r) => r.action === 'WOULD_SETTLE').length;
    const settleDelta = wouldSettleCount - v1.settleCount;
    // 去重碰撞: 同 asset_id 出现 >1 次 WOULD_PUBLISH/WOULD_STORE_PUT
    const idCounts = new Map();
    for (const r of records)
        if ((r.action === 'WOULD_PUBLISH' || r.action === 'WOULD_STORE_PUT') && r.assetId)
            idCounts.set(r.assetId, (idCounts.get(r.assetId) ?? 0) + 1);
    const dedupCollisionCount = [...idCounts.values()].filter((c) => c > 1).length;
    const pushTypeDistribution = {};
    for (const r of records)
        if (r.action === 'WOULD_PUSH' && r.envelopeType)
            pushTypeDistribution[r.envelopeType] = (pushTypeDistribution[r.envelopeType] ?? 0) + 1;
    const schemaGateRejectCount = opts.schemaGateRejectCount ?? 0;
    const reasons = [];
    if (publishDecisionMatchRate < 0.999)
        reasons.push(`publish 决策重合率 ${(publishDecisionMatchRate * 100).toFixed(1)}% < 100%`);
    if (settleDelta !== 0)
        reasons.push(`结算差值 ${settleDelta}≠0(money-safety, 须逐条解释)`);
    if (schemaGateRejectCount > 0)
        reasons.push(`schema_gate 拒绝 ${schemaGateRejectCount}>0`);
    return {
        publishDecisionMatchRate, wouldPublishCount: publishes.length, wouldSettleCount, v1SettleCount: v1.settleCount, settleDelta,
        wouldStorePutCount: records.filter((r) => r.action === 'WOULD_STORE_PUT').length,
        dedupCollisionCount, pushTypeDistribution, schemaGateRejectCount,
        green: reasons.length === 0, reasons,
    };
}