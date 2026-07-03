import type { Projector } from '../events/replayer.js';
import { type CycleStage } from './stateMachine.js';
import { type CycleFailureClass } from '../algo/cycleFailureClassifier.js';
export interface CycleRecord {
    cycleId: string;
    stage: CycleStage;
    startedAt: string | null;
    endedAt: string | null;
    decisionWhy: string | null;
    geneId: string | null;
    mutationId: string | null;
    capsuleId: string | null;
    outcome: {
        status: string;
        score: number;
    } | null;
    failureClass: CycleFailureClass | null;
    failureSuppressed: boolean;
    signalCount: number;
    eventSeqs: number[];
    illegalTransitions: {
        from: CycleStage;
        eventType: string;
        seq: number;
    }[];
}
export interface CycleTimelineMV {
    cycles: Record<string, CycleRecord>;
    order: string[];
}
/** cycle timeline MV (军杰§9.3). 每 cycle 一条记录, 状态机校验非法转移. */
export declare const cycleTimelineProjector: Projector<CycleTimelineMV>;
export declare function liveCycles(mv: CycleTimelineMV): CycleRecord[];
export declare function latestCycles(mv: CycleTimelineMV, n?: number): CycleRecord[];
export declare function historicalCycles(mv: CycleTimelineMV): CycleRecord[];