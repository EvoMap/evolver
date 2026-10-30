const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const MAX_RETIRED_DESTINATIONS = 16;
const STATUSES = new Set(['pending', 'ambiguous', 'confirmed', 'blocked']);
const DESTINATION = /^sha256:[a-f0-9]{64}$/;
function invalid() { throw new Error('trigger_feedback_invalid_delivery'); }
function integer(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_REVISION; }
function text(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127); }
function nullableText(value) { return value === null || text(value); }
export function parseTriggerFeedbackDelivery(raw) {
    if (raw === undefined)
        return undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        invalid();
    const value = raw;
    if (value['version'] !== 1 || typeof value['destinationId'] !== 'string' || !DESTINATION.test(value['destinationId'])
        || !text(value['consentEpoch']) || !integer(value['desiredRevision']) || !nullableText(value['desiredOperationId'])
        || !(value['acknowledgedRevision'] === null || integer(value['acknowledgedRevision'])) || !nullableText(value['acknowledgedOperationId'])
        || !STATUSES.has(value['status']) || typeof value['attempted'] !== 'boolean' || !integer(value['retryAt'])
        || (value['reason'] !== undefined && (!text(value['reason']) || !/^trigger_feedback_[a-z_]+$/.test(value['reason'])))
        || !Array.isArray(value['retired']) || value['retired'].length > MAX_RETIRED_DESTINATIONS)
        invalid();
    if ((value['desiredRevision'] === 0) !== (value['desiredOperationId'] === null)
        || ((value['acknowledgedRevision'] === null || value['acknowledgedRevision'] === 0) ? value['acknowledgedOperationId'] !== null : !text(value['acknowledgedOperationId']))
        || (typeof value['acknowledgedRevision'] === 'number' && value['acknowledgedRevision'] > value['desiredRevision'])
        || (value['status'] === 'confirmed' && (value['acknowledgedRevision'] !== value['desiredRevision'] || value['acknowledgedOperationId'] !== value['desiredOperationId'])))
        invalid();
    for (const item of value['retired']) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            invalid();
        const row = item;
        if (typeof row['destinationId'] !== 'string' || !DESTINATION.test(row['destinationId']) || !integer(row['revision'])
            || !STATUSES.has(row['status']) || !(row['acknowledgedRevision'] === null || integer(row['acknowledgedRevision'])))
            invalid();
    }
    if (value['claim'] !== undefined) {
        const row = value['claim'];
        if (!row || typeof row !== 'object' || Array.isArray(row))
            invalid();
        const claim = row;
        if (!text(claim['id']) || !integer(claim['revision']) || !nullableText(claim['operationId']) || !integer(claim['expiresAt']))
            invalid();
    }
    return structuredClone(value);
}
export function advanceTriggerFeedbackDelivery(prior, snapshot, epoch) {
    if (!prior)
        return undefined;
    const revision = snapshot.commit?.revision ?? 0;
    const operationId = snapshot.commit?.operationId ?? null;
    if (revision < prior.desiredRevision)
        throw new Error('trigger_feedback_stale_revision');
    if (revision === prior.desiredRevision && operationId !== prior.desiredOperationId)
        throw new Error('trigger_feedback_source_mismatch');
    const state = { ...prior, desiredRevision: revision, desiredOperationId: operationId };
    if (epoch !== prior.consentEpoch)
        return { ...state, status: 'blocked', reason: 'trigger_feedback_reset_requires_consent' };
    if (revision !== prior.desiredRevision)
        return { ...state, status: 'pending', retryAt: 0, reason: undefined };
    return state;
}
export function authorizeTriggerFeedbackDelivery(prior, snapshot, epoch, destinationId) {
    if (!DESTINATION.test(destinationId) || !text(epoch))
        invalid();
    const advanced = advanceTriggerFeedbackDelivery(prior, snapshot, epoch);
    if (advanced && advanced.destinationId === destinationId && advanced.consentEpoch === epoch) {
        return { ...advanced, status: advanced.status === 'blocked' ? 'pending' : advanced.status, retryAt: 0, reason: undefined };
    }
    const retired = [...(prior?.retired ?? [])];
    if (prior) {
        if (retired.length >= MAX_RETIRED_DESTINATIONS)
            throw new Error('trigger_feedback_capacity');
        retired.push({ destinationId: prior.destinationId, revision: prior.desiredRevision, status: prior.status, acknowledgedRevision: prior.acknowledgedRevision });
    }
    return { version: 1, destinationId, consentEpoch: epoch, desiredRevision: snapshot.commit?.revision ?? 0,
        desiredOperationId: snapshot.commit?.operationId ?? null, acknowledgedRevision: null, acknowledgedOperationId: null,
        status: 'pending', attempted: false, retryAt: 0, retired };
}
export function claimTriggerFeedbackDelivery(prior, destinationId, id, now) {
    if (!text(id) || !integer(now))
        invalid();
    if (prior.destinationId !== destinationId)
        return { state: { ...prior, status: 'blocked', reason: 'trigger_feedback_destination_changed' }, claimed: false, reconcile: false };
    if (prior.status === 'blocked' || prior.status === 'confirmed' || (prior.claim && prior.claim.expiresAt > now))
        return { state: prior, claimed: false, reconcile: false };
    const state = { ...prior, claim: { id, revision: prior.desiredRevision, operationId: prior.desiredOperationId, expiresAt: now + 60_000 } };
    return { state, claimed: true, reconcile: prior.attempted || prior.claim !== undefined };
}
export function markTriggerFeedbackDispatched(prior, id, now = Date.now()) {
    if (prior.status === 'blocked' || prior.claim?.id !== id || prior.claim.revision !== prior.desiredRevision || prior.claim.operationId !== prior.desiredOperationId)
        throw new Error('trigger_feedback_stale_owner');
    if (prior.retryAt > now)
        throw new Error('trigger_feedback_retry_deferred');
    return { ...prior, status: 'ambiguous', attempted: true };
}
export function settleTriggerFeedbackDelivery(prior, id, result, now) {
    if (prior.claim?.id !== id)
        return prior;
    const blocked = prior.status === 'blocked';
    const state = { ...prior, claim: undefined, status: blocked ? prior.status : result.status,
        reason: blocked ? prior.reason : result.reason, retryAt: !blocked && result.status === 'ambiguous' ? now + 30_000 : 0 };
    if (result.status === 'confirmed') {
        if (!integer(result.revision) || result.revision !== prior.claim.revision || (result.operationId ?? null) !== prior.claim.operationId)
            throw new Error('trigger_feedback_receipt_unconfirmed');
        state.acknowledgedRevision = result.revision;
        state.acknowledgedOperationId = result.operationId ?? null;
        if (!blocked) {
            state.status = result.revision === prior.desiredRevision ? 'confirmed' : 'pending';
            state.reason = undefined;
        }
    }
    return state;
}