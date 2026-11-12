import { summarizeLearningHistory } from '../assetstore/learningHistory.js';
import { DEFAULT_PROMOTE_MIN_SUCCESS } from '../algo/genePromotion.js';
import { isExecutionEligible } from '../reference/guard.js';
import { stateOf } from './assetEvolutionFamilies.js';
function latestOf(times) {
    let latest = null;
    for (const at of times)
        if (latest === null || Date.parse(at) > Date.parse(latest))
            latest = at;
    return latest;
}
export function reuseStatsOf(facts) {
    const success = facts.filter((fact) => fact.outcome === 'success').length;
    const hosts = new Set(facts.flatMap((fact) => fact.host ?? []));
    return { success, failed: facts.length - success, lastAt: latestOf(facts.map((fact) => fact.at)), hosts: [...hosts].sort() };
}
export function deliveryStatsOf(facts, withEntrypoints) {
    const stats = { count: facts.length, lastAt: latestOf(facts.map((fact) => fact.at)) };
    if (!withEntrypoints)
        return stats;
    const entrypoints = {};
    for (const fact of facts)
        entrypoints[fact.entrypoint] = (entrypoints[fact.entrypoint] ?? 0) + 1;
    return { ...stats, entrypoints };
}
function isTrusted(index, assetId) {
    return index.input.provenance.get(assetId)?.trusted !== false;
}
export function assetState(index, assetId) {
    return stateOf(index.effectiveReview.get(assetId), isTrusted(index, assetId));
}
/** The family follows its most recent decision: a new version on trial puts the family back on trial. */
// Latest decision across the family's versions: by time, then by ledger append order, never by version order.
function isLaterDecision(index, record, than) {
    const byTime = Date.parse(record.at) - Date.parse(than.at);
    if (byTime !== 0)
        return byTime > 0;
    return (index.reviewOrder.get(record) ?? -1) > (index.reviewOrder.get(than) ?? -1);
}
function familyState(index, family) {
    let latest;
    for (const member of family.members) {
        const record = index.effectiveReview.get(member.asset_id);
        if (record && (!latest || isLaterDecision(index, record, latest)))
            latest = record;
    }
    const current = family.members[family.members.length - 1];
    return stateOf(latest, isTrusted(index, current.asset_id));
}
function eligibleCapsules(index, family) {
    return (index.capsulesByFamily.get(family.key) ?? []).filter((capsule) => isExecutionEligible(capsule));
}
/** The same counting auto-promotion applies: only Capsules naming the Gene's logical id. */
function promotionOf(index, family, state) {
    if (state !== 'trial' || !family.logicalId)
        return null;
    const capsules = eligibleCapsules(index, family).filter((capsule) => capsule['gene'] === family.logicalId);
    const view = summarizeLearningHistory(family.logicalId, capsules);
    return { successes: view.success, needed: Math.max(0, DEFAULT_PROMOTE_MIN_SUCCESS - view.success), blockedBy: view.failed };
}
function bornAtOf(index, family) {
    const firsts = family.members.flatMap((member) => index.reviewByAsset.get(member.asset_id)?.[0]?.at ?? []);
    let earliest = null;
    for (const at of firsts)
        if (earliest === null || Date.parse(at) < Date.parse(earliest))
            earliest = at;
    return earliest;
}
export function summaryOf(index, family) {
    const current = family.members[family.members.length - 1];
    const state = familyState(index, family);
    const applications = summarizeLearningHistory(family.key, eligibleCapsules(index, family));
    return {
        assetId: current.asset_id,
        logicalId: family.logicalId,
        type: current.type,
        title: family.title,
        category: family.category,
        origin: family.origin,
        state,
        versions: family.members.length,
        reuse: reuseStatsOf(index.reusesByFamily.get(family.key) ?? []),
        applications: { success: applications.success, failed: applications.failed,
            inert: applications.inert ?? 0, observed: applications.observed ?? 0 },
        deliveries: deliveryStatsOf(index.deliveriesByFamily.get(family.key) ?? [], false),
        promotion: promotionOf(index, family, state),
        parents: index.parents.get(family.key)?.size ?? 0,
        children: index.children.get(family.key)?.size ?? 0,
        bornAt: bornAtOf(index, family),
        lastActivityAt: index.lastActivityByFamily.get(family.key) ?? null,
    };
}
/** Newest activity first; families with no dated activity follow, newest stored first. */
export function byRecentActivity(a, b) {
    const left = a.summary.lastActivityAt ? Date.parse(a.summary.lastActivityAt) : -Infinity;
    const right = b.summary.lastActivityAt ? Date.parse(b.summary.lastActivityAt) : -Infinity;
    if (left !== right)
        return right > left ? 1 : -1;
    return b.family.position - a.family.position;
}