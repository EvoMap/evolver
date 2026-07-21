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
    return {
        assetId,
        source,
        trusted: record['trusted'],
        at,
        ...(decision ? { decision } : {}),
        ...(decidedBy ? { decidedBy } : {}),
        ...(promotedBy ? { promotedBy } : {}),
        ...(reason ? { reason } : {}),
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
    const logicalId = stringField(record, 'logicalId');
    const status = stringField(record, 'status');
    const forced = record['forced'] === true;
    const collisionWithAssetId = stringField(record, 'collisionWithAssetId');
    return {
        assetId,
        type,
        source,
        scope,
        syncedAt,
        remoteAssetId,
        ...(logicalId ? { logicalId } : {}),
        ...(status ? { status } : {}),
        ...(forced ? { forced: true } : {}),
        ...(collisionWithAssetId ? { collisionWithAssetId } : {}),
    };
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