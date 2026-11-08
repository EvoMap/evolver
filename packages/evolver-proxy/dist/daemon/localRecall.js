import { assetstore, events, hub, ops } from '@evomap/evolver-core';
import { isTrialHoldout } from './distillMeasures.js';
const MAX_LOCAL_RECALL_RECORDS = 20_000;
// Passing the local strength gate is already the evidence; the floor keeps a local hit above the host's own
// similarity cut (0.3) and comparable with the Hub's scores, which the host ranks the merged candidates by.
const LOCAL_SIMILARITY_FLOOR = 0.5;
// Recall sits on the critical path of the host's step; a store this slow to read is left out of this turn.
export const LOCAL_RECALL_TIMEOUT_MS = 1_500;
// A read still running this long after it started is taken for hung; recall may then start a fresh one.
export const LOCAL_RECALL_STALE_MS = 30_000;
// Hung reads cannot be reclaimed; past this many still outstanding, recall waits for one to end instead of adding more.
export const MAX_OUTSTANDING_LOCAL_READS = 2;
/** Per-asset reuse counts the hosts recorded in root_events, active log and rotated archive alike, re-read only
 *  when that history changed. */
export function rootEventReuseTallies(path = events.rootEventsPath()) {
    let generation = 0;
    let cached;
    // Keep the last verified counts when history is unreadable; without a snapshot, negative evidence is unknown.
    return async (options = {}) => {
        const attempt = ++generation;
        const check = () => {
            options.signal?.throwIfAborted();
            if (options.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) || Date.now() >= options.deadlineAt)) {
                throw new Error('local_recall_timeout');
            }
        };
        try {
            check();
            const version = await events.rootEventHistoryVersion(path);
            check();
            if (cached?.version === version) {
                cached.generation = Math.max(cached.generation, attempt);
                return cached.tallies;
            }
            const history = await events.readRootEventHistoryAsync(path, options);
            const summary = await ops.summarizeReuseOutcomesAsync(history, options);
            check();
            const tallies = new Map(summary.perGene.map((gene) => [gene.assetId, { success: gene.success, negative: gene.negative }]));
            if (!cached || attempt > cached.generation)
                cached = { generation: attempt, version, tallies };
            return tallies;
        }
        catch (error) {
            if (error instanceof events.AuditCleanupError)
                throw error;
            check();
            if (!cached)
                throw error;
            return cached.tallies;
        }
    };
}
const TRIAL_NOTICE = '[On trial, not yet verified] ';
const TRIAL_BAN_FAILURES = 2;
function recalledAsset(hit, trial) {
    // Only notes recall matched to this project leave the store; a record's own fields cannot carry any.
    const { project_notes: _unvouched, recall: _claimed, ...gene } = hit.gene;
    return {
        ...gene,
        ...(trial && typeof gene['summary'] === 'string' ? { summary: `${TRIAL_NOTICE}${gene['summary']}` } : {}),
        similarity: LOCAL_SIMILARITY_FLOOR + (1 - LOCAL_SIMILARITY_FLOOR) * hit.relevance,
        ...(hit.projectNotes.length > 0 ? { project_notes: hit.projectNotes } : {}),
        recall: {
            source: 'local',
            relevance: hit.relevance,
            signal_hits: hit.signalHits,
            prompt_similarity: hit.promptSimilarity,
            project_match: hit.projectMatch,
            reuse: hit.reuse,
            merged_asset_ids: hit.mergedAssetIds,
            ...(trial ? { trial: true } : {}),
        },
    };
}
/** A project-bound Gene is recalled only in the project one of its Capsules was distilled in. */
function isBoundHere(gene, capsules, fingerprint) {
    if (!fingerprint)
        return false;
    const geneId = String(gene['id'] ?? gene.asset_id);
    return capsules.some((capsule) => capsule['gene'] === geneId
        && capsule['content']?.project_fingerprint === fingerprint);
}
/** Quarantined drafts that may be tried once: every other gate still applies, and two failures end the trial. */
function trialPool(genes, capsules, eligibility) {
    const onTrial = genes.filter((gene) => eligibility.review.get(gene.asset_id)?.state === 'quarantined');
    if (onTrial.length === 0)
        return [];
    const review = new Map(eligibility.review);
    for (const gene of onTrial)
        review.delete(gene.asset_id);
    const relaxed = { ...eligibility, review };
    const failures = new Map();
    for (const capsule of capsules) {
        if (capsule['outcome']?.status !== 'failed' || capsule['resolution_status'] === 'pending')
            continue;
        const geneId = String(capsule['gene'] ?? '');
        failures.set(geneId, (failures.get(geneId) ?? 0) + 1);
    }
    const trialGenes = onTrial.filter((gene) => (failures.get(String(gene['id'] ?? gene.asset_id)) ?? 0) < TRIAL_BAN_FAILURES
        && assetstore.assetContextEligibilityReason(gene, relaxed) === undefined);
    const ids = new Set(trialGenes.map((gene) => String(gene['id'] ?? gene.asset_id)));
    return [...trialGenes, ...capsules.filter((capsule) => ids.has(String(capsule['gene'] ?? ''))
            && assetstore.assetContextEligibilityReason(capsule, relaxed) === undefined)];
}
function diagnosticsOf(result) {
    return {
        considered: result.considered,
        injected: result.hits.length,
        ...(result.refusal ? { refusal: result.refusal } : {}),
        ...(result.closest ? { closest: { asset_id: result.closest.assetId, relevance: result.closest.relevance,
                prompt_similarity: result.closest.promptSimilarity, signal_hits: result.closest.signalHits } } : {}),
    };
}
/** The local Gene, with its project's notes, that this prompt should get from the local store, or none. */
export async function recallFromLocalStore(store, text, projectDir, onWithheld = () => undefined) {
    const [geneRead, capsuleRead] = await Promise.allSettled([
        Promise.resolve().then(() => store.list('Gene', MAX_LOCAL_RECALL_RECORDS + 1)),
        Promise.resolve().then(() => store.list('Capsule', MAX_LOCAL_RECALL_RECORDS + 1)),
    ]);
    if (geneRead.status === 'rejected' && capsuleRead.status === 'rejected') {
        const causes = [geneRead.reason, capsuleRead.reason];
        const cleanupFailures = causes.filter((cause) => cause instanceof events.AuditCleanupError && !cause.cleanupComplete);
        if (cleanupFailures.length > 0) {
            throw new events.AuditCleanupError({ status: 'failed', error: new AggregateError(causes, 'local_recall_reads_failed') }, new AggregateError(cleanupFailures, 'local_recall_cleanup_pending'), events.auditCleanupSequence(cleanupFailures.map((failure) => ({
                run: () => failure.retryCleanup(), retryFailedOperation: true,
            }))));
        }
    }
    if (geneRead.status === 'rejected')
        throw geneRead.reason;
    if (capsuleRead.status === 'rejected')
        throw capsuleRead.reason;
    const allGenes = geneRead.value;
    const allCapsules = capsuleRead.value;
    const truncated = allGenes.length > MAX_LOCAL_RECALL_RECORDS || allCapsules.length > MAX_LOCAL_RECALL_RECORDS;
    const genes = allGenes.slice(0, MAX_LOCAL_RECALL_RECORDS);
    const capsules = allCapsules.slice(0, MAX_LOCAL_RECALL_RECORDS);
    const contexts = typeof store.readLocalContextsV1 === 'function' && capsules.length > 0
        ? await store.readLocalContextsV1(capsules.map((capsule) => capsule.asset_id)) : [];
    const query = { text, projectFingerprint: await assetstore.projectFingerprint(projectDir) };
    const outcomeOf = (result, trial) => {
        const rawAssets = new Map(result.hits.map((hit) => [recalledAsset(hit, trial), hit.gene]));
        return { assets: [...rawAssets.keys()], rawAssets, diagnostics: { ...diagnosticsOf(result), ...(truncated ? { truncated } : {}) } };
    };
    const inScope = genes.filter((gene) => !hub.isProjectBoundGene(gene) || isBoundHere(gene, capsules, query.projectFingerprint));
    return { finish: (eligibility, reuse) => {
            const qualified = [...inScope, ...capsules].filter((asset) => assetstore.assetContextEligibilityReason(asset, eligibility) === undefined);
            const result = assetstore.recallLocalAssets(qualified, query, reuse, contexts);
            if (result.hits.length > 0)
                return outcomeOf(result, false);
            const trial = trialPool(inScope, capsules, eligibility);
            if (trial.length === 0)
                return outcomeOf(result, false);
            const trialResult = assetstore.recallLocalAssets(trial, { ...query, limit: 1 }, reuse, contexts);
            const drafted = trialResult.hits[0]?.gene;
            if (!drafted)
                return outcomeOf(result, false);
            if (!isTrialHoldout(String(drafted['id'] ?? drafted.asset_id), text))
                return outcomeOf(trialResult, true);
            const withheldId = onWithheld(drafted.asset_id);
            const withheld = outcomeOf(result, false);
            const named = { asset_id: drafted.asset_id, ...(withheldId ? { withheld_id: withheldId } : {}) };
            return { ...withheld, diagnostics: { ...withheld.diagnostics, trial_withheld: named } };
        } };
}