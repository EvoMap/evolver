import { type AssetRecord } from '../assetstore/provider.js';
export declare const PUBLISH_VERIFICATION_VERSION = "publish-verification.v1";
export declare const PUBLISH_BINDING_VERSION = "publish-binding.v1";
export declare const PUBLISH_MEMBER_BINDING_VERSION = "publish-member-binding.v1";
export interface PublishVerificationRequest {
    version: typeof PUBLISH_VERIFICATION_VERSION;
    inputDigest: string;
    validationDigest: string;
    runtimeDigest: string;
    nonce: string;
}
export interface PublishVerificationEvidence {
    request: PublishVerificationRequest;
    rootFingerprint: string;
}
export interface PublishBindingReceipt {
    version: typeof PUBLISH_BINDING_VERSION;
    bundleDigest: string;
    inputDigest: string;
    validationDigest: string;
    runtimeDigest: string;
    rootFingerprint: string;
    executionDigest: string;
    receiptId: string;
}
/** 精确单成员授权；parent 必须存在于同一宿主 ledger，hash 本身不是授权。 */
export interface PublishMemberBindingReceipt {
    version: typeof PUBLISH_MEMBER_BINDING_VERSION;
    bundleDigest: string;
    parentBundleDigest: string;
    parentReceiptId: string;
    runtimeDigest: string;
    receiptId: string;
}
export type PublishBindingAuthorization = PublishBindingReceipt | PublishMemberBindingReceipt;
/** 本地 receipt 属于提交信封，不能参与单资产 hash、sanitize 或 Hub egress。 */
export declare function splitAssetSubmitPayload(payload: unknown): {
    assets: AssetRecord[];
    publishReceipt: unknown;
};
export declare function publishBindingDigest(domain: string, value: unknown): string;
export declare function publishInputDigest(input: Record<string, unknown>): string;
export declare function createPublishVerificationRequest(input: Record<string, unknown>, validation: readonly string[], runtime: string, nonce: string): PublishVerificationRequest;
export declare function isPublishVerificationRequest(value: unknown): value is PublishVerificationRequest;
export declare function isPublishVerificationEvidence(value: unknown): value is PublishVerificationEvidence;
export declare function publishBundleDigest(bundle: readonly AssetRecord[]): string;
export declare function createPublishBindingReceipt(bundle: readonly AssetRecord[], evidence: PublishVerificationEvidence, execution: unknown): PublishBindingReceipt;
export declare function assertPublishBindingReceipt(bundle: readonly AssetRecord[], value: unknown, runtimeDigest?: string): asserts value is PublishBindingReceipt;
export declare function assertPublishBindingReceiptIdentity(value: unknown, runtimeDigest?: string): asserts value is PublishBindingReceipt;
export declare function createPublishMemberBindingReceipt(asset: AssetRecord, parent: PublishBindingReceipt): PublishMemberBindingReceipt;
export declare function assertPublishBindingAuthorization(bundle: readonly AssetRecord[], value: unknown, runtimeDigest?: string): asserts value is PublishBindingAuthorization;
/** 依据执行/广播声明而非可重命名的 id；人工发布不得冒充宿主执行证据。 */
export declare function requiresPublishBinding(bundle: readonly AssetRecord[]): boolean;