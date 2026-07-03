// Auto-recall observation (#274) — derive a session's recall verdicts from its TRANSCRIPT, not from an agent
// self-reporting via a tool it will skip. For a session that had a `value.inject` (tied by #205 sessionId), run
// the recallVerifier over the transcript turns and emit one `value.recall` per injected gene (used/unused/unknown).
// This feeds the experience loop with OBSERVED data, turning the inert manual `evolver recall` into the loop's
// real, unbiased input. PURE-ish + injectable; best-effort + never throws (it must never break session ingest).
import { events, ops, assetstore } from '@evomap/evolver-core';
import { sessionIdFromTranscript, pickInjectEvent, geneIdsOf, geneFromAsset, resolveGene } from './recall.js';
/**
 * Derive + emit `value.recall` for ONE session transcript. Returns the number of verdicts emitted (0 when there is
 * no matching inject, no resolvable gene, or the session was already recalled). Idempotent: a session whose
 * `value.recall` already exists is skipped, so a polling daemon never re-emits. Best-effort: any failure → 0, never
 * throws (session ingest must not break on a recall side-effect).
 */
export async function emitSessionRecall(transcriptPath, turns, deps) {
    try {
        if (turns.length === 0)
            return 0;
        const sessionId = sessionIdFromTranscript(transcriptPath);
        if (!sessionId)
            return 0; // no stable session key → cannot dedup safely → skip (never risk re-emitting)
        const read = deps.readEvents ?? events.readEvents;
        const evts = read();
        const inject = pickInjectEvent(evts, sessionId);
        // Only auto-recall when the inject is PROVABLY this session's (#205 stamped match). Without a stamped match we
        // would be guessing which inject produced this transcript — too weak a basis to emit observed verdicts.
        if (!inject || inject.payload?.['sessionId'] !== sessionId)
            return 0;
        const geneIds = [...new Set(geneIdsOf(inject))]; // dedup: a duplicated inject id must not double-emit (#275 Bugbot)
        if (geneIds.length === 0)
            return 0;
        // Per-gene state from prior ticks (#275 Bugbot). A `used` verdict is TERMINAL — using a gene is monotonic as the
        // transcript grows, so once used it stays used. `unused`/`unknown` are PROVISIONAL: the ingest tick can run while
        // a transcript is still growing, so a later tick (longer transcript) may UPGRADE them to `used`. Therefore: skip
        // genes already `used`; emit a first verdict; for a gene that only has a provisional verdict, emit ONLY when it
        // now upgrades to `used` — never duplicate the same provisional, and never lock a stale `unused`.
        const usedGenes = new Set();
        const seenGenes = new Set();
        for (const e of evts) {
            if (e.type !== ops.VALUE_RECALL_EVENT || e.payload?.['sessionId'] !== sessionId)
                continue;
            const gid = e.payload['geneId'];
            if (typeof gid !== 'string')
                continue;
            seenGenes.add(gid);
            if (e.payload['recalled'] === 'used')
                usedGenes.add(gid);
        }
        const store = deps.store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
        const genes = [];
        for (const id of geneIds) {
            const a = await resolveGene(store, id);
            if (a)
                genes.push(geneFromAsset(a));
        }
        if (genes.length === 0)
            return 0;
        const results = ops.verifyInjectedGenes(genes, turns);
        let emitted = 0;
        for (const r of results) {
            if (usedGenes.has(r.geneId))
                continue; // terminal: already used
            if (seenGenes.has(r.geneId) && r.recalled !== 'used')
                continue; // provisional already recorded; only an upgrade to `used` is new
            const payload = { geneId: r.geneId, recalled: r.recalled, score: r.score, sessionId };
            try {
                await deps.ingestor.ingest({
                    type: ops.VALUE_RECALL_EVENT,
                    human: { title: `recall ${r.recalled}: ${r.geneId}`, detail: `session ${sessionId}` },
                    payload: payload,
                });
                emitted += 1;
            }
            catch { /* per-gene best-effort; keep going */ }
        }
        return emitted;
    }
    catch {
        return 0;
    }
}