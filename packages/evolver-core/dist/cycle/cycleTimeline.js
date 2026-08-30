import { TERMINAL, stageForEventType, canTransition } from './stateMachine.js';
import { HOST_SUPPRESS_CLASSES } from '../algo/cycleFailureClassifier.js';
function newRecord(cycleId) {
    return {
        cycleId, stage: 'none', startedAt: null, endedAt: null, decisionWhy: null,
        geneId: null, mutationId: null, capsuleId: null, outcome: null, failureClass: null, failureSuppressed: false,
        signalCount: 0, eventSeqs: [], illegalTransitions: [],
    };
}
function applyFields(rec, e, to) {
    const p = (e.payload ?? {});
    const r = { ...rec, stage: to, eventSeqs: [...rec.eventSeqs, e.seq] };
    if (to === 'started')
        r.startedAt = e.ts;
    if (TERMINAL.has(to))
        r.endedAt = e.ts;
    if (to === 'gene_selected') {
        r.decisionWhy = e.human.why ?? null;
        r.geneId = p.geneId ?? null;
    }
    if (to === 'mutation_built')
        r.mutationId = p.mutationId ?? null;
    if (to === 'signals_collected')
        r.signalCount = p.signalCount ?? rec.signalCount;
    if (to === 'solidified') {
        r.capsuleId = p.capsuleId ?? null;
        r.outcome = p.outcome ?? null;
    }
    if (to === 'failed' || to === 'aborted')
        r.outcome = p.outcome ?? rec.outcome;
    if (to === 'failed' && typeof p.failure_class === 'string') {
        const failureClass = p.failure_class;
        r.failureClass = failureClass;
        r.failureSuppressed = HOST_SUPPRESS_CLASSES.has(failureClass);
    }
    return r;
}
/** cycle timeline MV (军杰§9.3). 每 cycle 一条记录, 状态机校验非法转移. */
export const cycleTimelineProjector = {
    name: 'cycle_timeline',
    initial: () => ({ cycles: {}, order: [] }),
    reduce: (state, e) => {
        const p = (e.payload ?? {});
        const cycleId = p.cycleId;
        if (!cycleId)
            return state;
        const exists = cycleId in state.cycles;
        const rec = state.cycles[cycleId] ?? newRecord(cycleId);
        const to = stageForEventType(e.type);
        let next;
        if (to === null) {
            next = { ...rec, eventSeqs: [...rec.eventSeqs, e.seq] }; // cycle 内非 stage 事件: 仅记 seq
        }
        else if (!canTransition(rec.stage, to)) {
            next = { ...rec, eventSeqs: [...rec.eventSeqs, e.seq], illegalTransitions: [...rec.illegalTransitions, { from: rec.stage, eventType: e.type, seq: e.seq }] };
        }
        else {
            next = applyFields(rec, e, to);
        }
        return {
            cycles: { ...state.cycles, [cycleId]: next },
            order: exists ? state.order : [...state.order, cycleId],
        };
    },
};
export function liveCycles(mv) {
    return mv.order.map((id) => mv.cycles[id]).filter((c) => !TERMINAL.has(c.stage));
}
export function latestCycles(mv, n = 10) {
    return mv.order.slice(-n).map((id) => mv.cycles[id]);
}
export function historicalCycles(mv) {
    return mv.order.map((id) => mv.cycles[id]);
}