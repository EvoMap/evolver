import { personalityKey } from './schema.js';
/** 记录本轮选用的人格状态 (注入 prompt 前). */
export async function emitPersonalitySelected(ingestor, args) {
    const key = personalityKey(args.personality);
    return ingestor.ingest({
        type: 'personality.selected',
        human: {
            title: `人格 ${key}`,
            detail: `rigor=${args.personality.rigor.toFixed(2)} creativity=${args.personality.creativity.toFixed(2)} risk=${args.personality.risk_tolerance.toFixed(2)}`,
        },
        payload: { cycleId: args.cycleId, personalityKey: key, personalityState: args.personality, known: args.known },
    });
}
/**
 * 记录风险闸对变异的降级 (仅当真降级了才发; downgraded=false 不发).
 * why 必填 —— 让"Why 面板"能解释这次变异为何被压。
 */
export async function emitPersonalityRiskGated(ingestor, args) {
    if (!args.gate.downgraded)
        return null;
    const m = args.gate.mutation;
    return ingestor.ingest({
        type: 'personality.risk_gated',
        human: {
            title: `风险闸降级 → ${m.category}/${m.risk_level}`,
            why: `人格 ${personalityKey(args.personality)} 未满足高危放行 (rigor≥0.6 且 risk_tolerance≤0.5); 安全信号: ${args.gate.appliedSignals.join(', ')}`,
            severity: 'notice',
        },
        payload: {
            cycleId: args.cycleId,
            mutationId: m.id,
            category: m.category,
            riskLevel: m.risk_level,
            appliedSignals: args.gate.appliedSignals,
        },
    });
}