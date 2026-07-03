import type { ProblemPattern } from '../schema/problem.js';
import { type ValueResult } from './valueModel.js';
import type { Budget } from './budget.js';
export interface PersistenceConfig {
    minOccurrences: number;
    minOpenDurationMs: number;
}
export interface TriggerConfig {
    persistence: PersistenceConfig;
    valueThreshold: number;
    dynamicThreshold?: () => number;
}
export interface TriggerDecision {
    trigger: boolean;
    patternId: string;
    value: ValueResult;
    thresholdUsed: number;
    reasons: string[];
}
export declare function persistenceOk(p: ProblemPattern, cfg: PersistenceConfig, now: number): boolean;
/** 触发判定 = persistence ∧ value ∧ budget (军杰§5.5). */
export declare function evaluateTrigger(p: ProblemPattern, cfg: TriggerConfig, budget: Budget, now: number): TriggerDecision;