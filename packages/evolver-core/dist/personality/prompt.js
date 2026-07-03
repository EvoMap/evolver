import { normalizePersonalityState } from './schema.js';
import { isHighRiskMutationAllowed } from './riskGate.js';
/**
 * PersonalityState 用途①: 注入每轮 GEP prompt, 决定进化"风格" (v1 src/gep/prompt.js 的人格块端口).
 *
 * 把 0..1 数值向量翻译成 agent 能照做的行为指令 —— 只影响"怎么做"(严谨/激进/啰嗦),
 * 不改"做什么". 纯函数, 同输入同输出 (对齐 renderExecPrompt 的确定性契约).
 */
/** 三档定性: 数值 → low/mid/high (阈值与 v1 语感一致). */
function band(x) {
    if (x < 0.34)
        return 'low';
    if (x < 0.67)
        return 'mid';
    return 'high';
}
const RIGOR_HINT = {
    low: 'move fast; skip exhaustive checks unless correctness is at stake',
    mid: 'balance speed with verification',
    high: 'be protocol-first and conservative; verify assumptions before acting',
};
const CREATIVITY_HINT = {
    low: 'prefer the smallest proven change; do not explore alternatives',
    mid: 'consider one alternative if the obvious path is weak',
    high: 'actively explore novel approaches to escape local optima',
};
const VERBOSITY_HINT = {
    low: 'keep output terse — minimal prose, no filler',
    mid: 'explain the key decisions briefly',
    high: 'document reasoning and trade-offs in detail',
};
const RISK_HINT = {
    low: 'avoid risky or wide-reaching edits; stay well inside the blast radius',
    mid: 'take bounded risks when the payoff is clear',
    high: 'willing to take larger risks (subject to the safety gate)',
};
const OBEDIENCE_HINT = {
    low: 'use judgment freely; deviate from convention when warranted',
    mid: 'follow instructions, deviating only with good reason',
    high: 'adhere strictly to instructions and established protocol',
};
/**
 * 渲染人格块 (markdown), 供 renderExecPrompt 拼进 agent 指令.
 * 末行显式声明高危变异是否被人格放行, 让 agent 与风险闸看到同一事实.
 */
export function renderPersonalityBlock(personality) {
    const p = normalizePersonalityState(personality ?? {});
    const pct = (n) => `${Math.round(n * 100)}%`;
    const highRiskAllowed = isHighRiskMutationAllowed(p);
    return [
        '## Evolution style (personality)',
        'Apply this behavioral posture to HOW you make the change (not what the change is):',
        `- Rigor ${pct(p.rigor)}: ${RIGOR_HINT[band(p.rigor)]}`,
        `- Creativity ${pct(p.creativity)}: ${CREATIVITY_HINT[band(p.creativity)]}`,
        `- Verbosity ${pct(p.verbosity)}: ${VERBOSITY_HINT[band(p.verbosity)]}`,
        `- Risk tolerance ${pct(p.risk_tolerance)}: ${RISK_HINT[band(p.risk_tolerance)]}`,
        `- Obedience ${pct(p.obedience)}: ${OBEDIENCE_HINT[band(p.obedience)]}`,
        highRiskAllowed
            ? 'High-risk mutations are PERMITTED by the current personality (rigor≥0.6 and risk_tolerance≤0.5).'
            : 'High-risk mutations are NOT permitted by the current personality — keep changes low/medium risk.',
    ].join('\n');
}