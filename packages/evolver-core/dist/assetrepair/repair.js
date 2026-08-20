// Asset repair — turn a GEP record the network refuses into one it accepts, WITHOUT inventing content.
//
// Two producers of refused records exist and both were wasting assets outright:
//   * publish: the Hub rejects a bundle field-by-field (`details[]`), the operator gets a flat error, and the
//     distilled asset is dropped on the floor.
//   * reuse/fetch: the Hub delivers a lossy projection of a published record (dropped `schema_version`, dropped
//     logical `id`, emptied `constraints.forbidden_paths`, extra non-schema keys such as `model_name`), which
//     then fails the local wire gate and is discarded — reported to the operator as "not found".
//
// The line this module refuses to cross: a repair may only restore fields whose value is DERIVABLE (recomputed
// `asset_id`), CONSTANT (`schema_version`), or a strictly-narrowing default (`constraints`). Anything carrying
// an evidence or meaning claim — a Capsule's `outcome`/`confidence`/`blast_radius`, a Gene's `strategy`, a
// human summary — is never fabricated: it is reported as a blocker so the operator (or a re-distill) supplies it.
import { computeAssetId, wireSchemaIssues } from '../wire/index.js';
import { SCHEMA_VERSION } from '@evomap/gep-sdk';
const DEFAULT_MAX_FILES = 12;
const DEFAULT_FORBIDDEN_PATHS = ['.git', 'node_modules'];
const CONTENT_ASSET_ID = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
/**
 * Repair `input` into a record the GEP schema (and, when supplied, the Hub's own rules) accepts.
 * Pure: `input` is never mutated, and nothing is written anywhere — the caller decides what to do with the result.
 */
export function repairAssetRecord(input, options = {}) {
    const hubIssues = options.hubIssues ?? [];
    const before = wireSchemaIssues(input);
    if (before.length === 0 && hubIssues.length === 0 && assetIdIsCurrent(input)) {
        return { status: 'already_valid', asset: input, changes: [], blockers: [] };
    }
    const changes = [];
    const draft = { ...input };
    restoreSchemaVersion(draft, changes);
    dropUnknownProperties(draft, before, changes);
    restoreGeneConstraints(draft, changes);
    restoreLogicalId(draft, changes);
    restoreAssetId(draft, changes);
    const remaining = wireSchemaIssues(draft);
    const blockers = [...remaining.map(schemaBlocker), ...unresolvedHubIssues(hubIssues, changes)];
    if (blockers.length > 0)
        return { status: 'unrepairable', changes, blockers };
    return { status: 'repaired', asset: draft, changes, blockers: [] };
}
/**
 * Hub rules the local schema cannot see (a minimum summary length, a bundle arity) stay blockers — but a hub
 * complaint about a field this pass just mended is answered, and keeping it would report every repairable
 * asset as unrepairable.
 */
function unresolvedHubIssues(issues, changes) {
    return issues.filter((issue) => !changes.some((change) => pathsOverlap(change.path, issue.path)));
}
function pathsOverlap(repaired, reported) {
    return repaired === reported
        || reported.startsWith(`${repaired}.`)
        || repaired.startsWith(`${reported}.`);
}
/** True when the record already declares the id its own content hashes to — the invariant `restoreAssetId` holds. */
function assetIdIsCurrent(record) {
    const declared = record['asset_id'];
    return typeof declared === 'string' && declared === safeComputeAssetId(record);
}
function restoreSchemaVersion(draft, changes) {
    const current = draft['schema_version'];
    if (typeof current === 'string' && SEMVER.test(current))
        return;
    draft['schema_version'] = SCHEMA_VERSION;
    changes.push({
        path: 'schema_version',
        action: current === undefined ? 'added' : 'replaced',
        note: `set to the SDK schema version ${SCHEMA_VERSION}`,
    });
}
// `additionalProperties: false` means an unknown key is fatal, so a delivery that adds `model_name` is
// unusable as-is. Dropping is the only content-preserving move: the key is not part of the GEP contract, so
// nothing that reads the record by contract can miss it. Every dropped key is named in the report.
function dropUnknownProperties(draft, issues, changes) {
    for (const issue of issues) {
        if (issue.keyword !== 'additionalProperties' || !issue.property)
            continue;
        if (!(issue.property in draft))
            continue;
        delete draft[issue.property];
        changes.push({ path: issue.path, action: 'removed', note: 'not declared by the GEP schema' });
    }
}
// A Gene's constraints are a CEILING on what an executing agent may touch. Restoring the default is therefore
// safe in one direction only: the default must be at least as restrictive as a missing/empty value, which
// (no ceiling at all) it always is.
function restoreGeneConstraints(draft, changes) {
    if (draft['type'] !== 'Gene')
        return;
    const current = asRecord(draft['constraints']);
    if (!current) {
        draft['constraints'] = { max_files: DEFAULT_MAX_FILES, forbidden_paths: [...DEFAULT_FORBIDDEN_PATHS] };
        changes.push({ path: 'constraints', action: 'added', note: 'restored the default execution ceiling' });
        return;
    }
    const repaired = { ...current };
    const maxFiles = repaired['max_files'];
    if (typeof maxFiles !== 'number' || !Number.isInteger(maxFiles) || maxFiles < 1) {
        repaired['max_files'] = DEFAULT_MAX_FILES;
        changes.push({ path: 'constraints.max_files', action: maxFiles === undefined ? 'added' : 'replaced', note: `restored the default ceiling ${DEFAULT_MAX_FILES}` });
    }
    const forbidden = repaired['forbidden_paths'];
    const usable = Array.isArray(forbidden) && forbidden.length > 0 && forbidden.every((entry) => typeof entry === 'string');
    if (!usable) {
        repaired['forbidden_paths'] = [...DEFAULT_FORBIDDEN_PATHS];
        changes.push({ path: 'constraints.forbidden_paths', action: forbidden === undefined ? 'added' : 'replaced', note: 'restored the default forbidden paths' });
    }
    draft['constraints'] = repaired;
}
// A logical id names the asset for humans and for Capsule→Gene binding; it carries no claim about the content.
// A delivery that dropped it cannot be re-bound to its original name (that name is not recoverable from the
// bytes), so the derived one is marked `repaired_` — visibly synthetic, and stable for the same content.
function restoreLogicalId(draft, changes) {
    const current = draft['id'];
    if (typeof current === 'string' && current.length > 0)
        return;
    const type = typeof draft['type'] === 'string' ? draft['type'].toLowerCase() : 'asset';
    const digest = safeComputeAssetId(draft)?.slice('sha256:'.length, 'sha256:'.length + 12);
    if (!digest)
        return;
    draft['id'] = `${type}_repaired_${digest}`;
    changes.push({ path: 'id', action: 'added', note: 'derived a stable placeholder id from the content digest' });
}
// Content-addressing means `asset_id` is a FUNCTION of the rest of the record, so it is the one field that must
// be recomputed last — every repair above changes what the content hashes to.
function restoreAssetId(draft, changes) {
    const declared = draft['asset_id'];
    const computed = safeComputeAssetId(draft);
    if (!computed || !CONTENT_ASSET_ID.test(computed))
        return;
    if (declared === computed)
        return;
    draft['asset_id'] = computed;
    changes.push({
        path: 'asset_id',
        action: typeof declared === 'string' ? 'replaced' : 'added',
        note: 'recomputed the content id over the repaired record',
    });
}
function safeComputeAssetId(record) {
    try {
        const id = computeAssetId(record);
        return typeof id === 'string' && id.length > 0 ? id : undefined;
    }
    catch {
        return undefined;
    }
}
function schemaBlocker(issue) {
    return { path: issue.path, keyword: issue.keyword, message: issue.message, source: 'schema' };
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}