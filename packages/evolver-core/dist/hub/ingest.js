import { ingestUntrusted } from '../assetstore/provenance.js';
/**
 * Fetch assets from the hub and land each into the local store as UNTRUSTED. store.put recomputes the
 * asset_id (a remote-supplied id is never trusted) and the provenance sidecar marks each untrusted.
 * mode 'search' uses the hub's recall strategy; 'fetch' (default) is a direct pull.
 */
export async function ingestFromHub(cap, store, provenance, query, opts = {}) {
    const records = await (opts.mode === 'search' ? cap.search(query) : cap.fetch(query));
    const assetIds = [];
    for (const rec of records) {
        const r = await ingestUntrusted(store, provenance, rec, 'hub');
        assetIds.push(r.asset_id);
    }
    return { ingested: assetIds.length, assetIds };
}