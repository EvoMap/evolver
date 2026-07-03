import type { HubCapability, HubQuery } from './capability.js';
import type { AssetStoreProvider } from '../assetstore/provider.js';
import { type ProvenanceStore } from '../assetstore/provenance.js';
export interface HubIngestResult {
    ingested: number;
    assetIds: string[];
}
/**
 * Fetch assets from the hub and land each into the local store as UNTRUSTED. store.put recomputes the
 * asset_id (a remote-supplied id is never trusted) and the provenance sidecar marks each untrusted.
 * mode 'search' uses the hub's recall strategy; 'fetch' (default) is a direct pull.
 */
export declare function ingestFromHub(cap: HubCapability, store: AssetStoreProvider, provenance: ProvenanceStore, query: HubQuery, opts?: {
    mode?: 'fetch' | 'search';
}): Promise<HubIngestResult>;