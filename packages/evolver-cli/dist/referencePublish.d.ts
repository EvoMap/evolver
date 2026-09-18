import { assetstore, reference } from '@evomap/evolver-core';
export declare function hasReferenceEvidenceMode(assets: readonly assetstore.AssetRecord[]): boolean;
export declare function validateReferencePublishBundle(assets: readonly assetstore.AssetRecord[]): reference.ReferencePair;
export declare function validReferenceReceipt(body: unknown, assets: readonly assetstore.AssetRecord[], dryRun: boolean): boolean;