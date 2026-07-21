import { assetstore, events as ev } from '@evomap/evolver-core';
import { type ObservabilityRelations } from './observabilityRelations.js';
export interface LineagePage<T> {
    items: T[];
    page: number;
    pageSize: number;
    hasMore: boolean;
    truncated: boolean;
}
export interface LineageSource<T> {
    available: boolean;
    data?: T;
    error?: string;
}
export interface AssetLineageRow {
    assetId: string;
    id: string;
    type: assetstore.AssetKind;
    category: string;
    summary: string;
}
interface AssetLineageEvent {
    seq: number;
    ts: string;
    type: string;
    cycleId: string;
    title: string;
    why: string;
    trajectories: ObservabilityRelations['trajectories'];
    pullRequests: ObservabilityRelations['pullRequests'];
}
export interface AssetLineageResponse {
    id: string;
    asset: LineageSource<AssetLineageRow | null>;
    capsules: LineageSource<LineagePage<AssetLineageRow>>;
    events: LineageSource<LineagePage<AssetLineageEvent>>;
    review: LineageSource<{
        state: string;
        at: string;
        by: string;
        reason: string;
    } | null>;
    provenance: LineageSource<{
        source: string;
        trusted: boolean;
        at: string;
        promotedBy: string;
        reason: string;
    } | null>;
    relations: ObservabilityRelations;
}
export interface AssetLineageDeps {
    store?: assetstore.AssetStoreProvider;
    events: () => readonly ev.ReportEvent[] | Promise<readonly ev.ReportEvent[]>;
    review?: assetstore.ReviewLedger;
    provenance?: assetstore.ProvenanceStore;
}
export interface PageInput {
    page?: number;
    pageSize?: number;
}
export interface AssetLineagePageInput extends PageInput {
    capsulePage?: number;
    capsulePageSize?: number;
    eventPage?: number;
    eventPageSize?: number;
}
export declare function listLineageAssets(store: assetstore.AssetStoreProvider | undefined, input: PageInput): Promise<LineageSource<LineagePage<AssetLineageRow>>>;
export declare function loadAssetLineage(deps: AssetLineageDeps, requestedId: string, input: AssetLineagePageInput): Promise<AssetLineageResponse>;
export {};