import { EventStore } from './eventStore.js';
/** 已知事件类型 (军杰 §9; 可 registerEventType 扩展). */
export const EVENT_TYPES = [
    'cycle.started', 'cycle.signals_collected', 'cycle.solidified', 'cycle.failed',
    'cycle.aborted', 'cycle.heartbeat', 'cycle.consumed',
    'decision.gene_selected', 'decision.triggered', 'decision.suppressed',
    'personality.selected', 'personality.risk_gated',
    'personality.mutated', 'personality.stats_updated', 'personality.pivoted',
    'signals.extracted', 'mutation.built', 'capsule.produced', 'evolution_event.projected',
    'observer.quarantined', 'observer.dead_letter',
    'actor.human.nudge', 'actor.human.intervene', 'actor.human.teach', 'actor.human.observe',
    'actor.human.review.approve', 'actor.human.review.reject',
    'actor.human.trust.promote', 'actor.human.trust.revoke',
    'actor.human.sidecar.recover',
    'gene.distilled', 'gene.distill_shadowed',
    'anti_gene.distilled', 'anti_gene.distill_shadowed',
    'anti_gene.benchmark_result', 'anti_gene.rollout_result',
    'reflection.recorded',
    'material.batch_ready',
    'value.reuse_hit', 'value.inject', 'value.reuse_outcome', 'value.recall',
];
const knownTypes = new Set(EVENT_TYPES);
export function registerEventType(t) { knownTypes.add(t); }
export function isKnownEventType(t) { return knownTypes.has(t); }
export class IngestValidationError extends Error {
    constructor(message) { super(message); this.name = 'IngestValidationError'; }
}
export class UnknownEventTypeError extends Error {
    type;
    constructor(type) {
        super(`未知事件类型: ${type}`);
        this.type = type;
        this.name = 'UnknownEventTypeError';
    }
}
/** root_events 的全仓唯一写入口 (军杰 §9.2). EventStore 不对外暴露 (见 public.ts). */
export class Ingestor {
    store;
    sink;
    constructor(opts) {
        this.store = 'store' in opts ? opts.store : new EventStore(opts);
        this.sink = opts.sink;
    }
    async ingest(raw) {
        if (!isKnownEventType(raw.type))
            throw new UnknownEventTypeError(raw.type);
        if (!raw.human || typeof raw.human.title !== 'string' || raw.human.title.length === 0)
            throw new IngestValidationError('human.title 必填 (军杰 §9.2)');
        if (raw.type.startsWith('decision.') && !raw.human.why)
            throw new IngestValidationError(`${raw.type}: decision.* 必填 human.why (Why 面板)`);
        if (raw.actor?.kind === 'human' && !raw.actor.id)
            throw new IngestValidationError('actor.kind=human 必带 actor.id (审计, 军杰 §9.7)');
        const evt = await this.store.append(raw);
        this.sink?.dispatch(evt);
        return evt;
    }
    // 读 passthrough (写只能经 ingest)
    readAll() { return this.store.readAll(); }
    iterate(fromSeq = 0) { return this.store.iterate(fromSeq); }
    tail(n = 1) { return this.store.tail(n); }
    recover() { return this.store.recover(); }
    get path() { return this.store.path; }
}