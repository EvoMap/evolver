import { hub, type assetstore } from '@evomap/evolver-core';
interface StateStore {
    getState(key: string): string | undefined;
    setState(key: string, value: string): void;
}
/** 与 durable mailbox 同位；不信任 HTTP 提交的自签名/hash receipt。 */
export declare class PublishBindingLedger {
    private readonly store;
    readonly runtimeDomain: string;
    readonly runtimeDigest: string;
    constructor(store: StateStore, runtimeDomain: string);
    register(receipt: hub.PublishBindingReceipt, bundle: readonly assetstore.AssetRecord[]): void;
    /**
     * 记下本节点正在为这份 Gene 提交发布。
     * 单独发布的 Gene 从来不需要 binding，也就不会在 ledger 里登记任何 parent 事实；
     * 没有这条事实，之后单独发布引用它的 Capsule 必然被 publish_binding_missing 拒绝。
     */
    recordPublishingParent(asset: assetstore.AssetRecord): void;
    /**
     * 记下本节点已发布的 Gene，供之后单独发布的 Capsule 证明其 parent 出过本节点。
     * 只记录 Gene 资产，且只登记可解析的引用（逻辑 id / 内容 id）。
     */
    recordPublishedParent(asset: assetstore.AssetRecord, publishedAssetId?: string): void;
    /**
     * parent 发布终态失败：这份 parent 不再能授权单独发布的 Capsule。
     * 已经发布成功的事实不会被这条回退。
     */
    recordFailedParent(asset: assetstore.AssetRecord): void;
    verify(bundle: readonly assetstore.AssetRecord[], supplied?: unknown): hub.PublishBindingAuthorization | undefined;
    /**
     * 该 bundle 是否由 parent 规则授权：只对"引用的 Gene 确实已在本节点发布"放行。
     * 可解析的 parent 关系只有一条：单独发布的 Capsule 引用本机已提交发布的 Gene——
     * ledger 里有对应的本机发布事实，引用必须真的解析到那份 Gene。
     * 它只满足 parent 关系，不构成宿主执行回执。
     */
    authorizesByParentBinding(bundle: readonly assetstore.AssetRecord[]): boolean;
    private verifyRegistered;
    /**
     * parent 关系是否成立：单独发布的 Capsule 引用的是本节点已经提交发布的 Gene。
     *
     * 只有"这次发布就是这一个 Capsule"才适用：把 Gene 和 Capsule 放进同一个 bundle
     * 仍然要求这个 bundle 自己的回执，否则改名重算 id 的未验证 Capsule 就能借同包 Gene
     * 冒充可广播证据（见 test/publish-binding.ipc.test.ts）。
     */
    private parentBindingSatisfied;
    /** 可被 Capsule 引用的 parent 标识：Gene 的逻辑 id 与本机内容 id。 */
    private parentReferences;
    private writeParent;
    private readParent;
    private contentId;
    private key;
    private memberKey;
    private parentKey;
}
export {};