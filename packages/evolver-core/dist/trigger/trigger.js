import { computeValue } from './valueModel.js';
export function persistenceOk(p, cfg, now) {
    const openDuration = now - Date.parse(p.firstSeenAt);
    return p.status === 'open'
        && p.occurrences >= cfg.minOccurrences
        && openDuration >= cfg.minOpenDurationMs
        && (p.cooldownUntil === null || Date.parse(p.cooldownUntil) < now);
}
/** 触发判定 = persistence ∧ value ∧ budget (军杰§5.5). */
export function evaluateTrigger(p, cfg, budget, now) {
    const value = computeValue(p.value);
    const threshold = cfg.dynamicThreshold ? cfg.dynamicThreshold() : cfg.valueThreshold;
    const reasons = [];
    const persist = persistenceOk(p, cfg.persistence, now);
    if (!persist)
        reasons.push(`persistence 未达(occ=${p.occurrences}/${cfg.persistence.minOccurrences}, status=${p.status})`);
    const valueOk = value.score >= threshold;
    if (!valueOk)
        reasons.push(`value ${value.score.toFixed(3)} < 阈值 ${threshold}`);
    const budgetOk = budget.available(p.id);
    if (!budgetOk)
        reasons.push('budget 耗尽');
    const trigger = persist && valueOk && budgetOk;
    if (trigger)
        reasons.push(`触发: value=${value.score.toFixed(3)}≥${threshold}, persistence ok, budget ok`);
    return { trigger, patternId: p.id, value, thresholdUsed: threshold, reasons };
}