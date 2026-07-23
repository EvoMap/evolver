// Adapter: v2 root_event log → normalized CycleRecord[] for deriveCycleHistory / computeMetaSignals.
// Mirrors how algo/cycleEngine.recentCycleOutcomes reads the log (cycle.solidified=success, cycle.failed=
// failed), grouping per cycleId so each terminal cycle becomes one record. Kept separate from metaSignals.ts
// so the meta-signal math stays a pure function over a clean shape and the v2-event coupling lives in one place.
//
// Field provenance from the v2 event payloads (see cycleEngine.ts):
//  - status:     cycle.solidified → 'success', cycle.failed → 'failed'
//  - intent:     mutation.built.payload.category (the cycle's GepCategory), if emitted
//  - genesUsed:  decision.gene_selected.payload.selectedGeneId  ||  cycle.*.payload.gene
//  - score:      cycle.*.payload.outcome.score
//  - blastRadius:capsule.produced.payload.blastRadius, if emitted. Productive {0,0} is omitted because non-git
//                proofs use it as "unknown"; measured/no-value {0,0} remains an empty-cycle marker.
// Only terminal cycles (a cycle.solidified or cycle.failed) become records; in-flight cycles are skipped.
function payloadObj(e) {
    return e.payload && typeof e.payload === 'object' ? e.payload : {};
}
function cycleIdOf(p) {
    return typeof p['cycleId'] === 'string' ? p['cycleId'] : undefined;
}
/**
 * Fold a window of root_events into per-cycle records (insertion order = chronological), suitable for
 * {@link deriveCycleHistory}. Newest-last, matching deriveCycleHistory's window expectation.
 */
export function cycleRecordsFromEvents(events) {
    const byCycle = new Map();
    const terminalOrder = [];
    const get = (id) => {
        let a = byCycle.get(id);
        if (!a) {
            a = { terminal: false };
            byCycle.set(id, a);
        }
        return a;
    };
    for (const e of events) {
        const p = payloadObj(e);
        const id = cycleIdOf(p);
        if (!id)
            continue;
        const a = get(id);
        switch (e.type) {
            case 'mutation.built': {
                if (typeof p['category'] === 'string')
                    a.intent = p['category'];
                break;
            }
            case 'decision.gene_selected': {
                if (typeof p['selectedGeneId'] === 'string')
                    a.gene = p['selectedGeneId'];
                break;
            }
            case 'capsule.produced': {
                const br = p['blastRadius'];
                if (br && typeof br === 'object') {
                    const o = br;
                    const files = typeof o['files'] === 'number' ? o['files'] : undefined;
                    const lines = typeof o['lines'] === 'number' ? o['lines'] : undefined;
                    // Non-git proofs use {0,0} as "blast unknown". producedValue is the authoritative distinction between
                    // those productive cycles and a measured zero-change git cycle.
                    const productiveUnknownBlast = p['producedValue'] === true && files === 0 && lines === 0;
                    if (!productiveUnknownBlast) {
                        a.blastRadius = {
                            ...(files !== undefined ? { files } : {}),
                            ...(lines !== undefined ? { lines } : {}),
                        };
                    }
                }
                break;
            }
            case 'cycle.solidified':
            case 'cycle.failed': {
                if (!a.terminal)
                    terminalOrder.push(id);
                a.terminal = true;
                a.status = e.type === 'cycle.solidified' ? 'success' : 'failed';
                if (typeof p['gene'] === 'string')
                    a.gene = p['gene'];
                const outcome = p['outcome'];
                if (outcome && typeof outcome === 'object' && typeof outcome['score'] === 'number') {
                    a.score = outcome['score'];
                }
                break;
            }
            default:
                break;
        }
    }
    const records = [];
    for (const id of terminalOrder) {
        const a = byCycle.get(id);
        if (!a.terminal)
            continue; // skip in-flight cycles
        const rec = {};
        if (a.intent !== undefined)
            rec.intent = a.intent;
        if (a.status !== undefined)
            rec.outcome = { status: a.status, ...(a.score !== undefined ? { score: a.score } : {}) };
        if (a.blastRadius !== undefined)
            rec.blastRadius = a.blastRadius;
        if (a.gene !== undefined)
            rec.genesUsed = [a.gene];
        records.push(rec);
    }
    return records;
}