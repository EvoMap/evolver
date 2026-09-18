import { assetstore } from '@evomap/evolver-core';
import { type ProxyAssetBundle, type ProxyAssetReverification, type ProxyReverificationRecovery } from '@evomap/evolver-mcp';
export interface LocalPublishVerifierClient {
    authorizeAssetPublication(input: ProxyAssetBundle, opts?: {
        signal?: AbortSignal;
    }): Promise<unknown>;
    reverifyAssets(input: ProxyAssetReverification, opts?: {
        signal?: AbortSignal;
    }): Promise<unknown>;
}
export type LocalPublishVerifierResolver = (env: NodeJS.ProcessEnv) => Partial<LocalPublishVerifierClient> | undefined;
export declare class LocalPublishBindingError extends Error {
    readonly reason: string;
    readonly recovery?: ProxyReverificationRecovery;
    constructor(reason: string, recovery?: ProxyReverificationRecovery);
}
/** 只消费本机 ledger 的判定；不把客户端 hash、外部 receipt 或未验证的历史声明当作授权。 */
export declare function withLocalPublishBinding<T>(bundle: readonly assetstore.AssetRecord[], env: NodeJS.ProcessEnv, publish: (assets: assetstore.AssetRecord[]) => Promise<T>, resolveProxy?: LocalPublishVerifierResolver): Promise<T>;
export interface ReverifiedPublishBundle {
    assets: assetstore.AssetRecord[];
    sourceAssetIds: string[];
    stored: boolean;
}
/** 显式迁移产生新记录；原始资产和历史 trace 不原地更新，也不自动广播。 */
export declare function reverifyPublishBundle(bundle: readonly assetstore.AssetRecord[], env: NodeJS.ProcessEnv, resolveProxy?: LocalPublishVerifierResolver): Promise<ReverifiedPublishBundle>;