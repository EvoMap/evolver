export class CorruptAssetSidecarError extends Error {
    sidecar;
    reason;
    code = 'CORRUPT_ASSET_SIDECAR';
    constructor(sidecar, reason) {
        super(`corrupt asset sidecar: ${sidecar}/${reason}`);
        this.sidecar = sidecar;
        this.reason = reason;
        this.name = 'CorruptAssetSidecarError';
    }
}
export function parseSidecarJsonl(raw, parseRecord) {
    const records = [];
    let rows = 0;
    let corruptRows = 0;
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        rows += 1;
        try {
            const record = parseRecord(JSON.parse(line));
            if (record)
                records.push(record);
            else
                corruptRows += 1;
        }
        catch {
            corruptRows += 1;
        }
    }
    return {
        records,
        rows,
        validRows: records.length,
        corruptRows,
        unterminated: raw.length > 0 && !raw.endsWith('\n'),
    };
}
export function assertTrustSidecarHealthy(sidecar, parsed) {
    if (parsed.unterminated)
        throw new CorruptAssetSidecarError(sidecar, 'unterminated');
    if (parsed.corruptRows > 0)
        throw new CorruptAssetSidecarError(sidecar, 'invalid_row');
}
export function parseProvenanceRecord(value) {
    const record = objectRecord(value);
    if (!record)
        return null;
    const assetId = stringField(record, 'assetId');
    const source = stringField(record, 'source');
    const at = stringField(record, 'at');
    if (!assetId
        || (source !== 'local' && source !== 'migrated' && source !== 'hub')
        || typeof record['trusted'] !== 'boolean'
        || !at
        || Number.isNaN(Date.parse(at))) {
        return null;
    }
    const decision = record['decision'] === 'promoted' || record['decision'] === 'revoked'
        ? record['decision']
        : undefined;
    const decidedBy = stringField(record, 'decidedBy');
    const promotedBy = stringField(record, 'promotedBy');
    const reason = stringField(record, 'reason');
    const frozenContentId = stringField(record, 'frozenContentId');
    if (frozenContentId !== undefined && !/^sha256:[0-9a-f]{64}$/.test(frozenContentId))
        return null;
    return {
        assetId,
        source,
        trusted: record['trusted'],
        at,
        ...(decision ? { decision } : {}),
        ...(decidedBy ? { decidedBy } : {}),
        ...(promotedBy ? { promotedBy } : {}),
        ...(reason ? { reason } : {}),
        ...(frozenContentId ? { frozenContentId } : {}),
    };
}
export function parseReviewRecord(value) {
    const record = objectRecord(value);
    if (!record)
        return null;
    const assetId = stringField(record, 'assetId');
    const state = stringField(record, 'state');
    const at = stringField(record, 'at');
    if (!assetId
        || (state !== 'quarantined' && state !== 'approved' && state !== 'rejected')
        || !at
        || Number.isNaN(Date.parse(at))) {
        return null;
    }
    const by = stringField(record, 'by');
    const reason = stringField(record, 'reason');
    return {
        assetId,
        state,
        at,
        ...(by ? { by } : {}),
        ...(reason ? { reason } : {}),
    };
}
export function parseAssetSyncRecord(value) {
    const record = objectRecord(value);
    if (!record)
        return null;
    const assetId = stringField(record, 'assetId');
    const type = stringField(record, 'type');
    const source = stringField(record, 'source');
    const scope = stringField(record, 'scope');
    const syncedAt = stringField(record, 'syncedAt');
    const remoteAssetId = stringField(record, 'remoteAssetId');
    if (!assetId
        || (type !== 'Gene' && type !== 'Capsule')
        || source !== 'hub'
        || (scope !== 'purchased' && scope !== 'published')
        || !syncedAt
        || !remoteAssetId) {
        return null;
    }
    const logicalId = rawStringField(record, 'logicalId');
    const status = stringField(record, 'status');
    const runKey = optionalStrictString(record, 'runKey');
    const inventoryKey = optionalStrictString(record, 'inventoryKey');
    if (runKey === null || inventoryKey === null)
        return null;
    const forced = record['forced'] === true;
    const collisionWithAssetId = stringField(record, 'collisionWithAssetId');
    return {
        assetId,
        type,
        source,
        scope,
        syncedAt,
        remoteAssetId,
        ...(runKey ? { runKey } : {}),
        ...(inventoryKey ? { inventoryKey } : {}),
        ...(logicalId ? { logicalId } : {}),
        ...(status ? { status } : {}),
        ...(forced ? { forced: true } : {}),
        ...(collisionWithAssetId ? { collisionWithAssetId } : {}),
    };
}
const MAX_INVENTORY_SEGMENTS = 24;
const MAX_INVENTORY_ITEMS_PER_SEGMENT = 10_000;
const MAX_INVENTORY_STRING_LENGTH = 4096;
export const ASSET_SYNC_INVENTORY_MAX_SEGMENT_BYTES = 2 * 1024 * 1024;
export function parseAssetSyncRunRecord(value) {
    const record = objectRecord(value);
    if (!record || record['recordType'] !== 'run')
        return null;
    const runId = optionalStrictString(record, 'runId');
    const runKey = optionalStrictString(record, 'runKey');
    const state = optionalStrictString(record, 'state');
    const currentTimestamp = optionalStrictString(record, 'syncedAt');
    const legacyTimestamp = optionalStrictString(record, 'at');
    if (!runId
        || !runKey
        || state === null
        || !isRunState(state)
        || currentTimestamp === null
        || legacyTimestamp === null
        || (currentTimestamp && legacyTimestamp && currentTimestamp !== legacyTimestamp)) {
        return null;
    }
    const syncedAt = currentTimestamp ?? legacyTimestamp;
    if (!syncedAt || Number.isNaN(Date.parse(syncedAt)))
        return null;
    const remoteAssetId = optionalStrictString(record, 'remoteAssetId');
    const outcomeValue = optionalStrictString(record, 'outcome');
    const reason = optionalStrictString(record, 'reason');
    if (remoteAssetId === null || outcomeValue === null || reason === null)
        return null;
    const outcome = isRunOutcome(outcomeValue) ? outcomeValue : undefined;
    if (outcomeValue !== undefined && !outcome)
        return null;
    let plan;
    const rawPlan = record['plan'];
    if (rawPlan !== undefined) {
        if (!Array.isArray(rawPlan) || rawPlan.length === 0)
            return null;
        const normalized = rawPlan.map((entry) => typeof entry === 'string' ? entry.trim() : '');
        if (normalized.some((entry, index) => !entry || entry !== rawPlan[index]))
            return null;
        if (new Set(normalized).size !== normalized.length)
            return null;
        plan = Object.freeze(normalized);
    }
    if (state === 'started' && (remoteAssetId || outcome || reason))
        return null;
    if (state === 'progress') {
        if (!remoteAssetId || !outcome || plan)
            return null;
        if ((outcome === 'failed') !== Boolean(reason))
            return null;
    }
    if (state === 'completed' && (remoteAssetId || outcome || reason || plan))
        return null;
    return immutableRunRecord({
        recordType: 'run',
        runId,
        runKey,
        state,
        ...(remoteAssetId ? { remoteAssetId } : {}),
        ...(outcome ? { outcome } : {}),
        ...(reason ? { reason } : {}),
        ...(plan ? { plan } : {}),
        syncedAt,
    });
}
export function parseAssetSyncInventorySegmentRecord(value) {
    const record = objectRecord(value);
    if (!record || record['recordType'] !== 'inventory_scan')
        return null;
    try {
        if (Buffer.byteLength(JSON.stringify(record), 'utf8') > ASSET_SYNC_INVENTORY_MAX_SEGMENT_BYTES)
            return null;
    }
    catch {
        return null;
    }
    const scanId = strictBoundedString(record['scanId']);
    const inventoryKey = strictBoundedString(record['inventoryKey']);
    const scope = strictBoundedString(record['scope']);
    const syncedAt = strictBoundedString(record['syncedAt']);
    const index = record['index'];
    const inputCursorFingerprints = parseInventoryCursorFingerprints(record['inputCursorFingerprints']);
    const nextCursorFingerprints = parseInventoryCursorFingerprints(record['nextCursorFingerprints']);
    const anonymousBlocked = record['anonymousBlocked'];
    const cursorHeld = record['cursorHeld'];
    const batchId = record['batchId'];
    const batchIndex = record['batchIndex'];
    const batchSize = record['batchSize'];
    const rawItems = record['items'];
    const hasBatchMetadata = batchId !== undefined || batchIndex !== undefined || batchSize !== undefined;
    if (!scanId
        || !inventoryKey
        || (scope !== 'purchased' && scope !== 'published' && scope !== 'all')
        || !syncedAt
        || Number.isNaN(Date.parse(syncedAt))
        || !Number.isInteger(index)
        || index < 0
        || index >= MAX_INVENTORY_SEGMENTS
        || !inputCursorFingerprints
        || !nextCursorFingerprints
        || !Number.isInteger(anonymousBlocked)
        || anonymousBlocked < 0
        || anonymousBlocked > MAX_INVENTORY_ITEMS_PER_SEGMENT
        || !Array.isArray(rawItems)
        || rawItems.length > MAX_INVENTORY_ITEMS_PER_SEGMENT
        || (cursorHeld !== undefined && cursorHeld !== true)
        || (hasBatchMetadata && (!strictBoundedString(batchId)
            || !Number.isInteger(batchIndex)
            || !Number.isInteger(batchSize)
            || batchSize < 2
            || batchSize > MAX_INVENTORY_SEGMENTS
            || batchIndex < 0
            || batchIndex >= batchSize
            || index - batchIndex < 0
            || index + (batchSize - batchIndex) > MAX_INVENTORY_SEGMENTS))) {
        return null;
    }
    if (scope === 'purchased'
        && (inputCursorFingerprints.published !== null || nextCursorFingerprints.published !== null))
        return null;
    if (cursorHeld === true
        && (inputCursorFingerprints.purchased !== nextCursorFingerprints.purchased
            || inputCursorFingerprints.published !== nextCursorFingerprints.published))
        return null;
    if (scope === 'published'
        && (inputCursorFingerprints.purchased !== null || nextCursorFingerprints.purchased !== null))
        return null;
    if (index === 0
        && (inputCursorFingerprints.purchased !== null || inputCursorFingerprints.published !== null))
        return null;
    const items = [];
    const seen = new Set();
    for (const rawItem of rawItems) {
        const item = objectRecord(rawItem);
        if (!item)
            return null;
        const remoteAssetId = strictBoundedString(item['remoteAssetId']);
        const outcome = strictBoundedString(item['outcome']);
        if (!remoteAssetId || !isInventoryOutcome(outcome) || seen.has(remoteAssetId))
            return null;
        seen.add(remoteAssetId);
        items.push(Object.freeze({ remoteAssetId, outcome }));
    }
    if (items.length + anonymousBlocked > MAX_INVENTORY_ITEMS_PER_SEGMENT)
        return null;
    return Object.freeze({
        recordType: 'inventory_scan',
        scanId,
        inventoryKey,
        scope,
        index: index,
        inputCursorFingerprints,
        nextCursorFingerprints,
        items: Object.freeze(items),
        anonymousBlocked: anonymousBlocked,
        ...(cursorHeld === true ? { cursorHeld: true } : {}),
        ...(hasBatchMetadata ? {
            batchId: batchId,
            batchIndex: batchIndex,
            batchSize: batchSize,
        } : {}),
        syncedAt,
    });
}
export function parseAssetSyncSidecarRecord(value) {
    const record = objectRecord(value);
    if (!record)
        return null;
    if (record['recordType'] !== undefined) {
        if (record['recordType'] === 'run')
            return parseAssetSyncRunRecord(record);
        if (record['recordType'] === 'inventory_scan')
            return parseAssetSyncInventorySegmentRecord(record);
        return null;
    }
    return parseAssetSyncRecord(record);
}
function parseInventoryCursorFingerprints(value) {
    const record = objectRecord(value);
    if (!record || !Object.hasOwn(record, 'purchased') || !Object.hasOwn(record, 'published'))
        return null;
    const purchased = strictNullableCursorFingerprint(record['purchased']);
    const published = strictNullableCursorFingerprint(record['published']);
    if (purchased === undefined || published === undefined)
        return null;
    return Object.freeze({ purchased, published });
}
function strictNullableCursorFingerprint(value) {
    if (value === null)
        return null;
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
function strictBoundedString(value) {
    return typeof value === 'string'
        && value.length <= MAX_INVENTORY_STRING_LENGTH
        && value.trim()
        && value === value.trim()
        ? value
        : undefined;
}
function isInventoryOutcome(value) {
    return value === 'imported'
        || value === 'already_local'
        || value === 'blocked'
        || value === 'failed'
        || value === 'pending';
}
function objectRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function stringField(value, key) {
    const raw = value[key];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}
function rawStringField(value, key) {
    const raw = value[key];
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
function optionalStrictString(value, key) {
    const raw = value[key];
    if (raw === undefined)
        return undefined;
    return typeof raw === 'string' && raw.trim() && raw === raw.trim() ? raw : null;
}
function immutableRunRecord(record) {
    const plan = record.plan ? Object.freeze([...record.plan]) : undefined;
    return Object.freeze({ ...record, ...(plan ? { plan } : {}) });
}
function isRunState(value) {
    return value === 'started' || value === 'progress' || value === 'completed';
}
function isRunOutcome(value) {
    return value === 'imported'
        || value === 'already_local'
        || value === 'failed'
        || value === 'remote_missing';
}