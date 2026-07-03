import { offlineReplay, computeFitness, DEFAULT_WEIGHTS } from '../strategy/experiment.js';
/**
 * Benchmark 框架(M4-BM, D9). 对比进化算法各策略在同一题集上的 fitness, 排名选优.
 * EverOS/SkillOpt 作**对照基线**(原创为主, 非复刻); 算法自进化时拿它当锚.
 */
export async function runBenchmark(suite, strategies, weights = DEFAULT_WEIGHTS) {
    const inputs = suite.cases.map((c) => c.input);
    const ctxOf = (i) => ({ now: 0, cycleId: `bm-${suite.cases[i]?.id ?? i}` });
    const results = [];
    for (const s of strategies) {
        const fitness = await offlineReplay(s, inputs, (input, output) => suite.score(input, output, ''), ctxOf, weights);
        results.push({ strategy: s.name, version: s.version, fitness });
    }
    results.sort((a, b) => b.fitness.score - a.fitness.score);
    return { suite: suite.name, results, winner: results[0]?.strategy ?? '' };
}
/* ── 对照基线(标注为 control, 不是真实现, D9) ── */
/** EverOS 风格对照: 倾向复用既有 skill(reuse-first). 仅作比较锚, 非复刻. */
export function everosControl(run) {
    return { name: 'everos-control', version: 'baseline', run: (input) => run(input) };
}
/** SkillOpt 风格对照: 倾向优化单一最优 skill. 仅作比较锚, 非复刻. */
export function skillOptControl(run) {
    return { name: 'skillopt-control', version: 'baseline', run: (input) => run(input) };
}
export { computeFitness };