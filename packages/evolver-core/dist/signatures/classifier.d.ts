import type { ProblemSignatureInput } from './signatures.js';
/** 把工程事件归类成领域问题 (event_sig → problem_sig). 可插拔: 规则/LLM/agent, 实验选 (硬化). */
export interface ProblemClassifier {
    readonly name: string;
    classify(input: ClassifyInput): ProblemSignatureInput | null;
}
export interface ClassifyInput {
    text: string;
    errorClass?: string;
    affectedSurface?: string;
}
/** MVP 规则分类器 (LLM/agent 分类器是 M4). */
export declare class RuleProblemClassifier implements ProblemClassifier {
    readonly name = "rules";
    classify(input: ClassifyInput): ProblemSignatureInput | null;
}