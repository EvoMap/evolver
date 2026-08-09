import { canonicalize, computeAssetId, verifyAssetId } from '../wire/index.js';
export class FrozenAssetIdCollisionError extends Error {
    assetId;
    code = 'FROZEN_ASSET_ID_COLLISION';
    constructor(assetId) {
        super('frozen asset_id already exists with different content');
        this.assetId = assetId;
        this.name = 'FrozenAssetIdCollisionError';
    }
}
export class InvalidFrozenPutResultError extends Error {
    code = 'INVALID_FROZEN_PUT_RESULT';
    constructor() {
        super('invalid frozen put result');
        this.name = 'InvalidFrozenPutResultError';
    }
}
export function frozenAssetRecordsEqual(left, right) {
    return canonicalize(left) === canonicalize(right);
}
export function validateFrozenPutResult(value, expectedAssetId) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new InvalidFrozenPutResultError();
    const result = value;
    if (result['asset_id'] !== expectedAssetId
        || typeof result['stored'] !== 'boolean'
        || result['verified'] !== false) {
        throw new InvalidFrozenPutResultError();
    }
    return value;
}
export class InvalidConditionalPutResultError extends Error {
    reason;
    code = 'INVALID_CONDITIONAL_PUT_RESULT';
    constructor(reason) {
        super(`invalid conditional put result: ${reason}`);
        this.reason = reason;
        this.name = 'InvalidConditionalPutResultError';
    }
}
/** Validate an injected provider response before callers treat it as an explicit write/no-write decision. */
export function validateConditionalPutResult(value, expectedAssetId, options) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new InvalidConditionalPutResultError('malformed_result');
    }
    const result = value;
    const status = result['status'];
    const collisionWithAssetId = result['collisionWithAssetId'];
    if (typeof result['asset_id'] !== 'string'
        || typeof result['stored'] !== 'boolean'
        || typeof result['verified'] !== 'boolean'
        || (status !== 'stored' && status !== 'already_exists' && status !== 'logical_collision')
        || (result['logicalId'] !== undefined
            && (typeof result['logicalId'] !== 'string'
                || !result['logicalId'].trim()
                || result['logicalId'] !== result['logicalId'].trim()))
        || (collisionWithAssetId !== undefined
            && (typeof collisionWithAssetId !== 'string'
                || !collisionWithAssetId.trim()
                || collisionWithAssetId !== collisionWithAssetId.trim()))) {
        throw new InvalidConditionalPutResultError('malformed_result');
    }
    if (result['asset_id'] !== expectedAssetId) {
        throw new InvalidConditionalPutResultError('asset_id_mismatch');
    }
    if (result['stored'] !== (status === 'stored')) {
        throw new InvalidConditionalPutResultError('inconsistent_status');
    }
    const allowLogicalCollision = options?.allowLogicalCollision === true;
    if (status === 'logical_collision'
        && (!collisionWithAssetId || collisionWithAssetId === expectedAssetId || allowLogicalCollision)) {
        throw new InvalidConditionalPutResultError('invalid_collision');
    }
    if (status === 'stored' && collisionWithAssetId && !allowLogicalCollision) {
        throw new InvalidConditionalPutResultError('collision_bypass');
    }
    return value;
}
export function supportsAtomicConditionalPut(provider) {
    return typeof provider.putConditional === 'function';
}
export function supportsAtomicFrozenConditionalPut(provider) {
    return typeof provider.putFrozenConditional === 'function';
}
export class AssetIdMismatchError extends Error {
    claimed;
    actual;
    constructor(claimed, actual) {
        super(`asset_id 不自洽: 声明 ${claimed} 实算 ${actual}`);
        this.claimed = claimed;
        this.actual = actual;
        this.name = 'AssetIdMismatchError';
    }
}
export class CapsuleGeneBindingError extends Error {
    constructor() { super('Capsule.gene 必须非空或显式 "ad-hoc" 哨兵 (批注#28/M3-4)'); this.name = 'CapsuleGeneBindingError'; }
}
/**
 * M3-4 强绑定校验: Capsule.gene 必须非空(否则一条无来源基因的经验会污染选择池).
 * 抽成独立 helper 以便 normalizeForPut(校验落库路径)与 ingestUnverified(冻结落库路径,
 * 绕过 normalizeForPut)共用同一条不变量,不让降级路径把绑定校验漏掉.
 */
export function assertCapsuleGeneBinding(asset) {
    if (asset.type !== 'Capsule')
        return;
    const gene = asset.gene;
    if (typeof gene !== 'string' || gene.length === 0)
        throw new CapsuleGeneBindingError();
}
/**
 * 落库前规范化(共享给各 provider): 计算/校验 asset_id + 强绑定校验.
 * - 缺 asset_id → 计算填入(verified=false 表示非入参自带).
 * - 带 asset_id → 必须自洽, 否则抛 AssetIdMismatchError.
 * - Capsule.gene 必须非空(M3-4 强绑定).
 */
export function normalizeForPut(asset) {
    assertCapsuleGeneBinding(asset);
    const actual = computeAssetId(asset);
    if (actual === null)
        throw new Error('computeAssetId 失败: 资产非对象');
    const claimed = typeof asset.asset_id === 'string' && asset.asset_id.length > 0 && asset.asset_id !== 'IGNORED'
        ? asset.asset_id : undefined;
    if (claimed !== undefined && claimed !== actual)
        throw new AssetIdMismatchError(claimed, actual);
    const record = { ...asset, asset_id: actual };
    return { record, verified: claimed !== undefined && verifyAssetId(record) };
}