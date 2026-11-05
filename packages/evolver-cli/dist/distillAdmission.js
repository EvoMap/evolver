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
/**
 * Sessions a host plugin already distilled (its Capsule records the host session id as `source_thread`). The
 * transcript backfill skips them so one session never yields both a plugin draft and a structural one.
 */
export async function sessionsDistilledByHost(store) {
    const capsules = await store.list('Capsule', 20_000);
    return new Set(capsules
        .map((capsule) => capsule['env_fingerprint']?.source_thread)
        .filter((thread) => typeof thread === 'string' && thread.length > 0));
}
const SESSION_ID_SCAN_LINES = 50;
/** The host's own session id as a transcript records it near its start (Claude `sessionId`, Codex `session_meta`). */
export function transcriptSessionIdOf(content) {
    for (const line of content.split('\n', SESSION_ID_SCAN_LINES)) {
        let row;
        try {
            row = JSON.parse(line);
        }
        catch {
            continue;
        }
        const direct = row['sessionId'] ?? row['session_id'];
        if (typeof direct === 'string' && direct)
            return direct;
        const meta = row['type'] === 'session_meta' ? row['payload']?.id : undefined;
        if (typeof meta === 'string' && meta)
            return meta;
    }
    return undefined;
}