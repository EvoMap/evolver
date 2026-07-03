import { ulid as makeUlid } from 'ulid';
/** category → 基线风险(innovate/explore 改动开放面大, repair 收敛). 选不到 gene(innovate)再升一档. */
function baselineRisk(category, noGene) {
    if (category === 'innovate' || category === 'explore')
        return 'high';
    if (noGene)
        return 'medium'; // 无现成 gene = 新路径
    return category === 'repair' ? 'low' : 'medium';
}
/** 由选择决策构造 Mutation(瞬态, 不落资产库; 进 root_events). */
export function buildMutation(input) {
    const noGene = input.decision.selectedGeneId === null;
    return {
        type: 'Mutation',
        id: makeUlid(),
        category: input.category,
        trigger_signals: [...input.signals],
        target: input.target,
        expected_effect: input.expectedEffect,
        risk_level: input.riskOverride ?? baselineRisk(input.category, noGene),
    };
}