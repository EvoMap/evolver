import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { algo, assetstore, wire } from '@evomap/evolver-core';
import { createRecordedCheckout, RecordedTreeMismatch } from './curationGit.js';
import { hasVerificationPlan } from './observedEvidence.js';
export const CURATION_INTERVAL_MS = 10 * 60_000;
export const CURATION_IDLE_MS = 2 * 60_000;
// Host relays reach the Proxy every minute or two; checking only at each interval boundary would almost always land
// inside their activity, so the quiet window is polled for and a run still starts at most once per interval.
export const CURATION_POLL_MS = 30_000;
function geneDigest(gene) {
    return wire.canonicalize(gene);
}
async function withValidationCopy(context, scratchDir, use) {
    let parent;
    try {
        let copy;
        try {
            parent = mkdtempSync(join(scratchDir, 'evolver-validation-'));
            copy = await createRecordedCheckout(context, parent);
        }
        catch (error) {
            return error instanceof RecordedTreeMismatch ? 'not_reproducible' : 'git_setup_failed';
        }
        return await use(copy);
    }
    finally {
        if (parent)
            rmSync(parent, { recursive: true, force: true });
    }
}
function verifiedCapsule(context, gene, calls) {
    const { capsule } = algo.solidify({
        geneId: context.geneId,
        trigger: Array.isArray(gene['signals_match']) ? gene['signals_match'].map(String).slice(0, 8) : [],
        summary: `Host-verified validation of ${context.geneId}`,
        confidence: 0.9,
        outcome: { status: 'success', score: 0.9 },
        proofOfWork: { kind: 'tool_call_trace', tool_call_trace: { calls, ref: 'host-verified' } },
        strongEvidence: true,
    });
    return capsule;
}
const TERMINAL_RESULTS = new Set(['not_reproducible', 'new_failures', 'verification_plan_unavailable']);
const awaitsVerification = (context) => !context.published && !TERMINAL_RESULTS.has(context.lastAttempt?.result ?? '');
async function pendingCandidate(deps) {
    const queue = deps.contexts.list()
        .filter(awaitsVerification)
        .sort((a, b) => (a.lastAttempt?.at ?? '').localeCompare(b.lastAttempt?.at ?? ''));
    for (const context of queue) {
        if (deps.review.get(context.geneAssetId)?.state !== 'approved')
            continue;
        const gene = await deps.store.get(context.geneAssetId);
        if (gene?.type === 'Gene')
            return { context, gene };
    }
    return undefined;
}
function currentObservation(contexts, attempted) {
    const current = contexts.get(attempted.geneAssetId);
    return current && current.recordedAt === attempted.recordedAt && current.planDigest === attempted.planDigest ? current : undefined;
}
function saveCurrentObservation(contexts, attempted, update) {
    const current = currentObservation(contexts, attempted);
    if (!current || (update.verifiedAt !== undefined && !hasVerificationPlan(current)))
        return false;
    contexts.put({ ...current, ...update });
    return true;
}
function isCurrentPlan(contexts, attempted) {
    const current = currentObservation(contexts, attempted);
    return current !== undefined && !current.published && hasVerificationPlan(current);
}
async function enqueueCurrentVerification(deps, context, body, verified, geneBefore) {
    if (!algo.isGenePublishEligible(await assetstore.aggregateLearningHistory(deps.store, context.geneId)))
        return 'not_publish_eligible';
    const current = await deps.store.get(context.geneAssetId);
    if (!current || geneDigest(current) !== geneBefore)
        return 'gene_changed';
    const isCurrent = () => isCurrentPlan(deps.contexts, context);
    if (!isCurrent())
        return 'verification_plan_changed';
    const at = deps.now().toISOString();
    // The mark is written in the same synchronous step as the send, so no later plan can find the Gene unpublished.
    const commit = (send) => deps.review.withExplicitApproval(context.geneAssetId, () => {
        if (!isCurrent())
            return 'verification_plan_changed';
        if (deps.publishMode?.() === 'manual')
            return 'publish_policy_manual';
        if (!send())
            return 'not_stored';
        saveCurrentObservation(deps.contexts, context, { published: { at, envelopeId: '', assetIds: [] } });
        return 'stored';
    }) ?? 'review_not_approved';
    const publication = await deps.enqueue(body, verified, context.planDigest, commit, context.geneAssetId);
    if (!publication.queued)
        return publication.reason ?? 'publish_blocked';
    const latest = deps.contexts.get(context.geneAssetId);
    if (latest) {
        deps.contexts.put({ ...latest, published: { at, envelopeId: publication.envelopeId ?? '', assetIds: publication.assetIds ?? [] } });
    }
    return 'published';
}
async function curateOne(deps, context, gene) {
    if (!hasVerificationPlan(context))
        return 'verification_plan_unavailable';
    const verifierForRoot = deps.verifierForRoot;
    const history = await assetstore.aggregateLearningHistory(deps.store, context.geneId);
    if (context.failedAtVerification !== undefined && history.failed !== context.failedAtVerification)
        return 'new_failures';
    const before = geneDigest(gene);
    const checks = Object.freeze(context.checks.map((check) => Object.freeze({ ...check })));
    const validation = Object.freeze(checks.map(({ command }) => command));
    const body = { ...context.distillInput, validation, publish: true, persist: true };
    // The Linux verifier mounts scratch over /tmp before entering the checkout.
    const scratch = deps.scratchDir ?? (process.platform === 'linux' ? '/var/tmp' : tmpdir());
    const verified = await withValidationCopy(context, scratch, (root) => deps.verify(body, verifierForRoot(root, { checks, dependencySourceRoot: context.root }), context.planDigest));
    if (typeof verified === 'string')
        return verified;
    if (!verified)
        return 'verification_failed';
    if (!isCurrentPlan(deps.contexts, context))
        return 'verification_plan_changed';
    if (!deps.review.isExplicitlyApproved(context.geneAssetId))
        return 'review_not_approved';
    await deps.store.put(verifiedCapsule(context, gene, verified.trace.length));
    if (!saveCurrentObservation(deps.contexts, context, {
        verifiedAt: deps.now().toISOString(), failedAtVerification: history.failed,
    }))
        return 'verification_plan_changed';
    return enqueueCurrentVerification(deps, context, body, verified, before);
}
/**
 * One idle pass: promote probation drafts that earned it, then verify and publish at most one promoted Gene.
 * Every refusal leaves the Gene local and is retried on a later pass.
 */
export async function runCurationTick(deps) {
    const promoted = await algo.autoPromoteProbationGenes(deps.store, deps.review, { by: 'proxy-auto-promote' });
    if (!deps.verifierForRoot || deps.publishMode?.() === 'manual')
        return { promoted };
    const candidate = await pendingCandidate(deps);
    if (!candidate)
        return { promoted };
    const result = await curateOne(deps, candidate.context, candidate.gene);
    saveCurrentObservation(deps.contexts, candidate.context, { lastAttempt: { at: deps.now().toISOString(), result } });
    return { promoted, attempted: { geneAssetId: candidate.context.geneAssetId, result } };
}
/** Why promoted genes are or are not leaving this machine, for /proxy/status and the plugin's status command. */
export function curationStatus(contexts, review, verifierAvailable, publishMode = 'auto') {
    const all = contexts.list();
    const latest = all.filter((context) => context.lastAttempt)
        .sort((a, b) => (b.lastAttempt.at).localeCompare(a.lastAttempt.at))[0];
    return {
        publish_policy: publishMode,
        publish_verifier: verifierAvailable ? 'available' : 'unavailable',
        ...(verifierAvailable ? {} : { publish_verifier_reason: 'read_only_isolation_unavailable' }),
        awaiting_verification: all.filter((context) => awaitsVerification(context) && review.get(context.geneAssetId)?.state === 'approved').length,
        published: all.filter((context) => context.published).length,
        ...(latest ? { last_attempt: { gene_asset_id: latest.geneAssetId, result: latest.lastAttempt.result, at: latest.lastAttempt.at } } : {}),
    };
}