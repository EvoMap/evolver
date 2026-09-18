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
    verify(bundle: readonly assetstore.AssetRecord[], supplied?: unknown): hub.PublishBindingAuthorization | undefined;
    private key;
    private memberKey;
}
export {};