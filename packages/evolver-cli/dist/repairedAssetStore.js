// Where a repaired asset lands locally. Shared by `asset-repair --apply` and `publish --repair` so a repair
// means the same thing on both paths: LOCAL content (it hashes to its own recomputed id), written alongside the
// original under that id — never over it, and never deleting what it was derived from.
import { assetstore, events } from '@evomap/evolver-core';
export async function storeRepairedAsset(asset, store, env) {
    const baseDir = store instanceof assetstore.LocalJsonlProvider ? store.baseDir : events.assetsDir(env);
    const provenance = new assetstore.ProvenanceStore(baseDir);
    // The repaired record keeps the original's logical id on purpose (it is the same asset, mended), so the
    // logical-collision guard has to be told this collision is expected rather than a conflicting write.
    const result = await assetstore.ingestUntrustedConditional(store, provenance, asset, { allowLogicalCollision: true }, 'local');
    return result.status !== 'logical_collision' && result.stored;
}