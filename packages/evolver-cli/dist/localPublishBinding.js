import { assetstore, hub, wire } from '@evomap/evolver-core';
import { proxyClientFromEnv, ProxyReverificationError, safeReverificationRecovery, } from '@evomap/evolver-mcp';
export class LocalPublishBindingError extends Error {
    reason;
    recovery;
    constructor(reason, recovery) {
        super(recovery
            ? `${reason}: 请先检查 source_asset_ids、asset_ids 对应的本机资产与 ledger；状态不明确时勿盲目重新执行 --reverify，不回滚已保存资产或撤销合法回执`
            : reason === 'publish_reverification_unavailable'
                ? `${reason}: 当前本机没有可用的隔离验证器；需配置受支持的 native verifier，不支持的平台保持 draft-only`
                : `${reason}: 请通过当前本机宿主重新验证；使用 evolver publish --gene <id|path> --capsule <id|path> --reverify --json`);
        this.reason = reason;
        if (recovery)
            this.recovery = safeReverificationRecovery(recovery);
    }
}
function safeFailureReason(error, fallback, operation = 'reverification') {
    if (error instanceof Error) {
        if (/^publish_(?:binding|reverification)_[a-z_]{1,70}$/.test(error.message))
            return error.message;
        if (error.message === 'proxy_hub_mode_mismatch')
            return 'publish_binding_hub_mode_mismatch';
        if (error.name === 'TimeoutError')
            return `publish_${operation}_timeout`;
        if (error.name === 'AbortError')
            return `publish_${operation}_aborted`;
    }
    return fallback;
}
function mode(env) {
    const value = (env['EVOMAP_HUB_MODE'] ?? 'public').trim().toLowerCase();
    if (value !== 'public' && value !== 'private')
        throw new LocalPublishBindingError('publish_binding_hub_mode_invalid');
    return value;
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value : {};
}
function snapshot(bundle) {
    return structuredClone(bundle).map((asset) => assetstore.normalizeForPut(asset).record);
}
/** 只消费本机 ledger 的判定；不把客户端 hash、外部 receipt 或未验证的历史声明当作授权。 */
export async function withLocalPublishBinding(bundle, env, publish, resolveProxy = proxyClientFromEnv) {
    const assets = snapshot(bundle);
    if (!hub.requiresPublishBinding(assets))
        return publish(assets);
    const expectedHubMode = mode(env);
    await authorizeSnapshot(assets, expectedHubMode, resolveProxy(env));
    return publish(assets);
}
async function authorizeSnapshot(assets, expectedHubMode, proxy) {
    if (!proxy?.authorizeAssetPublication)
        throw new LocalPublishBindingError('publish_verification_required');
    const digest = hub.publishBundleDigest(assets);
    // 授权 callback 只能持有独立副本；即使其在返回后修改请求，也不能污染 publisher 私有数据。
    const requestAssets = structuredClone(assets);
    const requestDigest = hub.publishBundleDigest(requestAssets);
    let response;
    try {
        response = record(await proxy.authorizeAssetPublication({
            assets: requestAssets, expected_hub_mode: expectedHubMode,
        }, { signal: AbortSignal.timeout(30_000) }));
    }
    catch (error) {
        throw new LocalPublishBindingError(safeFailureReason(error, 'publish_binding_authorization_unavailable', 'binding_authorization'));
    }
    if (response['ok'] !== true || response['binding_verified'] !== true || response['bundle_digest'] !== digest
        || requestDigest !== digest || hub.publishBundleDigest(requestAssets) !== requestDigest
        || hub.publishBundleDigest(assets) !== digest) {
        throw new LocalPublishBindingError('publish_binding_authorization_invalid');
    }
}
/** 显式迁移产生新记录；原始资产和历史 trace 不原地更新，也不自动广播。 */
export async function reverifyPublishBundle(bundle, env, resolveProxy = proxyClientFromEnv) {
    if (bundle.length !== 2)
        throw new LocalPublishBindingError('publish_reverification_pair_required');
    let assets;
    try {
        assets = structuredClone(bundle).map(hub.normalizePublishReverificationSource);
    }
    catch (error) {
        throw new LocalPublishBindingError(safeFailureReason(error, 'publish_reverification_invalid_wire'));
    }
    if (assets.length !== 2 || assets.filter((asset) => asset.type === 'Gene').length !== 1
        || assets.filter((asset) => asset.type === 'Capsule').length !== 1) {
        throw new LocalPublishBindingError('publish_reverification_pair_required');
    }
    const expectedHubMode = mode(env);
    const proxy = resolveProxy(env);
    if (!proxy?.reverifyAssets)
        throw new LocalPublishBindingError('publish_reverification_unavailable');
    const sourceIds = assets.map((asset) => asset.asset_id).sort();
    let response;
    try {
        response = record(await proxy.reverifyAssets({
            assets, persist: true, expected_hub_mode: expectedHubMode,
        }, { signal: AbortSignal.timeout(30_000) }));
    }
    catch (error) {
        throw new LocalPublishBindingError(safeFailureReason(error, 'publish_reverification_failed'), safeReverificationRecovery({
            ...(error instanceof ProxyReverificationError ? error.recovery : {}), source_asset_ids: sourceIds,
        }));
    }
    const recovery = safeReverificationRecovery({
        ...response, source_asset_ids: sourceIds,
        asset_ids: Array.isArray(response['assets']) ? response['assets'].slice(0, 2).map((asset) => record(asset)['asset_id']) : [],
    });
    const returnedSourceIds = response['source_asset_ids'];
    if (response['ok'] !== true || response['status'] !== 'reverified' || response['publishable'] !== true
        || response['queued'] !== false || response['stored'] !== true
        || !Array.isArray(response['assets']) || response['assets'].length !== 2
        || !Array.isArray(returnedSourceIds) || returnedSourceIds.length !== sourceIds.length
        || returnedSourceIds.some((id) => typeof id !== 'string')
        || JSON.stringify([...returnedSourceIds].sort()) !== JSON.stringify(sourceIds)) {
        throw new LocalPublishBindingError('publish_reverification_invalid_response', recovery);
    }
    let verified;
    try {
        verified = snapshot(response['assets']);
        if (verified.filter((asset) => asset.type === 'Gene').length !== 1
            || verified.filter((asset) => asset.type === 'Capsule').length !== 1
            || verified.some((asset) => !wire.validateWireDeep(asset.type === 'Gene' ? wire.stripGeneHints(asset) : asset).ok)) {
            throw new Error('publish_reverification_invalid_assets');
        }
        hub.assertPublishBindingReceipt(verified, response['publish_receipt']);
    }
    catch (error) {
        throw new LocalPublishBindingError(safeFailureReason(error, 'publish_reverification_invalid_assets'), recovery);
    }
    // 显式重新验证无条件读取同一 host ledger，不借用普通人工发布的“无需绑定”早退。
    try {
        await authorizeSnapshot(verified, expectedHubMode, proxy);
    }
    catch (error) {
        throw new LocalPublishBindingError(error instanceof LocalPublishBindingError ? error.reason : 'publish_binding_authorization_unavailable', recovery);
    }
    return { assets: verified, sourceAssetIds: sourceIds, stored: true };
}