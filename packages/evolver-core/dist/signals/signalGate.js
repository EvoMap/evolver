import { createHash } from 'node:crypto';
import { normalizeText } from '../signatures/signatures.js';
const STRENGTH_WEIGHT = { strong: 1.0, agent: 0.8, success: 0.7, weak: 0.4 };
function signatureOf(s) {
    return createHash('sha1').update(`${s.kind}\x1f${normalizeText(s.text)}`).digest('hex').slice(0, 16);
}
/** 单信号基础分 = 强度权重 ×(0.7 + 特异度). 特异度: 带 toolName/具体 kind 加成. */
function baseScore(s) {
    let specificity = 0;
    if (s.toolName)
        specificity += 0.2;
    if (s.kind !== 'difficulty')
        specificity += 0.1;
    return STRENGTH_WEIGHT[s.strength] * (0.7 + specificity);
}
/**
 * 信号打分 + 去重闸(M4A-3, task 队列前最后一道). 同签名去重并累计 occurrences(持久=更高分),
 * 丢弃低分, 截断防低质信号灌爆 task 队列(批注#18).
 */
export function signalGate(signals, cfg = {}) {
    const minScore = cfg.minScore ?? 0.3;
    const maxOutput = cfg.maxOutput ?? 50;
    const merged = new Map();
    for (const s of signals) {
        const sig = signatureOf(s);
        const existing = merged.get(sig);
        if (existing) {
            existing.occurrences += 1;
            // 持久信号加成(对数, 边际递减)
            existing.score = baseScore(existing) * (1 + Math.min(0.5, Math.log10(existing.occurrences + 1)));
        }
        else {
            merged.set(sig, { ...s, signature: sig, occurrences: 1, score: baseScore(s) });
        }
    }
    return [...merged.values()]
        .filter((s) => s.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxOutput);
}