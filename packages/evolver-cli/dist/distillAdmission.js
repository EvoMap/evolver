import {} from '@evomap/evolver-core';
import { assessDraftAdmission, } from './distillPrimitives.js';
function normalizedCandidateSignals(candidate) {
    return [...new Set((candidate.signals_match ?? [])
            .map((signal) => String(signal).trim().toLowerCase())
            .filter(Boolean))];
}
function geneSignalRef(record) {
    if (record.type !== 'Gene')
        return null;
    return {
        id: typeof record['id'] === 'string' ? String(record['id']) : undefined,
        signals_match: Array.isArray(record['signals_match']) ? record['signals_match'] : [],
    };
}
/**
 * Build the complete dedupe context without loading the entire pool. Any subset or positive-Jaccard duplicate must
 * share at least one candidate signal, so a store-side signalsAny query is complete for admission while excluding
 * unrelated Genes. MAX_SAFE_INTEGER deliberately removes the provider's default result window; silently accepting
 * a duplicate after row 1000 is worse than evaluating all signal-related rows in a mature pool.
 */
export async function assessDraftAdmissionFromStore(store, candidate, additional = [], opts = {}) {
    const intrinsic = assessDraftAdmission(candidate, [], opts);
    if (!intrinsic.admit)
        return { admission: intrinsic, existing: [...additional] };
    const signalsAny = normalizedCandidateSignals(candidate);
    const stored = signalsAny.length > 0
        ? await store.search({ kind: 'Gene', signalsAny, limit: Number.MAX_SAFE_INTEGER })
        : [];
    const existing = [
        ...stored.map(geneSignalRef).filter((ref) => ref !== null),
        ...additional,
    ];
    return { admission: assessDraftAdmission(candidate, existing, opts), existing };
}