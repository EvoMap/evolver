export const RECIPE_COMPOSE_FLAG = 'compose_recipe';
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function assetType(asset) {
    const typed = asset['type'] ?? asset['assetType'];
    return typeof typed === 'string' ? typed : '';
}
function assetId(asset) {
    const id = asset['asset_id'] ?? asset['assetId'];
    return typeof id === 'string' ? id : '';
}
function assetSummary(asset) {
    const summary = asset['summary'] ?? asset['shortTitle'] ?? asset['nlSummary'];
    return typeof summary === 'string' ? summary : '';
}
export function recipeComposeRequested(payload) {
    if (payload[RECIPE_COMPOSE_FLAG] === false)
        return false;
    if (payload['publish_recipe'] === false)
        return false;
    return true;
}
function shouldCompose(payload) {
    return recipeComposeRequested(payload);
}
export function recipeAssetsFromPayload(payload) {
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const records = assets.filter((item) => !!asRecord(item));
    return {
        gene: records.find((asset) => assetType(asset) === 'Gene'),
        capsule: records.find((asset) => assetType(asset) === 'Capsule'),
    };
}
/**
 * After a Gene/Capsule bundle is accepted by Hub, compose a Recipe as the
 * preferred public artifact. Skill Store publish is not the default outbound.
 * Missing recipe capability or missing Gene is a no-op, never a publish failure.
 */
export async function composeRecipeAfterAssetPublish(hub, payload) {
    if (!shouldCompose(payload))
        return { attempted: false, ok: true, reason: 'not_requested' };
    const recipes = hub.recipes;
    if (!recipes)
        return { attempted: false, ok: true, reason: 'recipes_unsupported' };
    const { gene, capsule } = recipeAssetsFromPayload(payload);
    if (!gene)
        return { attempted: false, ok: true, reason: 'gene_missing' };
    const geneId = assetId(gene);
    if (!geneId)
        return { attempted: false, ok: true, reason: 'gene_missing' };
    const title = String(payload.title || assetSummary(gene) || 'Reusable recipe').trim().slice(0, 200);
    if (title.length < 3)
        return { attempted: false, ok: true, reason: 'title_too_short' };
    const description = String(payload.description || assetSummary(gene) || title).trim().slice(0, 2000);
    const steps = [
        { assetId: geneId, assetType: 'Gene', position: 0 },
        ...(capsule && assetId(capsule)
            ? [{ assetId: assetId(capsule), assetType: 'Capsule', position: 1 }]
            : []),
    ];
    try {
        const created = await recipes.create({
            title,
            description,
            steps,
            pricePerExecution: 5,
            currency: 'Credit',
        });
        const recipeId = created.recipeId;
        if (!recipeId)
            return { attempted: true, ok: false, reason: 'recipe_id_missing' };
        const published = await recipes.publish(recipeId);
        return {
            attempted: true,
            ok: true,
            recipeId,
            status: published.status ?? created.status ?? 'published',
        };
    }
    catch (error) {
        return {
            attempted: true,
            ok: false,
            reason: error instanceof Error ? error.message : 'recipe_compose_failed',
        };
    }
}