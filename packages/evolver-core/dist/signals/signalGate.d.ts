import type { ExtractedSignal } from './extractor.js';
export interface ScoredSignal extends ExtractedSignal {
    signature: string;
    occurrences: number;
    score: number;
}
export interface SignalGateConfig {
    minScore?: number;
    maxOutput?: number;
}
/**
 * 信号打分 + 去重闸(M4A-3, task 队列前最后一道). 同签名去重并累计 occurrences(持久=更高分),
 * 丢弃低分, 截断防低质信号灌爆 task 队列(批注#18).
 */
export declare function signalGate(signals: readonly ExtractedSignal[], cfg?: SignalGateConfig): ScoredSignal[];