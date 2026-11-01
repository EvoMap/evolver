import { hub, wire } from '@evomap/evolver-core';
/**
 * 本机 parent 发布事实：这份 Gene 确实由本节点提交给 Hub 发布。
 * 这不是宿主执行回执，不授予任何 execution/broadcast 信任等级；
 * 它只用来满足"单独发布的 Capsule 引用已在本节点发布的 Gene"这一条 parent 关系。
 */
const PUBLISHED_PARENT_VERSION = 'publish-published-parent.v1';
const CONTENT_ID = /^sha256:[0-9a-f]{64}$/;
/** 只有"这份 bundle 从未登记过绑定"才允许 parent 规则兜底。 */
const MISSING_BINDING_ERROR = 'publish_binding_missing';
/** parent 发布事实的三种状态。 */
const PARENT_PUBLISHING = 'publishing';
const PARENT_PUBLISHED = 'published';
const PARENT_FAILED = 'failed';
/** 与 durable mailbox 同位；不信任 HTTP 提交的自签名/hash receipt。 */
export class PublishBindingLedger {
    store;
    runtimeDomain;
    runtimeDigest;
    constructor(store, runtimeDomain) {
        this.store = store;
        this.runtimeDomain = runtimeDomain;
        this.runtimeDigest = hub.publishBindingDigest('publish-runtime.v1', runtimeDomain);
    }
    register(receipt, bundle) {
        // 登记时必须看到实际完整内容；只凭 receipt digest 无法推断任何成员授权。
        hub.assertEvolutionEventPublishBundle(bundle);
        hub.assertPublishBindingReceipt(bundle, receipt, this.runtimeDigest);
        const key = this.key(receipt.bundleDigest);
        const previous = this.store.getState(key);
        // 一个 bundle 可有多个合法验证根；每个 receipt 单独保存，索引只用于无 sidecar 的同内容重试。
        this.store.setState(`${key}:${receipt.receiptId}`, JSON.stringify(receipt));
        for (const asset of bundle) {
            // Event 是完整三件包的审计记录，不能独立发送。
            if (asset.type === 'EvolutionEvent')
                continue;
            const member = hub.createPublishMemberBindingReceipt(asset, receipt);
            const memberKey = this.memberKey(member.bundleDigest);
            this.store.setState(`${memberKey}:${member.receiptId}`, JSON.stringify(member));
            if (!this.store.getState(memberKey))
                this.store.setState(memberKey, member.receiptId);
        }
        if (!previous)
            this.store.setState(key, receipt.receiptId);
    }
    /**
     * 记下本节点正在为这份 Gene 提交发布。
     * 单独发布的 Gene 从来不需要 binding，也就不会在 ledger 里登记任何 parent 事实；
     * 没有这条事实，之后单独发布引用它的 Capsule 必然被 publish_binding_missing 拒绝。
     */
    recordPublishingParent(asset) {
        if (asset.type !== 'Gene')
            return;
        for (const reference of this.parentReferences(asset))
            this.writeParent(reference, PARENT_PUBLISHING);
    }
    /**
     * 记下本节点已发布的 Gene，供之后单独发布的 Capsule 证明其 parent 出过本节点。
     * 只记录 Gene 资产，且只登记可解析的引用（逻辑 id / 内容 id）。
     */
    recordPublishedParent(asset, publishedAssetId) {
        if (asset.type !== 'Gene')
            return;
        const references = this.parentReferences(asset);
        // Hub 接受后回填的发布内容 id 与本机计算值可能不同（脱敏会改变内容），
        // 两者都登记，Capsule 用哪个引用都能解析。
        if (publishedAssetId && CONTENT_ID.test(publishedAssetId))
            references.push(publishedAssetId);
        for (const reference of references)
            this.writeParent(reference, PARENT_PUBLISHED);
    }
    /**
     * parent 发布终态失败：这份 parent 不再能授权单独发布的 Capsule。
     * 已经发布成功的事实不会被这条回退。
     */
    recordFailedParent(asset) {
        if (asset.type !== 'Gene')
            return;
        for (const reference of this.parentReferences(asset)) {
            if (this.readParent(reference)?.state === PARENT_PUBLISHED)
                continue;
            this.writeParent(reference, PARENT_FAILED);
        }
    }
    verify(bundle, supplied) {
        hub.assertEvolutionEventPublishBundle(bundle);
        const required = supplied !== undefined || hub.requiresPublishBinding(bundle);
        if (!required)
            return undefined;
        try {
            return this.verifyRegistered(bundle, supplied);
        }
        catch (error) {
            // parent 规则只兜底"这份 bundle 从未登记过绑定"这一种缺失。
            // ledger 损坏、内容不匹配、client 自带 receipt 与 ledger 不一致都照旧拒绝；
            // client 自带 receipt 时也绝不豁免（supplied !== undefined 直接跳过兜底）。
            if (supplied === undefined && error instanceof Error && error.message === MISSING_BINDING_ERROR
                && this.parentBindingSatisfied(bundle)) {
                return undefined;
            }
            throw error;
        }
    }
    /**
     * 该 bundle 是否由 parent 规则授权：只对"引用的 Gene 确实已在本节点发布"放行。
     * 可解析的 parent 关系只有一条：单独发布的 Capsule 引用本机已提交发布的 Gene——
     * ledger 里有对应的本机发布事实，引用必须真的解析到那份 Gene。
     * 它只满足 parent 关系，不构成宿主执行回执。
     */
    authorizesByParentBinding(bundle) {
        if (!hub.requiresPublishBinding(bundle))
            return false;
        return this.parentBindingSatisfied(bundle);
    }
    verifyRegistered(bundle, supplied) {
        const digest = hub.publishBundleDigest(bundle);
        let key = this.key(digest);
        let id = supplied === undefined ? this.store.getState(key) : supplied?.receiptId;
        if (supplied !== undefined && supplied?.version === hub.PUBLISH_MEMBER_BINDING_VERSION) {
            key = this.memberKey(digest);
        }
        else if (supplied === undefined && id === undefined && bundle.length === 1) {
            key = this.memberKey(digest);
            id = this.store.getState(key);
        }
        if (typeof id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(id))
            throw new Error(MISSING_BINDING_ERROR);
        const raw = this.store.getState(`${key}:${id}`);
        if (!raw || raw.length > 4096)
            throw new Error('publish_binding_unregistered');
        let registered;
        try {
            registered = JSON.parse(raw);
        }
        catch {
            throw new Error('publish_binding_ledger_invalid');
        }
        hub.assertPublishBindingAuthorization(bundle, registered, this.runtimeDigest);
        if (registered.version === hub.PUBLISH_MEMBER_BINDING_VERSION) {
            const parentRaw = this.store.getState(`${this.key(registered.parentBundleDigest)}:${registered.parentReceiptId}`);
            if (!parentRaw || parentRaw.length > 4096)
                throw new Error('publish_binding_parent_unregistered');
            let parent;
            try {
                parent = JSON.parse(parentRaw);
            }
            catch {
                throw new Error('publish_binding_ledger_invalid');
            }
            hub.assertPublishBindingReceiptIdentity(parent, this.runtimeDigest);
            if (parent.receiptId !== registered.parentReceiptId || parent.bundleDigest !== registered.parentBundleDigest) {
                throw new Error('publish_binding_parent_unregistered');
            }
        }
        if (supplied !== undefined && wire.canonicalize(supplied) !== wire.canonicalize(registered)) {
            throw new Error('publish_binding_unregistered');
        }
        return registered;
    }
    /**
     * parent 关系是否成立：单独发布的 Capsule 引用的是本节点已经提交发布的 Gene。
     *
     * 只有"这次发布就是这一个 Capsule"才适用：把 Gene 和 Capsule 放进同一个 bundle
     * 仍然要求这个 bundle 自己的回执，否则改名重算 id 的未验证 Capsule 就能借同包 Gene
     * 冒充可广播证据（见 test/publish-binding.ipc.test.ts）。
     */
    parentBindingSatisfied(bundle) {
        // EvolutionEvent 始终要求完整三件包回执，不接受 parent 豁免。
        if (bundle.some((asset) => asset.type === 'EvolutionEvent'))
            return false;
        if (bundle.length !== 1)
            return false;
        const capsule = bundle[0];
        if (capsule.type !== 'Capsule')
            return false;
        const reference = parentReference(capsule);
        if (!reference)
            return false;
        // 先发 Gene：parent 之前已由本节点提交发布（发布中或已发布成功）。
        const state = this.readParent(reference)?.state;
        return state === PARENT_PUBLISHING || state === PARENT_PUBLISHED;
    }
    /** 可被 Capsule 引用的 parent 标识：Gene 的逻辑 id 与本机内容 id。 */
    parentReferences(asset) {
        const references = [];
        const logicalId = typeof asset['id'] === 'string' ? asset['id'].trim() : '';
        if (logicalId)
            references.push(logicalId);
        const contentId = this.contentId(asset);
        if (contentId)
            references.push(contentId);
        return references;
    }
    writeParent(reference, state) {
        // 已经发布成功的事实不被"发布中"或"失败"回退。
        if (state !== PARENT_PUBLISHED && this.readParent(reference)?.state === PARENT_PUBLISHED)
            return;
        const binding = { version: PUBLISHED_PARENT_VERSION, reference, runtimeDigest: this.runtimeDigest, state };
        const receiptId = hub.publishBindingDigest(PUBLISHED_PARENT_VERSION, binding);
        this.store.setState(this.parentKey(reference), JSON.stringify({ ...binding, receiptId }));
    }
    readParent(reference) {
        const raw = this.store.getState(this.parentKey(reference));
        if (!raw || raw.length > 4096)
            return undefined;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return undefined;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const record = parsed;
        if (record['version'] !== PUBLISHED_PARENT_VERSION)
            return undefined;
        if (record['reference'] !== reference)
            return undefined;
        // 本机发布事实只在本 runtime 域内成立，跨域不得复用。
        if (record['runtimeDigest'] !== this.runtimeDigest)
            return undefined;
        if (record['state'] !== PARENT_PUBLISHING && record['state'] !== PARENT_PUBLISHED && record['state'] !== PARENT_FAILED) {
            return undefined;
        }
        if (typeof record['receiptId'] !== 'string')
            return undefined;
        const { receiptId, ...binding } = record;
        if (receiptId !== hub.publishBindingDigest(PUBLISHED_PARENT_VERSION, binding))
            return undefined;
        return record;
    }
    contentId(asset) {
        try {
            const computed = wire.computeAssetId(asset);
            return typeof computed === 'string' && CONTENT_ID.test(computed) ? computed : undefined;
        }
        catch {
            return undefined;
        }
    }
    key(digest) { return `publish-binding:v1:${this.runtimeDigest}:${digest}`; }
    memberKey(digest) { return `publish-binding-member:v1:${this.runtimeDigest}:${digest}`; }
    parentKey(reference) { return `publish-published-parent:v1:${this.runtimeDigest}:${reference}`; }
}
/**
 * Capsule 指向 parent Gene 的引用字段。
 * wire schema 用 `gene`；`gene_id` 只作为等价别名接受。
 * `gene` 存在但为空时不回退到别名——缺 parent 就该被拒。
 */
function parentReference(capsule) {
    const reference = capsule['gene'] ?? capsule['gene_id'];
    return typeof reference === 'string' ? reference.trim() : '';
}