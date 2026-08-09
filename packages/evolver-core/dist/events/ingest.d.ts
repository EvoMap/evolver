import { EventStore, type EventStoreOptions } from './eventStore.js';
import type { RawEvent, RootEvent } from './eventSchema.js';
import type { EventSink } from './sink.js';
/** 已知事件类型 (军杰 §9; 可 registerEventType 扩展). */
export declare const EVENT_TYPES: readonly ["cycle.started", "cycle.signals_collected", "cycle.solidified", "cycle.failed", "cycle.aborted", "cycle.heartbeat", "cycle.consumed", "decision.gene_selected", "decision.triggered", "decision.suppressed", "personality.selected", "personality.risk_gated", "personality.mutated", "personality.stats_updated", "personality.pivoted", "signals.extracted", "mutation.built", "capsule.produced", "evolution_event.projected", "observer.quarantined", "observer.dead_letter", "actor.human.nudge", "actor.human.intervene", "actor.human.teach", "actor.human.observe", "actor.human.review.approve", "actor.human.review.reject", "actor.human.trust.promote", "actor.human.trust.revoke", "actor.human.sidecar.recover", "gene.distilled", "gene.distill_shadowed", "anti_gene.distilled", "anti_gene.distill_shadowed", "anti_gene.benchmark_result", "anti_gene.rollout_result", "reflection.recorded", "material.batch_ready", "value.reuse_hit", "value.inject", "value.reuse_outcome", "value.recall"];
export type EventType = (typeof EVENT_TYPES)[number];
export declare function registerEventType(t: string): void;
export declare function isKnownEventType(t: string): boolean;
export declare class IngestValidationError extends Error {
    constructor(message: string);
}
export declare class UnknownEventTypeError extends Error {
    readonly type: string;
    constructor(type: string);
}
export type IngestorOptions = (EventStoreOptions | {
    store: EventStore;
}) & {
    sink?: EventSink;
};
/** root_events 的全仓唯一写入口 (军杰 §9.2). EventStore 不对外暴露 (见 public.ts). */
export declare class Ingestor {
    private readonly store;
    private readonly sink;
    constructor(opts: IngestorOptions);
    ingest(raw: RawEvent): Promise<RootEvent>;
    readAll(): RootEvent[];
    readAllStrict(): RootEvent[];
    iterate(fromSeq?: number): Generator<RootEvent>;
    tail(n?: number): RootEvent[];
    recover(): {
        truncated: boolean;
    };
    get path(): string;
}