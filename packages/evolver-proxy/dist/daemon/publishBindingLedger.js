import { hub, wire } from '@evomap/evolver-core';
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
        hub.assertPublishBindingReceipt(bundle, receipt, this.runtimeDigest);
        const key = this.key(receipt.bundleDigest);
        const previous = this.store.getState(key);
        // 一个 bundle 可有多个合法验证根；每个 receipt 单独保存，索引只用于无 sidecar 的同内容重试。
        this.store.setState(`${key}:${receipt.receiptId}`, JSON.stringify(receipt));
        for (const asset of bundle) {
            const member = hub.createPublishMemberBindingReceipt(asset, receipt);
            const memberKey = this.memberKey(member.bundleDigest);
            this.store.setState(`${memberKey}:${member.receiptId}`, JSON.stringify(member));
            if (!this.store.getState(memberKey))
                this.store.setState(memberKey, member.receiptId);
        }
        if (!previous)
            this.store.setState(key, receipt.receiptId);
    }
    verify(bundle, supplied) {
        const required = supplied !== undefined || hub.requiresPublishBinding(bundle);
        if (!required)
            return undefined;
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
            throw new Error('publish_binding_missing');
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
    key(digest) { return `publish-binding:v1:${this.runtimeDigest}:${digest}`; }
    memberKey(digest) { return `publish-binding-member:v1:${this.runtimeDigest}:${digest}`; }
}