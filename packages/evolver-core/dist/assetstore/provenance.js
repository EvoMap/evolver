// Provenance trust ledger (#30): genes/capsules fetched from the hub are untrusted — a poisoned asset that
// reaches the selection pool could be reused and spread (experience poisoning). Provenance is a SIDECAR keyed
// by asset_id, NOT a field on the asset: asset_id = sha256(canonicalize(asset)), and "how we got it" metadata
// must not enter the content hash (#30.2), or it would break content-addressing. Trust-first by construction:
// selection defaults to trusted-only; an untrusted asset is promoted to trusted only by an explicit, logged act.
import { join, dirname } from 'node:path';
import { assertCapsuleGeneBinding, FrozenAssetIdCollisionError, InvalidFrozenPutResultError, frozenAssetRecordsEqual, normalizeForPut, supportsAtomicConditionalPut, supportsAtomicFrozenConditionalPut, validateConditionalPutResult, validateFrozenPutResult, } from './provider.js';
import { appendUtf8Durable, assertAssetStoreDirectory, ensureAssetStoreDirectory, readUtf8Regular, regularFileFingerprint, truncateUtf8SuffixDurable, withAssetStoreLock, } from './assetStoreStorage.js';
import { assertTrustSidecarHealthy, parseProvenanceRecord, parseSidecarJsonl, } from './assetSidecarRecords.js';
import { computeAssetId } from '../wire/index.js';
export const UNVERIFIED_V1_IMPORT_REASON = 'unverified_v1_import';
const UNVERIFIED_WRITE_PENDING_REASON = 'unverified_hub_write_pending';
function unverifiedStageAction(current, source, frozenContentId) {
    if (!current)
        return 'append';
    const isUndecidedUntrusted = current.trusted === false
        && current.decision === undefined
        && current.decidedBy === undefined
        && current.promotedBy === undefined;
    if (isActiveUnverifiedProvenance(current, frozenContentId))
        return 'append';
    if (isUndecidedUntrusted && current.source === source && current.reason === undefined)
        return 'append';
    if (isUndecidedUntrusted
        && current.source === source
        && current.reason === UNVERIFIED_WRITE_PENDING_REASON
        && current.frozenContentId === frozenContentId)
        return 'reuse_pending';
    return 'blocked';
}
function unverifiedFinalizeAction(current, source, reason, frozenContentId) {
    if (!current)
        return 'append';
    if (current.trusted === true
        || current.decision !== undefined
        || current.decidedBy !== undefined
        || current.promotedBy !== undefined)
        return 'preserve';
    const sameWaiver = current.source === source && current.trusted === false && current.reason === reason;
    if (sameWaiver && current.frozenContentId === frozenContentId)
        return 'already_bound';
    if (!sameWaiver && (current.reason !== UNVERIFIED_WRITE_PENDING_REASON
        || (current.frozenContentId !== undefined && current.frozenContentId !== frozenContentId)))
        return 'preserve';
    return 'append';
}
/**
 * Resolve the exact no-I/O disposition used by {@link ingestUnverified}. Callers may inspect a read-only
 * target snapshot during migration planning, then apply through ingestUnverified without duplicating its
 * trust and collision rules.
 */
export function planUnverifiedIngest(record, existing, currentProvenance, reason, source = 'hub') {
    assertCapsuleGeneBinding(record);
    const frozenContentId = computeAssetId(record);
    if (!frozenContentId)
        throw new Error('failed to compute frozen content id');
    const base = { assetId: record.asset_id, frozenContentId };
    if (currentProvenance && currentProvenance.assetId !== record.asset_id) {
        return { ...base, status: 'collision', collision: 'provenance', provenanceAction: 'none' };
    }
    if (existing) {
        if (!frozenAssetRecordsEqual(existing, record)) {
            return { ...base, status: 'collision', collision: 'asset', provenanceAction: 'none' };
        }
        const finalize = unverifiedFinalizeAction(currentProvenance, source, reason, frozenContentId);
        if (finalize === 'preserve') {
            return { ...base, status: 'preserve_trust', provenanceAction: 'none' };
        }
        return {
            ...base,
            status: 'already_bound',
            provenanceAction: finalize === 'append' ? 'finalize' : 'none',
        };
    }
    if (unverifiedStageAction(currentProvenance, source, frozenContentId) === 'blocked') {
        return { ...base, status: 'collision', collision: 'provenance', provenanceAction: 'none' };
    }
    return { ...base, status: 'create', provenanceAction: 'stage_and_finalize' };
}
/**
 * A frozen hash mismatch is benign only while its latest provenance record is an undecided, content-bound
 * waiver created by a supported ingest path. Keep the storage/health classification centralized; downstream
 * reuse and sync apply their own stricter allowlists before an unverified asset may leave quarantine.
 */
export function isActiveUnverifiedProvenance(record, frozenContentId) {
    if (!record
        || !frozenContentId
        || record.trusted !== false
        || record.decision !== undefined
        || record.decidedBy !== undefined
        || record.promotedBy !== undefined
        || record.frozenContentId !== frozenContentId)
        return false;
    // V1 input is local legacy data rather than a network-issued identifier. Never let a malformed declared
    // identity become healthy merely because the shallow wire gate does not enforce the schema's asset_id regex.
    if (record.reason === UNVERIFIED_V1_IMPORT_REASON
        && !/^sha256:[0-9a-f]{64}$/.test(record.assetId))
        return false;
    return (record.source === 'hub'
        && (record.reason === 'unverified_hub_rewrite' || record.reason === 'unverified_hub_synthesized')) || (record.source === 'migrated'
        && (record.reason === 'unverified_gepx_import' || record.reason === UNVERIFIED_V1_IMPORT_REASON));
}
export class ProvenanceWritePendingError extends Error {
    assetId;
    code = 'PROVENANCE_WRITE_PENDING';
    constructor(assetId) {
        super('asset provenance write is pending');
        this.assetId = assetId;
        this.name = 'ProvenanceWritePendingError';
    }
}
function immutableRecord(record) {
    return Object.freeze({ ...record });
}
/**
 * Append-only JSONL sidecar (last-write-wins) at <baseDir>/provenance.jsonl. Default for an asset with NO
 * record = trusted: verified local writers (cycleEngine self-produce and self-consistent v1 migration rows)
 * do not write here. Every untrusted or hash-mismatched ingest path MUST mark before persistence.
 */
export class ProvenanceStore {
    now;
    path;
    lockPath;
    index = new Map();
    fileState = null;
    constructor(baseDir, now = Date.now) {
        this.now = now;
        ensureAssetStoreDirectory(baseDir);
        this.path = join(baseDir, 'provenance.jsonl');
        this.lockPath = join(baseDir, '.assetstore.lock');
    }
    rebuildIndex(state) {
        const next = new Map();
        const raw = state === 'missing' ? null : readUtf8Regular(this.path);
        if (raw !== null) {
            const parsed = parseSidecarJsonl(raw, parseProvenanceRecord);
            assertTrustSidecarHealthy('provenance', parsed);
            for (const record of parsed.records)
                next.set(record.assetId, immutableRecord(record));
        }
        this.index.clear();
        for (const [assetId, record] of next)
            this.index.set(assetId, record);
        this.fileState = state;
    }
    refreshUnderLock() {
        const state = regularFileFingerprint(this.path);
        if (state !== this.fileState)
            this.rebuildIndex(state);
    }
    withFreshRead(read) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            return read(this.index);
        });
    }
    appendUnderLock(full) {
        const stored = immutableRecord(full);
        appendUtf8Durable(this.path, `${JSON.stringify(stored)}\n`);
        this.index.set(stored.assetId, stored);
        this.fileState = regularFileFingerprint(this.path);
        return stored;
    }
    /** Record provenance for an asset_id (append-only; the JSONL history is the audit trail). */
    mark(rec) {
        const full = { ...rec, at: rec.at ?? new Date(this.now()).toISOString() };
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            return this.appendUnderLock(full);
        });
    }
    /** Stage a verified Hub write without replacing an in-flight conservative marker. */
    stageUntrustedWriteTracked(assetId, source) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const current = this.index.get(assetId);
            if (current && (current.trusted === true || current.decision !== undefined)) {
                return { record: current, appended: false };
            }
            if (current?.trusted === false) {
                return { record: current, appended: false };
            }
            return {
                record: this.appendUnderLock({
                    assetId,
                    source,
                    trusted: false,
                    at: new Date(this.now()).toISOString(),
                }),
                appended: true,
            };
        });
    }
    /** Finalize a verified write unless an operator made an explicit decision during I/O. */
    finalizeUntrustedWrite(assetId, source) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const current = this.index.get(assetId);
            if (current && (current.trusted === true || current.decision !== undefined))
                return current;
            return this.appendUnderLock({
                assetId,
                source,
                trusted: false,
                at: new Date(this.now()).toISOString(),
            });
        });
    }
    /** Stage an unverified write without overwriting an explicit trust decision or another conservative marker. */
    stageUnverifiedWrite(assetId, source, frozenContentId) {
        return this.stageUnverifiedWriteTracked(assetId, source, frozenContentId).record;
    }
    stageUnverifiedWriteTracked(assetId, source, frozenContentId) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const current = this.index.get(assetId);
            const action = unverifiedStageAction(current, source, frozenContentId);
            if (current && action !== 'append')
                return { record: current, appended: false };
            return {
                record: this.appendUnderLock({
                    assetId,
                    source,
                    trusted: false,
                    reason: UNVERIFIED_WRITE_PENDING_REASON,
                    frozenContentId,
                    at: new Date(this.now()).toISOString(),
                }),
                appended: true,
            };
        });
    }
    /** Atomically replace only a pending/no decision with the health-waiver reason after verified persistence. */
    finalizeUnverifiedWrite(assetId, source, reason, frozenContentId) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const current = this.index.get(assetId);
            const action = unverifiedFinalizeAction(current, source, reason, frozenContentId);
            if (current && action !== 'append')
                return current;
            return this.appendUnderLock({
                assetId,
                source,
                trusted: false,
                reason,
                frozenContentId,
                at: new Date(this.now()).toISOString(),
            });
        });
    }
    rollbackLast(rec) {
        const line = `${JSON.stringify(rec)}\n`;
        try {
            assertAssetStoreDirectory(dirname(this.path));
            withAssetStoreLock(this.lockPath, () => {
                if (!truncateUtf8SuffixDurable(this.path, line)) {
                    this.refreshUnderLock();
                    return;
                }
                this.rebuildIndex(regularFileFingerprint(this.path));
            });
        }
        catch {
            this.index.clear();
            this.fileState = null;
        }
    }
    get(assetId) {
        return this.withFreshRead((index) => index.get(assetId) ?? null);
    }
    /** No record → trusted (local default); a record → its trusted flag. */
    isTrusted(assetId) {
        return this.withFreshRead((index) => index.get(assetId)?.trusted ?? true);
    }
    /** One linearizable trust snapshot for bounded batch readers. */
    snapshot() {
        return this.withFreshRead((index) => new Map(index));
    }
    /** Compare and append one trust decision under the same cross-process lock. */
    changeTrust(assetId, trusted, by, reason) {
        assertAssetStoreDirectory(dirname(this.path));
        return withAssetStoreLock(this.lockPath, () => {
            this.refreshUnderLock();
            const current = this.index.get(assetId) ?? null;
            if (trusted
                && current?.trusted === false
                && current.decision === undefined
                && current.reason === UNVERIFIED_WRITE_PENDING_REASON) {
                throw new ProvenanceWritePendingError(assetId);
            }
            const decision = trusted ? 'promoted' : 'revoked';
            if (current?.trusted === trusted && current.decision === decision) {
                return { changed: false, record: current };
            }
            const full = {
                assetId,
                source: current?.source ?? 'local',
                trusted,
                at: new Date(this.now()).toISOString(),
                decision,
                decidedBy: by,
                ...(trusted ? { promotedBy: by } : {}),
                reason,
            };
            return { changed: true, record: this.appendUnderLock(full) };
        });
    }
    /** Explicit, audited untrusted→trusted promotion. Appends a new trusted record carrying who/why. */
    promote(assetId, by, reason) {
        return this.changeTrust(assetId, true, by, reason).record;
    }
    /** Explicit, audited trusted-to-untrusted revocation. A record-less asset is local by default. */
    revoke(assetId, by, reason) {
        return this.changeTrust(assetId, false, by, reason).record;
    }
}
/**
 * The sanctioned hub→local-pool landing: store the asset (store.put recomputes/normalizes the asset_id, so a
 * remote-supplied asset_id is never trusted) and mark it untrusted in the sidecar. This is the ONLY path that
 * should bring hub-fetched assets into the local pool — trust-first from the first byte (#30.1).
 */
export async function ingestUntrusted(store, prov, record, source = 'hub') {
    const normalized = normalizeForPut(record);
    const mark = prov.mark({ assetId: normalized.record.asset_id, source, trusted: false });
    const result = await store.put(record);
    // A thrown write has an ambiguous outcome: the asset may have reached disk before the acknowledgement was
    // lost. Keep the untrusted marker in that case so a persisted Hub asset can never fall through the default
    // no-record => trusted policy. Only an explicit no-write result is safe to roll back.
    if (!result.stored)
        prov.rollbackLast(mark);
    return result;
}
/**
 * Hub → local-pool landing for an asset whose content does NOT hash to its declared asset_id. The hub
 * demonstrably rewrites delivered payloads (injected `validation`, wholesale `payload_backfill_reason`
 * synthesis — evolver-v2#570), which breaks {@link ingestUntrusted}'s normalizeForPut self-consistency check
 * even though the loop's own in-run reuse already consumes hub content without re-verifying it (adapter
 * `hubReuse.ts`). Rather than hard-reject a save the operator explicitly asked for, freeze the asset under its
 * declared (network) asset_id via `putFrozen` and mark it untrusted in the sidecar with an explicit reason.
 * Trust-first still holds (#30.1): selection defaults to trusted-only, so an unverified asset never silently
 * enters the reasoning pool — it lands where the operator put it and stays flagged until an explicit,
 * audited promotion. `reason` records WHY verification was waived (e.g. hub rewrite vs synthesized payload).
 */
export async function ingestUnverified(store, prov, record, reason, source = 'hub') {
    if (typeof store.putFrozen !== 'function') {
        // Only a content-addressed local pool receives hub reuse writes; a provider that cannot freeze a
        // hash-inconsistent record cannot preserve the network id, so fail loudly rather than silently restamp it.
        throw new Error('ingestUnverified requires a store that implements putFrozen');
    }
    // putFrozen bypasses normalizeForPut, so re-assert the M3-4 Capsule↔gene binding here — a hash-mismatched
    // Capsule with an empty gene must still fail closed on the frozen path, exactly as it does on the verified one.
    assertCapsuleGeneBinding(record);
    const frozenContentId = computeAssetId(record);
    if (!frozenContentId)
        throw new Error('failed to compute frozen content id');
    const existing = await store.get(record.asset_id);
    if (existing) {
        if (!frozenAssetRecordsEqual(existing, record))
            throw new FrozenAssetIdCollisionError(record.asset_id);
        prov.finalizeUnverifiedWrite(record.asset_id, source, reason, frozenContentId);
        return { asset_id: record.asset_id, stored: false, verified: false };
    }
    // Stage a non-waiver record before the body write. If the provider throws or lies about persistence,
    // the asset stays untrusted and health still reports its hash mismatch instead of treating it as #570.
    const staged = prov.stageUnverifiedWrite(record.asset_id, source, frozenContentId);
    // A missing body with an explicit trust decision cannot be replaced without reopening a promotion race.
    if (planUnverifiedIngest(record, null, staged, reason, source).status !== 'create') {
        throw new FrozenAssetIdCollisionError(record.asset_id);
    }
    const result = validateFrozenPutResult(await store.putFrozen(record), record.asset_id);
    const persisted = await store.get(record.asset_id);
    if (!persisted || !frozenAssetRecordsEqual(persisted, record)) {
        throw new FrozenAssetIdCollisionError(record.asset_id);
    }
    prov.finalizeUnverifiedWrite(record.asset_id, source, reason, frozenContentId);
    return result;
}
/** Atomic frozen variant used by reuse so the logical-id check and append share one provider lock. */
export async function ingestUnverifiedConditional(store, prov, record, reason, options, source = 'hub') {
    if (!supportsAtomicFrozenConditionalPut(store)) {
        throw new Error('asset store does not support conditional frozen writes');
    }
    assertCapsuleGeneBinding(record);
    const frozenContentId = computeAssetId(record);
    if (!frozenContentId)
        throw new Error('failed to compute frozen content id');
    const existing = await store.get(record.asset_id);
    if (existing) {
        if (!frozenAssetRecordsEqual(existing, record))
            throw new FrozenAssetIdCollisionError(record.asset_id);
        prov.finalizeUnverifiedWrite(record.asset_id, source, reason, frozenContentId);
        return { asset_id: record.asset_id, stored: false, verified: false, status: 'already_exists' };
    }
    const stage = prov.stageUnverifiedWriteTracked(record.asset_id, source, frozenContentId);
    if (planUnverifiedIngest(record, null, stage.record, reason, source).status !== 'create') {
        throw new FrozenAssetIdCollisionError(record.asset_id);
    }
    const result = validateConditionalPutResult(await store.putFrozenConditional(record, options), record.asset_id, options);
    if (result.verified !== false)
        throw new InvalidFrozenPutResultError();
    if (!result.stored) {
        // The pending row may be shared with a concurrent writer. Keep it until a persisted body is finalized.
        if (result.status === 'already_exists') {
            const persisted = await store.get(record.asset_id);
            if (!persisted || !frozenAssetRecordsEqual(persisted, record)) {
                throw new FrozenAssetIdCollisionError(record.asset_id);
            }
            prov.finalizeUnverifiedWrite(record.asset_id, source, reason, frozenContentId);
        }
        return result;
    }
    const persisted = await store.get(record.asset_id);
    if (!persisted || !frozenAssetRecordsEqual(persisted, record)) {
        throw new FrozenAssetIdCollisionError(record.asset_id);
    }
    prov.finalizeUnverifiedWrite(record.asset_id, source, reason, frozenContentId);
    return result;
}
/**
 * Conditional variant used by Hub sync to reject a logical-id collision without ever allowing a Hub record
 * to become implicitly trusted. Providers that cannot make the condition atomically are rejected here.
 */
export async function ingestUntrustedConditional(store, prov, record, options, source = 'hub') {
    if (!supportsAtomicConditionalPut(store)) {
        throw new Error('asset store does not support conditional writes');
    }
    const normalized = normalizeForPut(record);
    const stage = prov.stageUntrustedWriteTracked(normalized.record.asset_id, source);
    const result = validateConditionalPutResult(await store.putConditional(record, options), normalized.record.asset_id, options);
    if (result.status === 'logical_collision') {
        if (stage.appended)
            prov.rollbackLast(stage.record);
        return result;
    }
    if (!result.stored) {
        const persisted = await store.get(normalized.record.asset_id);
        if (!persisted || !frozenAssetRecordsEqual(persisted, normalized.record)) {
            throw new FrozenAssetIdCollisionError(normalized.record.asset_id);
        }
        if (stage.appended)
            prov.rollbackLast(stage.record);
    }
    if (!stage.appended) {
        prov.finalizeUntrustedWrite(normalized.record.asset_id, source);
    }
    return result;
}