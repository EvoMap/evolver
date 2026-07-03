import type { GepCategory, Mutation } from '../wire/index.js';
import type { GeneDecision } from './geneSelection.js';
export interface BuildMutationInput {
    decision: GeneDecision;
    category: GepCategory;
    signals: readonly string[];
    target: string;
    expectedEffect: string;
    riskOverride?: Mutation['risk_level'];
}
/** 由选择决策构造 Mutation(瞬态, 不落资产库; 进 root_events). */
export declare function buildMutation(input: BuildMutationInput): Mutation;