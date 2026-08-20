// Distill observer composition (#117 A1) — the CLI layer that turns core's `distillObserver` into a LIVE drain of
// M1 material into quarantined gene drafts. Core owns the trigger policy (material.batch_ready + single-flight);
// this layer owns the side effects core must not: claim from the consumer group, re-read + parse the session via
// the runtime adapters, draft via the SHARED distill primitive, quarantine in the ReviewLedger, and emit
// gene.distilled. It reuses the exact same `draftGeneCandidate` as `evolver ingest --distill`, so the one-shot and
// the auto path never drift.
//
// WIRING (#117 / #106): this composition is ready to register on the resident daemon's ObserverBus, but the
// PRODUCER of material.batch_ready (a daemon ingesting session dirs onto the same bus Ingestor) is a #106 item.
// Until that lands, the composition is verified by its integration test (real bus + Ingestor dispatch) but not yet
// wired into autoexec — a tracked dependency, not dead code. See distillObserver.test.ts.
import { assetstore, events, observers, signals, algo } from '@evomap/evolver-core';
import { readFileSync } from 'node:fs';
import { draftGeneCandidate } from './distillPrimitives.js';
import { assessDraftAdmissionFromStore } from './distillAdmission.js';
import { reviewLedgerForStore } from './reviewFilter.js';
import { runtimeSessionSourcesForMaterial } from './materialSnapshot.js';
/** Consumer group the distill drain claims under — independent cursor from any other material consumer. */
export const DISTILL_CONSUMER_GROUP = 'distill';
/** Drafts created per tick — bound the auto-draft rate so an idle daemon does not flood the human review queue. */
const DEFAULT_MAX_PER_TICK = 3;
/**
 * The injected drain side-effect: claim ready material → draft + quarantine genes. `runtime_session` material is
 * distilled (its narration drafts a strategy); `proxy_trace` is observation-only (metadata, no narration) and is
 * acked without drafting. Best-effort per material: a missing/unparseable source never blocks the rest of the
 * batch. Every material in the claimed batch is acked (drafted, skipped, or failed) so the cursor always advances.
 */
export function makeDistillDrain(c) {
    const review = c.review ?? reviewLedgerForStore(c.store);
    const maxPerTick = c.maxPerTick ?? DEFAULT_MAX_PER_TICK;
    const readSource = c.readSource ?? ((p) => readFileSync(p, 'utf8'));
    // Process ONE claimed material. `ack:true` ⇒ advance the cursor past it; `ack:false` ⇒ either a persist/audit
    // write failed OR the remaining per-tick draft budget was reached — leave it for a retry tick. A bad/unparseable/
    // missing source, a proxy_trace, a too-thin session, or a duplicate are all "handled" (skip + ack).
    async function processOne(m, audited, draftLimit) {
        // Only session narration distills; proxy_trace is observation-only (no turns to draft a strategy from).
        if (m.sourceKind !== 'runtime_session' || m.kind !== 'session_log')
            return { ack: true, drafted: 0 };
        let sources;
        try {
            sources = runtimeSessionSourcesForMaterial(m, readSource);
        }
        catch {
            return { ack: true, drafted: 0 }; // bad / missing / unparseable source — nothing to retry
        }
        let drafted = 0;
        for (const source of sources) {
            if (drafted >= draftLimit)
                return { ack: false, drafted };
            const draftedCandidate = draftGeneCandidate(source.turns, signals.extractSignals(source.turns), source.agent);
            if (!draftedCandidate)
                continue; // too thin to distill
            // Carry producer-resolved task domain into draft signals_match so selection can score domain evidence.
            // Only attach when the source already carries a resolved slug (fail-closed stamp at ingest).
            let candidate = draftedCandidate;
            if (source.taskDomain) {
                try {
                    const domainToken = signals.taskDomainSignal(source.taskDomain);
                    const existingSignals = candidate.signals_match ?? [];
                    if (!existingSignals.includes(domainToken)) {
                        candidate = { ...candidate, signals_match: [...existingSignals, domainToken] };
                    }
                }
                catch {
                    // Invalid slug on the source — leave signals_match untouched (never invent).
                }
            }
            // Value/novelty gate (#117 improvement 3): drop thin / near-duplicate drafts BEFORE they reach the human
            // review queue. Ack the material (a deliberate skip, not a failure — nothing to retry).
            const { admission, existing } = await assessDraftAdmissionFromStore(c.store, candidate);
            if (!admission.admit)
                continue;
            const r = algo.intakeGene(candidate, existing);
            if (!r.ok || !r.gene)
                continue; // duplicate / rejected
            // WRITE phase — three NON-ATOMIC writes (audit / quarantine / persist). Make each idempotent so ANY partial
            // failure self-heals on the next-tick retry with NO duplicate and NO dangling record:
            //   1. emit gene.distilled ONCE, gated on `audited` (the spine's existing gene.distilled asset_ids) — a retry
            //      after a later failure never double-records the audit.
            //   2. quarantine AFTER the audit succeeds — a failed emit leaves no quarantine for a never-audited asset.
            //   3. persist LAST (the commit). store.put is asset_id-idempotent, so a retry re-put is a no-op.
            // Any throw → leave the material UN-acked to retry. Invariant: gene in pool ⟹ exactly one gene.distilled.
            const assetId = String(r.gene.asset_id);
            try {
                if (!audited.has(assetId)) {
                    await c.ingestor.ingest({
                        type: 'gene.distilled',
                        payload: { geneId: r.gene.id, assetId: r.gene.asset_id, category: r.gene.category, source: 'distill-observer', materialId: m.materialId, ...(source.sessionId ? { sessionId: source.sessionId } : {}) },
                        human: { title: `auto-distilled gene ${r.gene.id} (UNPROVEN — awaiting review)`, severity: 'info' },
                        actor: { kind: 'machine', id: 'distill-observer' },
                    });
                    audited.add(assetId);
                }
                review.quarantineIfAbsent(assetId);
                const put = await c.store.put(r.gene);
                if (put.stored)
                    drafted += 1;
            }
            catch {
                return { ack: false, drafted }; // retryable persist/audit failure — do NOT ack
            }
        }
        return { ack: true, drafted };
    }
    return async () => {
        // Asset_ids already recorded as gene.distilled on the spine — the idempotency set that makes a retry never
        // re-emit. Built once per drain (in-tick emits extend it); a fresh drain re-reads the now-durable event.
        const audited = new Set(c.ingestor.readAll()
            .filter((e) => e.type === 'gene.distilled')
            .map((e) => String(e.payload?.['assetId'] ?? ''))
            .filter(Boolean));
        let totalDrafted = 0;
        let stalled = false;
        // Draft up to maxPerTick new genes, then stop. A remaining backlog OR a stuck head (a material whose write keeps
        // failing, or a multi-session source that hit the rate cap mid-file) reports `stalled` so the observer
        // self-schedules a backoff retry rather than waiting for a future material.batch_ready that may never come.
        for (;;) {
            const before = c.consumer.position(DISTILL_CONSUMER_GROUP);
            const batch = c.consumer.claim(DISTILL_CONSUMER_GROUP, maxPerTick);
            if (batch.length === 0)
                break; // queue drained
            const acked = [];
            for (const m of batch) {
                if (totalDrafted >= maxPerTick) {
                    stalled = true;
                    break;
                }
                const { ack, drafted } = await processOne(m, audited, maxPerTick - totalDrafted);
                totalDrafted += drafted;
                if (ack)
                    acked.push(m.materialId);
                else {
                    stalled = true;
                    break;
                }
            }
            c.consumer.ack(DISTILL_CONSUMER_GROUP, acked);
            if (stalled || c.consumer.position(DISTILL_CONSUMER_GROUP) === before) {
                stalled = true;
                break;
            } // stuck head → retry later
            if (totalDrafted >= maxPerTick) {
                stalled = c.consumer.claim(DISTILL_CONSUMER_GROUP, 1).length > 0;
                break;
            }
        }
        return { drafted: totalDrafted, stalled };
    };
}
/** Compose the live distill observer from the daemon's material/store/ingestor — register the result on the bus.
 *  The observer only needs the `stalled` signal (to self-schedule a backoff retry); the drafted count is for the
 *  direct-drain tests / callers. */
export function resolveDistillObserver(c) {
    const drain = makeDistillDrain(c);
    return observers.distillObserver({
        distill: async () => (await drain()).stalled,
        ...(c.retryDelayMs !== undefined ? { retryDelayMs: c.retryDelayMs } : {}),
    });
}