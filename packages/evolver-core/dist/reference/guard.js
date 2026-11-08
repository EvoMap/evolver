import { AsyncLocalStorage } from 'node:async_hooks';
const activeScope = new AsyncLocalStorage();
const referenceObjects = new WeakSet();
const scanRawObjects = new WeakSet();
/** Carries scope through promises without a mutable process-wide current store. */
export function withReferenceScope(scope, fn) {
    return scope ? activeScope.run(scope, fn) : fn();
}
/** Connection-local fence for non-persisted remote results. Never evict a known ID into eligibility. */
export class ReferenceSessionScope {
    ids = new Set();
    remember(ids) {
        const next = new Set([...this.ids, ...ids]);
        if (next.size > 4000)
            throw new Error('reference_session_limit: reconnect before fetching more references');
        for (const id of ids)
            this.ids.add(id);
    }
    hasId(id) { return this.ids.has(id); }
}
/** Out-of-band object provenance: no asset fields, JSON or content hashes are changed. */
export function brandReferenceObject(value) {
    referenceObjects.add(value);
    return value;
}
/** A raw scan row is never executable authority, but is distinct from a
 * genuinely reference-only asset. Nested scans must preserve that distinction. */
export function brandScanRawObject(value) {
    scanRawObjects.add(value);
    return value;
}
export function isReferenceObject(value) {
    return !!value && typeof value === 'object' && referenceObjects.has(value);
}
/** Explicit evidence modes never enter procedural paths. Legacy source_type is unrelated. */
export function hasEvidenceMode(value) {
    if (!value || typeof value !== 'object')
        return false;
    if (referenceObjects.has(value) || scanRawObjects.has(value))
        return true;
    if (Array.isArray(value))
        return value.some(hasEvidenceMode);
    const record = value;
    if (Object.prototype.hasOwnProperty.call(record, 'evidence_mode'))
        return true;
    return ['payload', 'asset', 'assets', 'gene', 'capsule', 'results'].some((key) => hasEvidenceMode(record[key]));
}
export function isKnownReferenceId(id, scope = activeScope.getStore()) {
    return typeof id === 'string' && (scope?.hasId(id) ?? false);
}
function isEligible(value, scope, checkEvidence) {
    if (checkEvidence && hasEvidenceMode(value))
        return false;
    if (typeof value === 'string')
        return !isKnownReferenceId(value, scope);
    if (!value || typeof value !== 'object')
        return true;
    if (Array.isArray(value))
        return value.every((item) => isEligible(item, scope, checkEvidence));
    const r = value;
    if (['asset_id', 'assetId', 'id', 'gene', 'gene_id', 'geneId', 'capsule_id', 'capsuleId', 'reused_asset_id', 'selectedAssetId', 'selected_asset_id', 'selectedGeneId', 'selected_gene_id', 'forcedGeneId', 'gene_asset_id', 'capsule_asset_id'].some((key) => isKnownReferenceId(r[key], scope)))
        return false;
    return ['payload', 'asset', 'assets', 'capsule', 'gene', 'hubAsset', 'results', 'used_asset_ids', 'usedAssetIds', 'assetIds', 'genes_used', 'genesUsed', 'geneIds', 'event', 'metadata', 'selection', 'selected_context', 'result', 'execution_binding', 'candidate'].every((key) => isEligible(r[key], scope, checkEvidence));
}
/** Scope-owned IDs only; intrinsic reference provenance is not source ownership or execution approval. */
export function hasScopedReferenceId(value, scope = activeScope.getStore()) {
    return !isEligible(value, scope, false);
}
export function isExecutionEligible(value, scope = activeScope.getStore()) {
    return isEligible(value, scope, true);
}
export function assertExecutionEligible(value, scope = activeScope.getStore()) {
    if (!isExecutionEligible(value, scope))
        throw new Error('reference_or_unsupported_evidence_mode_not_executable');
}