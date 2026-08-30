import { assetstore, hub } from '@evomap/evolver-core';
type WritableLike = {
    write(chunk: string): unknown;
};
type ContractReason = 'missing_id' | 'cli_unavailable' | 'auth_required' | 'not_found' | 'network_error' | 'unsupported' | 'internal_error' | 'redaction_unavailable' | 'leak_detected' | 'schema_invalid' | 'bundle_required' | 'quality_gate_failed' | 'gene_unproven' | 'insufficient_credits' | 'unsafe_validation_command';
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
    geneRef?: string;
    autoPair?: boolean;
    dryRun?: boolean;
    repair?: boolean;
    noRecipe?: boolean;
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
    quality_evidence?: PublishQualityEvidenceSource;
    validation_command?: 'pass' | 'fail';
}
type PublishQualityEvidenceSource = 'local_history' | 'bundle_seed' | 'none' | 'unavailable';
interface PublishAssetSummary {
    asset_id?: string;
    type?: assetstore.AssetKind;
}
export type PublishBundleResult = {
    ok: true;
    original: assetstore.AssetRecord[];
    sanitized: assetstore.AssetRecord[];
    blockReasons: ContractReason[];
    blockMessages?: Partial<Record<ContractReason, string>>;
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
    validationCapabilityOptional?: boolean;
    fetchAssetById(assetId: string): Promise<assetstore.AssetRecord | null>;
    validate(bundle: readonly assetstore.AssetRecord[]): Promise<HubCallResult>;
    publish(bundle: readonly assetstore.AssetRecord[]): Promise<HubCallResult>;
    composeRecipe?(payload: hub.RecipeComposeInput): Promise<hub.RecipeComposeResult>;
}
interface PrivateContractProxy {
    status(): Promise<unknown>;
    fetchAsset(args: {
        assetId: string;
        expectedHubMode: 'private';
    }): Promise<unknown>;
    validateAssetBundle(bundle: {
        assets: unknown[];
        expected_hub_mode?: 'private';
    }): Promise<unknown>;
    submitAssetBundle(bundle: {
        assets: unknown[];
        expected_hub_mode?: 'private';
        compose_recipe?: boolean;
    }): Promise<unknown>;
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
    callLog?: Pick<hub.AssetCallLog, 'append'>;
    /** Test seam for private-mode proxy discovery. Production resolves the loopback proxy from env/settings. */
    resolveProxyClient?: (env: NodeJS.ProcessEnv) => PrivateContractProxy | undefined;
}
export declare function runReuseCommand(args: readonly string[], deps?: CliContractDeps): Promise<number>;
export declare function runPublishCommand(args: readonly string[], deps?: CliContractDeps): Promise<number>;
export declare function parseReuseArgs(args: readonly string[]): ReuseParseResult;
export declare function parsePublishArgs(args: readonly string[]): PublishParseResult;
export declare function buildPublishBundle(refs: readonly string[], deps?: CliContractDeps): Promise<PublishBundleResult>;
/** Resolve `<asset_id|logical_id|path>` the way publish does. Shared so `asset-repair` speaks the same refs. */
export declare function loadAssetRef(ref: string, deps: CliContractDeps): Promise<assetstore.AssetRecord>;
export declare function hasExplicitValidatePass(body: unknown): boolean;
export declare function _inspectCliContractsForTest(value: unknown): string;
export {};