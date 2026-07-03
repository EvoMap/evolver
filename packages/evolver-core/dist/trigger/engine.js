import { evaluateTrigger } from './trigger.js';
/** 触发引擎: 评估 → 经 ingest 落 decision.* 事件(human.why 必填) → 消费 budget. */
export class TriggerEngine {
    ingestor;
    cfg;
    budget;
    constructor(ingestor, cfg, budget) {
        this.ingestor = ingestor;
        this.cfg = cfg;
        this.budget = budget;
    }
    async evaluate(p, now) {
        const d = evaluateTrigger(p, this.cfg, this.budget, now);
        await this.ingestor.ingest({
            type: d.trigger ? 'decision.triggered' : 'decision.suppressed',
            human: { title: `${d.trigger ? '触发' : '抑制'} ${p.id}`, why: d.reasons.join('; ') },
            payload: { patternId: p.id, value: d.value.score, factors: d.value.factors, threshold: d.thresholdUsed, reasons: d.reasons },
        });
        if (d.trigger)
            this.budget.consume(p.id);
        return d;
    }
}