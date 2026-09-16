import { assetstore } from '@evomap/evolver-core';
export declare const reviewLedgerForStore: typeof assetstore.reviewLedgerForStore;
export declare const provenanceStoreForStore: typeof assetstore.provenanceStoreForStore;
export declare function listApprovedGenes(store: assetstore.AssetStoreProvider, review: assetstore.ReviewLedger, maxGenes: number, provenance?: assetstore.ProvenanceStore, options?: assetstore.SourceSelectionOptions): Promise<assetstore.AssetRecord[]>;
export declare const pendingReviewRecords: typeof assetstore.pendingReviewRecords;
export declare const pendingGeneReviewRecords: typeof assetstore.pendingGeneReviewRecords;