import { assetstore } from '@evomap/evolver-core';
type WritableLike = {
    write(chunk: string): unknown;
};
type ContractReason = 'missing_id' | 'cli_unavailable' | 'auth_required' | 'not_found' | 'network_error' | 'unsupported' | 'internal_error' | 'redaction_unavailable' | 'leak_detected' | 'schema_invalid' | 'bundle_required' | 'quality_gate_failed' | 'insufficient_credits';
export interface ReuseParseResult {
    ok: boolean;
    assetId?: string;
    jsonOut?: boolean;
    reason?: ContractReason;
    message?: string;
}
export interface PublishParseResult {
    ok: boolean;
    assetRefs?: string[];
    dryRun?: boolean;
    jsonOut?: boolean;
    reason?: ContractReason;
    message?: string;
}
interface GateSummary {
    redaction?: 'pass' | 'fail' | 'unavailable';
    leak?: 'pass' | 'fail';
    schema?: 'pass' | 'fail';
    bundle?: 'pass' | 'fail';
    quality?: 'pass' | 'fail';
}
interface PublishAssetSummary {
    asset_id?: string;
    type?: assetstore.AssetKind;
}
export type PublishBundleResult = {
    ok: true;
    original: assetstore.AssetRecord[];
    sanitized: assetstore.AssetRecord[];
    blockReasons: ContractReason[];
    gates: GateSummary;
    assets: PublishAssetSummary[];
} | {
    ok: false;
    reason: ContractReason;
    message: string;
    gates: GateSummary;
};
interface HubCallResult {
    ok: boolean;
    status: number;
    body?: unknown;
}
interface ContractHubTransport {
    fetchAssetById(assetId: string): Promise<assetstore.AssetRecord | null>;
    validate(bundle: readonly assetstore.AssetRecord[]): Promise<HubCallResult>;
    publish(bundle: readonly assetstore.AssetRecord[]): Promise<HubCallResult>;
}
export interface CliContractDeps {
    out?: WritableLike;
    assetStore?: assetstore.AssetStoreProvider;
    assetsDir?: string;
    env?: NodeJS.ProcessEnv;
    transport?: ContractHubTransport;
    fetchAssetById?: (assetId: string) => Promise<assetstore.AssetRecord | null>;
    validate?: (bundle: readonly assetstore.AssetRecord[]) => Promise<HubCallResult>;
    publish?: (bundle: readonly assetstore.AssetRecord[]) => Promise<HubCallResult>;
}
export declare function runReuseCommand(args: readonly string[], deps?: CliContractDeps): Promise<number>;
export declare function runPublishCommand(args: readonly string[], deps?: CliContractDeps): Promise<number>;
export declare function parseReuseArgs(args: readonly string[]): ReuseParseResult;
export declare function parsePublishArgs(args: readonly string[]): PublishParseResult;
export declare function buildPublishBundle(refs: readonly string[], deps?: CliContractDeps): Promise<PublishBundleResult>;
export declare function hasExplicitValidatePass(body: unknown): boolean;
export declare function _inspectCliContractsForTest(value: unknown): string;
export {};