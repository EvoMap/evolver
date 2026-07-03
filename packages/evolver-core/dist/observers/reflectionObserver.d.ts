import type { Ingestor } from '../events/ingest.js';
import type { Observer } from './observerBus.js';
export declare const REFLECTION_RECORDED_EVENT_TYPE = "reflection.recorded";
export declare const REFLECTION_SOURCE_EVENT_TYPES: readonly ["cycle.solidified", "cycle.failed"];
export type ReflectionOutcome = 'success' | 'failed' | 'inert';
export type ReflectionAction = 'reinforce_successful_pattern' | 'investigate_failure_pattern' | 'avoid_inert_loop';
export interface ReflectionSummaryInput {
    type: string;
    sourceEventId: string;
    cycleId: string;
    geneId?: string;
    outcome?: ReflectionOutcome;
    score?: number;
    producedValue?: boolean;
    error?: string;
}
export interface ReflectionSummary {
    sourceEventId: string;
    cycleId: string;
    outcome: ReflectionOutcome;
    action: ReflectionAction;
    summary: string;
    geneId?: string;
    score?: number;
}
export interface ReflectionObserverDeps {
    ingestor: Ingestor;
    timeoutMs?: number;
}
export declare function buildReflectionSummary(input: ReflectionSummaryInput): ReflectionSummary;
export declare function reflectionObserver(deps: ReflectionObserverDeps): Observer;