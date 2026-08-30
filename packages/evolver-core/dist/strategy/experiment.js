import { createHash } from 'node:crypto';
export const DEFAULT_WEIGHTS = { resolved: 0.5, reuse: 0.3, cost: 0.2 };
/** fitness = w1·resolved_by_evidence率 + w2·capsule复用率 − w3·归一成本. */
export function computeFitness(samples, w = DEFAULT_WEIGHTS) {
    const n = samples.length;
    if (n === 0)
        return { n: 0, resolvedRate: 0, reuseRate: 0, avgCost: 0, score: 0 };
    const resolvedRate = samples.filter((s) => s.resolvedByEvidence).length / n;
    const reuseRate = samples.filter((s) => s.reused).length / n;
    const avgCost = samples.reduce((a, s) => a + s.cost, 0) / n;
    const score = w.resolved * resolvedRate + w.reuse * reuseRate - w.cost * avgCost;
    return { n, resolvedRate, reuseRate, avgCost, score };
}
/**
 * Shadow 评估: active 权威返回; 其余实现旁路跑同输入, 记录产出/异常供离线对比, 不影响主流程.
 * 实验台打底(算法草案§7): 所有候选先 shadow, 关键的才 A/B.
 */
export async function runShadow(sp, input, ctx) {
    const active = sp.active();
    const activeOut = await active.run(input, ctx);
    const shadows = [];
    for (const impl of sp.list()) {
        if (impl.name === active.name)
            continue;
        try {
            shadows.push({ name: impl.name, output: await impl.run(input, ctx) });
        }
        catch (e) {
            shadows.push({ name: impl.name, error: e instanceof Error ? e.message : String(e) });
        }
    }
    return { active: activeOut, activeName: active.name, shadows };
}
/** 确定性 A/B 分桶: 同 key 永远同变体(可复现, 不依赖随机). */
export function assignVariant(key, variants) {
    if (variants.length === 0)
        throw new Error('A/B 变体不能为空');
    const h = createHash('sha256').update(key).digest();
    const bucket = h.readUInt32BE(0) % variants.length;
    return variants[bucket];
}
/** A/B 路由: 按 ctx.cycleId 确定性选变体并跑. */
export async function runAB(sp, variants, input, ctx) {
    const variant = assignVariant(ctx.cycleId, variants);
    const impl = sp.get(variant);
    if (!impl)
        throw new Error(`A/B 变体无实现: ${variant}`);
    return { variant, output: await impl.run(input, ctx) };
}
/**
 * 离线回放: 用历史输入集跑某策略, 由打分器产出 fitness 样本, 算总分.
 * 用途: 新策略上线前先离线对比 active(算法草案§7 offline replay).
 */
export async function offlineReplay(impl, inputs, score, ctxOf, w = DEFAULT_WEIGHTS) {
    const samples = [];
    let i = 0;
    for (const input of inputs) {
        const out = await impl.run(input, ctxOf(i));
        samples.push(score(input, out));
        i += 1;
    }
    return computeFitness(samples, w);
}