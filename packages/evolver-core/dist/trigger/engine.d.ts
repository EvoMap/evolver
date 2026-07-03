import type { Ingestor } from '../events/ingest.js';
import type { ProblemPattern } from '../schema/problem.js';
import { type TriggerConfig, type TriggerDecision } from './trigger.js';
import type { Budget } from './budget.js';
/** 触发引擎: 评估 → 经 ingest 落 decision.* 事件(human.why 必填) → 消费 budget. */
export declare class TriggerEngine {
    private readonly ingestor;
    private readonly cfg;
    private readonly budget;
    constructor(ingestor: Ingestor, cfg: TriggerConfig, budget: Budget);
    evaluate(p: ProblemPattern, now: number): Promise<TriggerDecision>;
}