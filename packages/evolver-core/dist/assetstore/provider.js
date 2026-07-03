import { computeAssetId, verifyAssetId } from '../wire/index.js';
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
 * 落库前规范化(共享给各 provider): 计算/校验 asset_id + 强绑定校验.
 * - 缺 asset_id → 计算填入(verified=false 表示非入参自带).
 * - 带 asset_id → 必须自洽, 否则抛 AssetIdMismatchError.
 * - Capsule.gene 必须非空(M3-4 强绑定).
 */
export function normalizeForPut(asset) {
    if (asset.type === 'Capsule') {
        const gene = asset.gene;
        if (typeof gene !== 'string' || gene.length === 0)
            throw new CapsuleGeneBindingError();
    }
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