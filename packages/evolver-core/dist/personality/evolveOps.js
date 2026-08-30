import { selectPersonalityForRun } from './select.js';
import { updatePersonalityStats } from './stats.js';
import { forcePivot } from './pivot.js';
import { personalityKey } from './schema.js';
/**
 * store-backed 进化算子 (PR-2): 把纯函数 select/stats/pivot 接到持久化 + 事件流.
 * 每个算子: load model → 跑纯函数 → save → emit 事件 (可审计). 事件 emit best-effort, 不阻断进化.
 */
/** 事件 human.title 有 80 字上限 (humanNarrative schema); personalityKey 约 65 字, 塞不进标题.
 *  标题只放紧凑摘要 (rigor/creativity/risk 三主轴), 完整 key + 全状态进 payload. */
function briefState(s) {
    return `r${s.rigor.toFixed(1)} c${s.creativity.toFixed(1)} k${s.risk_tolerance.toFixed(1)}`;
}
/** 每轮开始: 选人格 (自然选择 + 触发变异), 落盘, 发 personality.mutated (仅当真有变异). */
export async function applySelectForRun(deps, input = {}) {
    const model = deps.store.load();
    const result = selectPersonalityForRun(model, input);
    deps.store.save(result.model);
    if (deps.ingestor && result.mutations.length > 0) {
        await deps.ingestor.ingest({
            type: 'personality.mutated',
            human: {
                title: `人格自调参 (${briefState(result.state)})`,
                why: result.meta.triggered
                    ? `触发变异: ${result.meta.triggered.reason}${result.meta.bestKnownKey ? `; 向最佳桶 ${result.meta.bestKnownKey} 靠拢` : ''}`
                    : `向最佳已知桶 ${result.meta.bestKnownKey} 靠拢 (自然选择)`,
                severity: 'notice',
            },
            payload: {
                cycleId: deps.cycleId ?? null,
                personalityKey: result.key,
                personalityState: result.state,
                mutations: result.mutations,
                meta: result.meta,
            },
        });
    }
    return result;
}
/** 每轮结束: 把 outcome/score 回写到对应人格桶, 落盘, 发 personality.stats_updated. */
export async function applyStatsUpdate(deps, input) {
    const model = deps.store.load();
    const result = updatePersonalityStats(model, input, deps.store.nowIso());
    deps.store.save(result.model);
    if (deps.ingestor) {
        await deps.ingestor.ingest({
            type: 'personality.stats_updated',
            human: { title: `人格统计回写 ${String(input.outcome)} (${result.entry.success}✓/${result.entry.fail}✗)` },
            payload: {
                cycleId: deps.cycleId ?? null,
                personalityKey: result.key,
                outcome: String(input.outcome),
                score: input.score ?? null,
                entry: result.entry,
            },
        });
    }
    return result;
}
/** 平台期: 强制转向到探索模式, 落盘, 发 personality.pivoted. */
export async function applyForcePivot(deps, input) {
    const model = deps.store.load();
    const result = forcePivot({ ...input, base: model.current });
    const at = deps.store.nowIso();
    const key = personalityKey(result.state);
    deps.store.save({
        ...model,
        current: result.state,
        history: [
            ...model.history,
            { at, key, outcome: `pivot_${result.severity}`, score: null, notes: `Forced pivot after ${input.evalsSinceImprovement ?? 0} non-improving evals` },
        ],
    });
    if (deps.ingestor) {
        await deps.ingestor.ingest({
            type: 'personality.pivoted',
            human: {
                title: `人格强制转向 ${result.severity} (${briefState(result.state)})`,
                why: `平台期 ${input.evalsSinceImprovement ?? 0} 轮无改进; 拉高 creativity/risk_tolerance 进入探索`,
                severity: result.severity === 'required' ? 'warn' : 'notice',
            },
            payload: {
                cycleId: deps.cycleId ?? null,
                severity: result.severity,
                evalsSinceImprovement: input.evalsSinceImprovement ?? 0,
                personalityKey: key,
                personalityState: result.state,
                mutations: result.mutations,
            },
        });
    }
    return result;
}