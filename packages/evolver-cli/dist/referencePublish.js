import { assetstore, hub, reference, wire } from '@evomap/evolver-core';
export function hasReferenceEvidenceMode(assets) {
    return assets.some((asset) => asset.type === 'Capsule' && asset['evidence_mode'] !== undefined);
}
export function validateReferencePublishBundle(assets) {
    if (assets.length !== 2)
        throw new Error('reference_pair_required');
    const pair = reference.decodeReferencePair({
        gene: assets.find((asset) => asset.type === 'Gene'),
        capsule: assets.find((asset) => asset.type === 'Capsule'),
    });
    if (hub.requiresPublishBinding(assets))
        throw new Error('reference_execution_claim_forbidden');
    for (const asset of assets) {
        if (wire.canonicalize(hub.sanitizeAsset(asset)) !== wire.canonicalize(asset)) {
            throw new Error('reference_sanitization_would_change_asset');
        }
    }
    return pair;
}
export function validReferenceReceipt(body, assets, dryRun) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return false;
    const envelope = body;
    const value = envelope['payload'] ?? envelope;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const payload = value;
    const pair = validateReferencePublishBundle(assets);
    const status = dryRun ? 'validated_reference' : 'stored_reference';
    return payload['decision'] === 'accept' && payload['valid'] === true
        && payload['reason'] === status && payload['status'] === status
        && payload['dry_run'] === dryRun && payload['credit_reward'] === 0
        && payload['evidence_mode'] === 'reference_only'
        && Object.keys(reference.REFERENCE_ELIGIBILITY).every((key) => payload[key] === false)
        && payload['gene_asset_id'] === pair.gene.asset_id
        && payload['capsule_asset_id'] === pair.capsule.asset_id
        && payload['asset_id'] === pair.capsule.asset_id
        && payload['bundle_id'] === reference.referenceBundleId(pair);
}