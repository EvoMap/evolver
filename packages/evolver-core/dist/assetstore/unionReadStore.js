// Read-union over one writable pool plus any number of read-only ones.
//
// Why a provider and not a helper: every evidence consumer already takes an AssetStoreProvider and calls
// `search`/`list` on it — aggregateLearningHistory, assessGenePublishEvidence, candidateAssembly,
// probationWouldPromote. Widening what they can see by threading a second store through each of them
// would fork four call chains and leave the next consumer to remember. Composing at the provider seam
// instead means they are untouched: whoever builds the store decides how wide the evidence pool is.
//
// Writes go to the primary and ONLY the primary. Reads merge, deduplicating by asset_id — records are
// content-addressed, so the same asset present in two pools is the same asset, and primary wins so a
// locally-verified record is never shadowed by a foreign copy.
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { captureRelatedGenes, emptyRelatedSource, relatedQueryAborted, relatedQueryLimits } from './relatedCapsules.js';
import { withSnapshotDeadline } from './boundedSnapshot.js';
import { acquireContextRead, isBuiltInContextReadSource, withContextRead } from './contextRead.js';
import { LocalJsonlProvider } from './localJsonl.js';
import { ForeignJsonlSource } from './foreignJsonlSource.js';
import { brandReferenceObject, brandScanRawObject, hasScopedReferenceId, isExecutionEligible, isReferenceObject } from '../reference/guard.js';
import { getAssetsById } from './provider.js';
import { assertRecentAssetResult, assertRecentLimit, listRecentAssets, MAX_RECENT_ASSETS } from './recentRecords.js';
const DEFAULT_LIMIT = 1000;
const MAX_REFERENCE_IDS = 32000;
const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
const MAX_RAW_ROW_BYTES = 256 * 1024;
const MAX_AUTHORITY_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_MATERIALIZED_SCAN_BYTES = 64 * 1024 * 1024;
/** Inspect an external JSON row before structuredClone can materialize an
 * unbounded object graph. V1 adapters must expose JSON assets, not accessors,
 * cycles or exotic objects. The generous inspection cap accounts for JSON
 * syntax overhead; the exact serialized byte cap is checked after capture. */
function boundedJsonShape(value, limit, strings) {
    let inspected = 0;
    const visited = new Set();
    const visit = (item, depth) => {
        if (++inspected > limit || depth > 64)
            throw new Error('invalid_gene_scan_accounting');
        if (item === null || typeof item === 'boolean')
            return;
        if (typeof item === 'number') {
            if (!Number.isFinite(item))
                throw new Error('invalid_gene_scan_accounting');
            inspected += 24;
            return;
        }
        if (typeof item === 'string') {
            if (item.length > limit - inspected)
                throw new Error('invalid_gene_scan_accounting');
            inspected += Buffer.byteLength(item);
            strings?.add(item);
            return;
        }
        if (typeof item !== 'object' || !item || types.isProxy(item) || visited.has(item))
            throw new Error('invalid_gene_scan_accounting');
        visited.add(item);
        const array = Array.isArray(item);
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null)
            throw new Error('invalid_gene_scan_accounting');
        if (array && item.length > limit - inspected)
            throw new Error('invalid_gene_scan_accounting');
        if (Object.getOwnPropertyDescriptor(item, 'toJSON'))
            throw new Error('invalid_gene_scan_accounting');
        // JSON/clone omit hidden properties, but downstream qualification may read
        // them on the original row. Inspect every own string descriptor first.
        for (const key of Object.getOwnPropertyNames(item)) {
            const property = Object.getOwnPropertyDescriptor(item, key);
            if (!property || !('value' in property))
                throw new Error('invalid_gene_scan_accounting');
            if (array && key === 'length')
                continue;
            // JSON.stringify omits non-index Array properties while structuredClone
            // retains them; allowing that mismatch would evade byte accounting.
            if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))
                throw new Error('invalid_gene_scan_accounting');
            if (key.length > limit - inspected)
                throw new Error('invalid_gene_scan_accounting');
            inspected += Buffer.byteLength(key) + 3;
            if (inspected > limit)
                throw new Error('invalid_gene_scan_accounting');
            visit(property.value, depth + 1);
        }
        if (array)
            for (let index = 0; index < item.length; index++) {
                if (!Object.prototype.hasOwnProperty.call(item, index))
                    throw new Error('invalid_gene_scan_accounting');
            }
    };
    visit(value, 0);
}
function captureRawRow(record, remainingBytes) {
    boundedJsonShape(record, MAX_RAW_ROW_BYTES * 2);
    const copy = structuredClone(record);
    const encoded = JSON.stringify(copy);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_RAW_ROW_BYTES || bytes > remainingBytes || copy.type !== 'Gene'
        || typeof copy.asset_id !== 'string' || !copy.asset_id)
        throw new Error('invalid_gene_scan_accounting');
    if (isReferenceObject(record))
        brandReferenceObject(copy);
    return { copy, bytes };
}
function captureLookupRecord(record, expected, byLogicalId) {
    boundedJsonShape(record, MAX_RAW_ROW_BYTES * 2);
    const copy = structuredClone(record);
    if (Buffer.byteLength(JSON.stringify(copy)) > MAX_RAW_ROW_BYTES
        || typeof copy.asset_id !== 'string' || !copy.asset_id
        || (byLogicalId ? copy.type !== 'Gene' || copy['id'] !== expected : copy.asset_id !== expected))
        throw new Error('invalid_prompt_lookup_result_v1');
    if (isReferenceObject(record))
        brandReferenceObject(copy);
    return copy;
}
function captureRelatedSource(origin, index, position, maxCapsules, maxRecords) {
    // Namespace every origin, including synthetic child failures and repeated
    // labels supplied by an adapter. Hashing keeps nested namespaces bounded and
    // opaque while remaining stable for an unchanged composition.
    const sourceId = typeof origin.sourceId === 'string' && Buffer.byteLength(origin.sourceId) <= 1024
        ? origin.sourceId : '';
    const id = `union:${createHash('sha256').update(JSON.stringify([index, position, sourceId])).digest('hex')}`;
    if (!sourceId || !Array.isArray(origin.genes) || origin.genes.length > 256
        || !Array.isArray(origin.capsules) || !(origin.provenance instanceof Map) || !(origin.review instanceof Map)
        || !['complete', 'truncated', 'unavailable', 'aborted', 'unsupported'].includes(origin.status)
        || !Number.isInteger(origin.scanned) || origin.scanned < origin.genes.length + origin.capsules.length
        || origin.scanned > maxRecords
        || typeof origin.identityComplete !== 'boolean') {
        return emptyRelatedSource(id, 'unavailable');
    }
    let assetBytes = 0, metadataBytes = 0;
    const clone = (asset) => {
        boundedJsonShape(asset, MAX_RAW_ROW_BYTES * 2);
        const copy = structuredClone(asset);
        const bytes = Buffer.byteLength(JSON.stringify(copy));
        assetBytes += bytes;
        if (bytes > MAX_RAW_ROW_BYTES || assetBytes > MAX_MATERIALIZED_SCAN_BYTES)
            throw new Error('invalid_related_source_size');
        if (!isExecutionEligible(asset))
            brandReferenceObject(copy);
        return copy;
    };
    const genes = origin.genes.map(clone), capsules = origin.capsules.slice(0, maxCapsules).map(clone);
    const provenance = new Map();
    const review = new Map();
    const cloneMetadata = (record) => {
        boundedJsonShape(record, MAX_RAW_ROW_BYTES * 2);
        const copy = structuredClone(record);
        const bytes = Buffer.byteLength(JSON.stringify(copy));
        metadataBytes += bytes;
        if (bytes > MAX_RAW_ROW_BYTES || metadataBytes > MAX_AUTHORITY_METADATA_BYTES)
            throw new Error('invalid_related_source_size');
        return copy;
    };
    for (const asset of [...genes, ...capsules]) {
        const trust = origin.provenance.get(asset.asset_id), decision = origin.review.get(asset.asset_id);
        if (trust)
            provenance.set(asset.asset_id, cloneMetadata(trust));
        if (decision)
            review.set(asset.asset_id, cloneMetadata(decision));
    }
    return { sourceId: id, status: origin.capsules.length > maxCapsules && origin.status === 'complete' ? 'truncated' : origin.status,
        scanned: origin.scanned, identityComplete: origin.identityComplete, genes, capsules, provenance, review };
}
function captureReferenceIds(value) {
    if (!Array.isArray(value) || value.length > MAX_REFERENCE_IDS)
        throw new Error('unsupported_reference_snapshot');
    let bytes = 0;
    const result = [];
    for (let index = 0; index < value.length; index++) {
        const property = Object.getOwnPropertyDescriptor(value, index);
        if (!property || !('value' in property))
            throw new Error('unsupported_reference_snapshot');
        const id = property.value;
        if (typeof id !== 'string' || !id || id.length > MAX_REFERENCE_BYTES)
            throw new Error('unsupported_reference_snapshot');
        bytes += Buffer.byteLength(id);
        if (bytes > MAX_REFERENCE_BYTES)
            throw new Error('unsupported_reference_snapshot');
        result.push(id);
    }
    return result;
}
/** A recent window may only reorder records of the captured authority scan, with identical content and eligibility. */
function captureRecentGenes(provided, genes, scope, check) {
    if (types.isProxy(provided) || !Array.isArray(provided) || provided.length > MAX_RECENT_ASSETS)
        throw new Error('invalid_gene_scan_accounting');
    const records = [];
    // Read own data descriptors before any iteration can invoke an adapter's
    // indexed getter/iterator or treat a sparse slot as an authority record.
    for (let index = 0; index < provided.length; index++) {
        check();
        const property = Object.getOwnPropertyDescriptor(provided, index);
        if (!property || !('value' in property))
            throw new Error('invalid_gene_scan_accounting');
        boundedJsonShape(property.value, MAX_RAW_ROW_BYTES * 2);
        records.push(property.value);
    }
    assertRecentAssetResult(records, 'Gene', MAX_RECENT_ASSETS);
    const byId = new Map(genes.map(gene => [gene.asset_id, gene]));
    return records.map(gene => {
        check();
        const captured = byId.get(gene.asset_id);
        if (!captured || !isDeepStrictEqual(captured, gene)
            || isExecutionEligible(captured) !== isExecutionEligible(gene, scope))
            throw new Error('invalid_gene_scan_accounting');
        return captured;
    });
}
/** Capture in the resolving child's turn, before another child or caller can
 * mutate its metadata. Do not retain opaque authority closures across awaits. */
function captureChildSnapshot(snapshot, maxRecords, rawRows, check) {
    check();
    if (!Array.isArray(snapshot.genes) || snapshot.genes.length > maxRecords || snapshot.genes.length > rawRows.size
        || !(snapshot.provenance instanceof Map)
        || !(snapshot.review instanceof Map) || snapshot.provenance.size > 100000 || snapshot.review.size > 100000
        || typeof snapshot.referenceScope?.hasId !== 'function')
        throw new Error('snapshot_record_limit');
    const referenceIds = captureReferenceIds(snapshot.referenceIds);
    const denied = new Set(referenceIds);
    const known = new Set(referenceIds);
    for (const raw of rawRows.values())
        boundedJsonShape(raw, MAX_RAW_ROW_BYTES * 2, known);
    for (const asset of snapshot.genes) {
        boundedJsonShape(asset, MAX_RAW_ROW_BYTES * 2, known);
        const raw = rawRows.get(asset.asset_id);
        if (!raw || !isDeepStrictEqual(raw, asset))
            throw new Error('invalid_gene_scan_accounting');
    }
    const provenance = new Map();
    const review = new Map();
    let metadataBytes = 0;
    const captureMetadata = (record) => {
        boundedJsonShape(record, MAX_RAW_ROW_BYTES * 2, known);
        const copy = structuredClone(record);
        const bytes = Buffer.byteLength(JSON.stringify(copy));
        metadataBytes += bytes;
        if (bytes > MAX_RAW_ROW_BYTES || metadataBytes > MAX_AUTHORITY_METADATA_BYTES)
            throw new Error('invalid_gene_scan_accounting');
        return copy;
    };
    const genes = snapshot.genes.map(asset => {
        check();
        const eligible = isExecutionEligible(asset, snapshot.referenceScope);
        const copy = structuredClone(asset);
        // structuredClone alone would lose WeakSet reference provenance.
        if (!eligible)
            brandReferenceObject(copy);
        const trust = snapshot.provenance.get(copy.asset_id), decision = snapshot.review.get(copy.asset_id);
        if (trust)
            provenance.set(copy.asset_id, captureMetadata(trust));
        if (decision)
            review.set(copy.asset_id, captureMetadata(decision));
        return copy;
    });
    // A scope is an opaque closure. It cannot prove unknown IDs, but it must
    // agree with the complete enumerable deny list on all observed strings,
    // including metadata, within this child's completion turn.
    for (const id of known) {
        check();
        if (snapshot.referenceScope.hasId(id) !== denied.has(id))
            throw new Error('unsupported_reference_snapshot');
    }
    const recentGenes = snapshot.recentGenes === undefined ? undefined
        : captureRecentGenes(snapshot.recentGenes, genes, snapshot.referenceScope, check);
    return { genes, provenance, review, referenceIds, referenceScope: { hasId: id => denied.has(id) },
        ...(recentGenes ? { recentGenes } : {}) };
}
function mergeGeneSnapshots(snapshots, maxRecords, check) {
    const owners = new Map();
    const provenance = new Map();
    const review = new Map();
    const queues = [];
    const denied = new Set();
    let referenceBytes = 0;
    for (const [sourceIndex, snapshot] of snapshots.entries()) {
        for (const id of snapshot.referenceIds) {
            check();
            if (!denied.has(id)) {
                denied.add(id);
                referenceBytes += Buffer.byteLength(id);
            }
            if (denied.size > MAX_REFERENCE_IDS || referenceBytes > MAX_REFERENCE_BYTES)
                throw new Error('unsupported_reference_snapshot');
        }
        const queue = [];
        for (const gene of snapshot.genes) {
            check();
            if (owners.has(gene.asset_id))
                continue;
            owners.set(gene.asset_id, sourceIndex);
            const trust = snapshot.provenance.get(gene.asset_id), decision = snapshot.review.get(gene.asset_id);
            if (trust)
                provenance.set(gene.asset_id, trust);
            if (decision)
                review.set(gene.asset_id, decision);
            queue.push(gene);
        }
        queues.push(queue);
    }
    const referenceScope = { hasId: (id) => denied.has(id) };
    // Complete child unique rows <= cumulative scanned <= the shared maxRecords,
    // so this merge retains all validated authority; no tail key can be missing.
    const genes = interleave(queues, maxRecords);
    const authority = new Map(genes.map(gene => [gene.asset_id, gene]));
    const recentSeen = new Set();
    // A missing child capability keeps the entire composition on legacy order.
    // Each window was captured only after that child's full authority was checked.
    const recentGenes = snapshots.every(snapshot => snapshot.recentGenes !== undefined)
        ? interleave(snapshots.map((snapshot, sourceIndex) => {
            const unique = [];
            for (const gene of snapshot.recentGenes) {
                check();
                // A later source cannot refresh the winning source's identity age.
                if (owners.get(gene.asset_id) !== sourceIndex || recentSeen.has(gene.asset_id))
                    continue;
                recentSeen.add(gene.asset_id);
                unique.push(authority.get(gene.asset_id));
            }
            return unique;
        }), MAX_RECENT_ASSETS) : undefined;
    for (const gene of genes) {
        check();
        if (!isExecutionEligible(gene, referenceScope))
            brandReferenceObject(gene);
    }
    check();
    return { genes, provenance, review, referenceIds: Object.freeze([...denied]), referenceScope,
        ...(recentGenes ? { recentGenes } : {}) };
}
/**
 * Take from the queues one at a time in source order until `limit` is reached.
 *
 * Concatenating instead would let a mature primary fill every slot on its own — at the ~1000-record
 * limits the real callers pass (candidateAssembly, recall, reviewFilter), a local pool that size returns
 * ZERO foreign records and the union silently degrades back to the single-store blind spot it exists to
 * fix. Interleaving also refills: a source that runs out yields its remaining slots to the others, so a
 * small foreign pool never costs the result its cap.
 */
function interleave(queues, limit) {
    const out = [];
    for (let cursor = 0; out.length < limit; cursor += 1) {
        let advanced = false;
        for (const queue of queues) {
            const record = queue[cursor];
            if (record === undefined)
                continue;
            advanced = true;
            out.push(record);
            if (out.length >= limit)
                return out;
        }
        if (!advanced)
            return out;
    }
    return out;
}
// A detached deadline can return before close finishes. If close then fails,
// retain the actual scan by source so the next admission can retry confirmed
// cleanup. The context-read slot stays held until close and in-flight work settle.
const recoverableGeneScans = new WeakMap();
function usesOwnedFileByteAccounting(source, begin) {
    const prototype = Object.getPrototypeOf(source);
    return (prototype === LocalJsonlProvider.prototype
        && begin === LocalJsonlProvider.prototype.beginGeneScanV1)
        || (prototype === ForeignJsonlSource.prototype
            && begin === ForeignJsonlSource.prototype.beginGeneScanV1)
        || (prototype === UnionReadStore.prototype
            && begin === UnionReadStore.prototype.beginGeneScanV1);
}
class UnionGeneScanV1 {
    sources;
    query;
    maxRecords;
    maxBytes;
    epoch = randomUUID();
    controller = new AbortController();
    deadlineAt;
    timer;
    children;
    starting;
    scanned = 0;
    bytes = 0;
    materializedBytes = 0;
    sequence = 0;
    continuation;
    busy = false;
    closing;
    closed = false;
    failed = false;
    complete = false;
    constructor(sources, query, maxRecords, maxBytes) {
        this.sources = sources;
        this.query = query;
        this.maxRecords = maxRecords;
        this.maxBytes = maxBytes;
        if (sources.length > 8 || sources.some(source => !source.beginGeneScanV1))
            throw new Error('unsupported_gene_scan_v1');
        this.deadlineAt = query.deadlineAt ?? Date.now() + 1000;
        if (!Number.isFinite(this.deadlineAt))
            throw new Error('invalid_snapshot_deadline');
        query.signal?.addEventListener('abort', this.abort, { once: true });
        this.schedule();
        if (query.signal?.aborted || Date.now() >= this.deadlineAt)
            this.abort();
    }
    abort = () => { this.controller.abort(); };
    schedule = () => {
        const remaining = this.deadlineAt - Date.now();
        if (remaining <= 0) {
            this.abort();
            return;
        }
        this.timer = setTimeout(this.schedule, Math.min(remaining, 0x7fffffff));
    };
    check = () => {
        if (this.controller.signal.aborted || Date.now() >= this.deadlineAt)
            throw new Error('snapshot_aborted');
    };
    start() {
        if (this.starting)
            return this.starting;
        const children = [];
        this.children = children;
        const starting = (async () => {
            // Let `starting` become visible before a child factory can reenter
            // close(); close must await every session created by this dispatch.
            await Promise.resolve();
            try {
                // Recover every failed, settled predecessor before acquiring any new
                // source slot. A slow recovery must not pin unrelated fresh sources.
                for (const source of this.sources) {
                    this.check();
                    const previous = recoverableGeneScans.get(source);
                    if (previous && previous !== this) {
                        await previous.close();
                        this.check();
                    }
                }
                for (const source of this.sources) {
                    this.check();
                    // Inspect source identity before invoking its factory. A Proxy or
                    // getter may throw during classification; after factory dispatch we
                    // must already have a registered session owner for any such error.
                    const begin = source.beginGeneScanV1;
                    if (typeof begin !== 'function')
                        throw new Error('unsupported_gene_scan_v1');
                    const trustedByteAccounting = usesOwnedFileByteAccounting(source, begin);
                    const release = acquireContextRead(source);
                    // A factory may start work and then throw or return a malformed
                    // session. With no terminal owner to join, keep this child admission
                    // held rather than permitting a second scan to overlap late work.
                    const session = begin.call(source, { ...this.query, signal: this.controller.signal,
                        deadlineAt: this.deadlineAt, maxRecords: this.maxRecords, maxTotalBytes: this.maxBytes });
                    if (!session || typeof session.next !== 'function' || typeof session.close !== 'function')
                        throw new Error('unsupported_gene_scan_v1');
                    children.push({ session, release, seen: new Set(), rows: new Map(), scanned: 0,
                        rawBytes: 0, reportedBytes: 0, complete: false, released: false,
                        trustedByteAccounting });
                    this.check();
                }
                return children;
            }
            catch (error) {
                // A partially created session still owns its child capabilities until
                // their actual close Promises settle. Do not release admission here.
                void this.close().catch(() => undefined);
                throw error;
            }
        })();
        this.starting = starting;
        return starting;
    }
    async next(options) {
        if (this.failed)
            throw new Error('gene_scan_failed');
        if (this.complete)
            throw new Error('gene_scan_complete');
        if (this.busy || this.closing)
            throw new Error('gene_scan_busy');
        if (options.continuation !== this.continuation || !Number.isInteger(options.maxRecords)
            || options.maxRecords < 0 || options.maxRecords > this.maxRecords - this.scanned
            || !Number.isInteger(options.maxBytes) || options.maxBytes < 0 || options.maxBytes > this.maxBytes - this.bytes)
            throw new Error('invalid_gene_scan_continuation');
        this.busy = true;
        try {
            this.check();
            const children = await this.start();
            let rowsLeft = options.maxRecords, bytesLeft = options.maxBytes;
            const rawRows = [];
            let active = children.filter(child => !child.complete);
            let first = true;
            while (active.length && (first || rowsLeft > 0)) {
                this.check();
                first = false;
                const allocation = active.map((_, index) => Math.floor(rowsLeft / active.length)
                    + (index < rowsLeft % active.length ? 1 : 0));
                let completed = false;
                for (const [index, child] of active.entries()) {
                    this.check();
                    const quota = allocation[index];
                    const pending = child.session.next({ maxRecords: quota, maxBytes: bytesLeft,
                        ...(child.continuation === undefined ? {} : { continuation: child.continuation }) });
                    child.inFlight = pending;
                    let page;
                    try {
                        page = await pending;
                    }
                    finally {
                        child.inFlight = undefined;
                    }
                    this.check();
                    if (!page || page.version !== 1 || typeof page.sourceId !== 'string' || !page.sourceId || page.sourceId.length > 256
                        || typeof page.epoch !== 'string' || !page.epoch || page.epoch.length > 256
                        || (child.sourceId !== undefined && child.sourceId !== page.sourceId)
                        || (child.epoch !== undefined && child.epoch !== page.epoch)
                        || !Number.isInteger(page.scanned) || page.scanned < 0 || page.scanned > quota
                        || !Number.isInteger(page.bytes) || page.bytes < 0 || page.bytes > bytesLeft
                        || !Array.isArray(page.rawRows) || page.rawRows.length !== page.scanned
                        || typeof page.complete !== 'boolean'
                        || (page.complete ? page.continuation !== null || !page.snapshot
                            : typeof page.continuation !== 'string' || !page.continuation || page.continuation.length > 256
                                || child.seen.has(page.continuation) || (page.scanned !== quota && page.bytes !== bytesLeft)
                                || page.snapshot !== undefined))
                        throw new Error('invalid_gene_scan_accounting');
                    let rawBytes = 0;
                    for (const record of page.rawRows) {
                        this.check();
                        // Internal JSON readers report actual file bytes. Parsing can
                        // expand a number or synthesize legacy `type`, so their captured
                        // row representation is bounded independently of file I/O. An
                        // external adapter has no such provenance and must account for
                        // every exposed materialized byte in its own page.bytes.
                        const remainingMaterialized = MAX_MATERIALIZED_SCAN_BYTES - this.materializedBytes;
                        const captured = captureRawRow(record, Math.min(remainingMaterialized, child.trustedByteAccounting ? MAX_RAW_ROW_BYTES : this.maxBytes - child.rawBytes - rawBytes));
                        const { copy } = captured;
                        this.materializedBytes += captured.bytes;
                        rawBytes += captured.bytes;
                        const previous = child.rows.get(copy.asset_id);
                        if (previous && (!isDeepStrictEqual(previous, copy)
                            || isReferenceObject(previous) !== isReferenceObject(copy)))
                            throw new Error('conflicting_snapshot_identity');
                        child.rows.set(copy.asset_id, copy);
                        const publicRaw = structuredClone(copy);
                        if (isReferenceObject(copy))
                            brandReferenceObject(publicRaw);
                        rawRows.push(brandScanRawObject(publicRaw));
                    }
                    // A pinned local reader may read ahead in an earlier page. Charge
                    // actual raw content against all bytes reported by this source so
                    // that a later zero-byte page can expose already-read rows, but an
                    // external adapter cannot under-report its total read.
                    if (!child.trustedByteAccounting && child.rawBytes + rawBytes > child.reportedBytes + page.bytes)
                        throw new Error('invalid_gene_scan_accounting');
                    child.rawBytes += rawBytes;
                    child.reportedBytes += page.bytes;
                    child.sourceId = page.sourceId;
                    child.epoch = page.epoch;
                    child.scanned += page.scanned;
                    rowsLeft -= page.scanned;
                    bytesLeft -= page.bytes;
                    this.scanned += page.scanned;
                    this.bytes += page.bytes;
                    if (page.complete) {
                        child.snapshot = captureChildSnapshot(page.snapshot, child.scanned, child.rows, this.check);
                        if (child.snapshot.genes.length > child.scanned)
                            throw new Error('invalid_gene_scan_accounting');
                        const included = new Set(child.snapshot.genes.map(gene => gene.asset_id));
                        for (const gene of child.snapshot.genes) {
                            const raw = child.rows.get(gene.asset_id);
                            if (!raw || !isDeepStrictEqual(raw, gene))
                                throw new Error('invalid_gene_scan_accounting');
                            if (isReferenceObject(raw) && isExecutionEligible(gene, child.snapshot.referenceScope))
                                throw new Error('invalid_gene_scan_accounting');
                        }
                        for (const raw of child.rows.values()) {
                            if (!included.has(raw.asset_id) && isExecutionEligible(raw, child.snapshot.referenceScope))
                                throw new Error('invalid_gene_scan_accounting');
                        }
                        child.complete = true;
                        completed = true;
                    }
                    else {
                        child.continuation = page.continuation;
                        child.seen.add(page.continuation);
                    }
                }
                active = children.filter(child => !child.complete);
                if (!completed)
                    break;
            }
            const complete = children.every(child => child.complete);
            this.continuation = complete ? undefined : `${this.epoch}:${++this.sequence}`;
            this.complete = complete;
            const page = { version: 1, sourceId: `union:${this.epoch}`, epoch: this.epoch,
                scanned: options.maxRecords - rowsLeft, bytes: options.maxBytes - bytesLeft, rawRows: Object.freeze(rawRows), complete,
                continuation: this.continuation ?? null,
                ...(complete ? { snapshot: mergeGeneSnapshots(children.map(child => child.snapshot), this.maxRecords, this.check) } : {}) };
            this.check();
            return page;
        }
        catch (error) {
            // Child sessions cannot roll back a page already consumed before a later
            // source fails. Reusing this continuation would combine two scan epochs.
            this.failed = true;
            void this.close().catch(() => undefined);
            throw error;
        }
        finally {
            this.busy = false;
        }
    }
    close() {
        if (this.closed)
            return Promise.resolve();
        if (this.closing)
            return this.closing;
        this.closing = (async () => {
            this.controller.abort();
            await this.starting?.catch(() => undefined);
            const outcomes = await Promise.allSettled((this.children ?? []).filter(child => !child.released).map(async (child) => {
                // An external adapter may claim close before a submitted read settles.
                // The Union still owns that actual Promise and must not admit a replay.
                const settled = await Promise.allSettled([child.session.close(), child.inFlight]);
                if (settled[0]?.status === 'rejected')
                    throw settled[0].reason;
                child.release();
                child.released = true;
            }));
            if (this.timer)
                clearTimeout(this.timer);
            this.query.signal?.removeEventListener('abort', this.abort);
            const errors = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
            if (errors.length) {
                const retainedSources = new Set((this.children ?? []).flatMap((child, index) => child.released ? [] : [this.sources[index]]));
                for (const source of this.sources) {
                    if (!retainedSources.has(source) && recoverableGeneScans.get(source) === this)
                        recoverableGeneScans.delete(source);
                }
                for (const [index, child] of (this.children ?? []).entries()) {
                    if (!child.released)
                        recoverableGeneScans.set(this.sources[index], this);
                }
                throw Object.assign(new AggregateError(errors, 'gene scan cleanup unconfirmed'), {
                    retryCleanup: () => this.close(),
                });
            }
            for (const source of this.sources)
                if (recoverableGeneScans.get(source) === this)
                    recoverableGeneScans.delete(source);
            this.closed = true;
        })();
        const task = this.closing;
        void task.finally(() => { if (this.closing === task)
            this.closing = undefined; }).catch(() => undefined);
        return task;
    }
}
const unionPromptCapabilities = new WeakMap();
const unionPromptSources = new WeakMap();
export class UnionReadStore {
    primary;
    static isBuiltInPromptReader(value) {
        if (!value || typeof value !== 'object' || !unionPromptSources.has(value))
            return false;
        const union = value;
        try {
            const sources = unionPromptSources.get(union);
            return UnionReadStore.prototype.promptCapabilitiesUnmodified.call(union)
                && sources !== undefined && sources.length > 0 && sources.length <= 8
                && sources.every(isBuiltInContextReadSource);
        }
        catch {
            return false;
        }
    }
    readOnly;
    /** Prompt-time capabilities exist only when every child can prove terminal cancellation. */
    beginPromptGeneSnapshotV1;
    beginPromptRelatedCapsulesV1;
    beginPromptAssetGetV1;
    beginPromptLogicalGeneLookupV1;
    // Mirrored as assigned-in-constructor properties rather than plain methods on purpose: the optional
    // write capabilities are feature-DETECTED by callers (`supportsAtomicConditionalPut`, and
    // `ingestUnverified`'s `putFrozen` probe). A method declared on the class is always present, so a
    // union wrapping a primary that lacks the capability would answer "supported" and then throw — the
    // undeclared-exception failure those probes exist to prevent. Assigning only when the primary has it
    // keeps the union exactly as capable as the pool it writes to.
    putConditional;
    putBundle;
    putBundleWithLocalContextV1;
    readLocalContextsV1;
    putFrozen;
    putFrozenConditional;
    // Conditional for the same reason, on the read side: cliContracts.findLogicalAsset and
    // assetLineage.resolveAsset feature-detect this, and when it is absent fall back to a wide scan that
    // REPORTS truncation. Answering on behalf of a source that cannot resolve logical ids would strand
    // those callers on a narrow answer with no truncation signal — a silent "not found" where they would
    // otherwise have said "lookup is truncated; use an exact asset_id".
    findByLogicalId;
    listRecent;
    /**
     * @param primary the writable pool this engine owns; every mutation lands here
     * @param readOnly additional pools to read, in precedence order after `primary`
     */
    constructor(primary, readOnly) {
        this.primary = primary;
        // A caller may mutate its original array while a Union starts children in
        // a later microtask. Capture the exact source set before any admission.
        this.readOnly = Object.freeze([...readOnly]);
        unionPromptSources.set(this, Object.freeze([...new Set([primary, ...this.readOnly])]));
        const sources = this.sources;
        const recentReaders = new Map();
        if (sources.every(source => {
            const readRecent = source.listRecent;
            recentReaders.set(source, readRecent);
            return Boolean(readRecent);
        })) {
            this.listRecent = (kind, limit = DEFAULT_LIMIT) => {
                assertRecentLimit(limit);
                return this.merged((source) => listRecentAssets(source, kind, limit, recentReaders.get(source)), limit);
            };
        }
        if (sources.length <= 8 && sources.every(source => source.beginPromptGeneSnapshotV1 && source.beginGeneScanV1)) {
            this.beginPromptGeneSnapshotV1 = query => UnionReadStore.prototype.promptGeneSnapshot.call(this, query);
        }
        if (sources.length <= 8 && sources.every(source => source.beginPromptRelatedCapsulesV1)) {
            this.beginPromptRelatedCapsulesV1 = query => UnionReadStore.prototype.promptRelatedCapsules.call(this, query);
        }
        const promptLookup = UnionReadStore.prototype.promptLookupV1.bind(this);
        if (sources.length <= 8 && sources.every(source => source.beginPromptAssetGetV1)) {
            this.beginPromptAssetGetV1 = (assetId, query) => promptLookup(query, (source, signal) => source.beginPromptAssetGetV1(assetId, { ...query, signal }), value => value === null ? null : captureLookupRecord(value, assetId, false), values => values.find(value => value !== null) ?? null);
        }
        if (sources.length <= 8 && sources.every(source => source.beginPromptLogicalGeneLookupV1)) {
            this.beginPromptLogicalGeneLookupV1 = (id, query) => promptLookup(query, (source, signal) => source.beginPromptLogicalGeneLookupV1(id, { ...query, signal }), value => {
                if (!Array.isArray(value) || value.length > 2)
                    throw new Error('invalid_prompt_lookup_result_v1');
                return value.map(record => captureLookupRecord(record, id, true));
            }, values => {
                const seen = new Set(), merged = [];
                for (const value of values)
                    for (const record of value) {
                        if (seen.has(record.asset_id))
                            continue;
                        seen.add(record.asset_id);
                        merged.push(record);
                        if (merged.length === 2)
                            return merged;
                    }
                return merged;
            });
        }
        if ([primary, ...readOnly].every((source) => source.findByLogicalId)) {
            this.findByLogicalId = (id, limit = DEFAULT_LIMIT, kind) => this.merged((source) => source.findByLogicalId(id, limit, kind), limit);
        }
        const { putBundle, putConditional, putFrozen, putFrozenConditional, putBundleWithLocalContextV1, readLocalContextsV1 } = primary;
        if (putBundle)
            this.putBundle = (assets) => putBundle.call(primary, assets);
        if (putBundleWithLocalContextV1)
            this.putBundleWithLocalContextV1 = (assets, context) => putBundleWithLocalContextV1.call(primary, assets, context);
        // Project context belongs to the writable local pool, never a foreign source.
        if (readLocalContextsV1)
            this.readLocalContextsV1 = (ids) => readLocalContextsV1.call(primary, ids);
        if (putConditional)
            this.putConditional = (asset, options) => putConditional.call(primary, asset, options);
        if (putFrozen)
            this.putFrozen = (record) => putFrozen.call(primary, record);
        if (putFrozenConditional) {
            this.putFrozenConditional = (record, options) => putFrozenConditional.call(primary, record, options);
        }
        const capabilities = [this.beginPromptGeneSnapshotV1, this.beginPromptRelatedCapsulesV1,
            this.beginPromptAssetGetV1, this.beginPromptLogicalGeneLookupV1];
        const names = ['beginPromptGeneSnapshotV1', 'beginPromptRelatedCapsulesV1',
            'beginPromptAssetGetV1', 'beginPromptLogicalGeneLookupV1'];
        for (let index = 0; index < names.length; index++) {
            // The optional operations are constructor-owned capabilities. A mutable
            // property would let a caller swap one between product admission and use.
            Object.defineProperty(this, names[index], { value: capabilities[index],
                configurable: false, enumerable: true, writable: false });
        }
        unionPromptCapabilities.set(this, capabilities);
    }
    get sources() {
        // Repeating one provider is not another source. Besides duplicate work, it
        // would conflict with that provider's actual-Promise settlement ownership.
        return [...(unionPromptSources.get(this) ?? [])];
    }
    /** Return the current children for prompt-adapter admission checks. */
    promptSourceTree() {
        return Object.freeze(this.sources);
    }
    /** Reject prompt admission after a caller replaces any constructor-owned V1 operation. */
    promptCapabilitiesUnmodified() {
        const original = unionPromptCapabilities.get(this);
        const sources = unionPromptSources.get(this);
        return Object.getPrototypeOf(this) === UnionReadStore.prototype
            && !Object.prototype.hasOwnProperty.call(this, 'sources')
            && !Object.prototype.hasOwnProperty.call(this, 'promptSourceTree')
            && !Object.prototype.hasOwnProperty.call(this, 'promptCapabilitiesUnmodified')
            && !Object.prototype.hasOwnProperty.call(this, 'beginGeneScanV1')
            && !Object.prototype.hasOwnProperty.call(this, 'promptGeneSnapshot')
            && !Object.prototype.hasOwnProperty.call(this, 'promptRelatedCapsules')
            && !Object.prototype.hasOwnProperty.call(this, 'promptLookupV1')
            && sources !== undefined
            && Object.getOwnPropertyDescriptor(this, 'primary')?.value === sources[0]
            && UnionReadStore.prototype.beginGeneScanV1 === this.beginGeneScanV1
            && original !== undefined
            && ['beginPromptGeneSnapshotV1', 'beginPromptRelatedCapsulesV1',
                'beginPromptAssetGetV1', 'beginPromptLogicalGeneLookupV1'].every((name, index) => {
                const descriptor = Object.getOwnPropertyDescriptor(this, name);
                return descriptor !== undefined && 'value' in descriptor
                    && descriptor.value === original[index]
                    && descriptor.configurable === false && descriptor.writable === false;
            });
    }
    promptLookupV1(query, begin, capture, combine) {
        if (!Number.isFinite(query.deadlineAt) || Date.now() >= query.deadlineAt || query.signal.aborted)
            throw new Error('context_deadline');
        const controller = new AbortController();
        const abort = () => controller.abort();
        query.signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, Math.max(0, Math.min(0x7fffffff, query.deadlineAt - Date.now())));
        const children = [];
        const started = Promise.resolve().then(() => {
            for (const source of this.sources) {
                if (controller.signal.aborted || Date.now() >= query.deadlineAt)
                    throw new Error('context_deadline');
                // The child, as well as this Union, owns admission. A concurrent Union
                // cannot start the same external callback while this one is unsettled.
                const release = acquireContextRead(source);
                const trustedUnion = UnionReadStore.isBuiltInPromptReader(source);
                let operation;
                try {
                    operation = begin(source, controller.signal);
                }
                catch (error) {
                    // A constructor-owned nested Union rejects its admission deadline
                    // before returning an owner or dispatching any child I/O. Unknown
                    // factories may throw after dispatch, so their slot stays held.
                    if (trustedUnion)
                        release();
                    throw error;
                }
                if (!operation || operation.version !== 1 || !operation.result
                    || typeof operation.result.then !== 'function' || typeof operation.cancelAndSettle !== 'function')
                    throw new Error('invalid_prompt_lookup_operation_v1');
                children.push({ operation, release });
            }
        });
        let terminal;
        const settle = () => terminal ??= (async () => {
            await started.catch(() => undefined);
            const outcomes = await Promise.allSettled(children.map(async (child) => {
                await child.operation.cancelAndSettle();
                child.release();
            }));
            const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
            if (failures.length)
                throw new AggregateError(failures, 'prompt lookup cleanup unconfirmed');
        })();
        const result = (async () => {
            let onAbort;
            try {
                await started;
                const cancelled = new Promise((_, reject) => {
                    onAbort = () => { void settle().then(() => reject(new Error('context_deadline')), reject); };
                    controller.signal.addEventListener('abort', onAbort, { once: true });
                    if (controller.signal.aborted)
                        onAbort();
                });
                const values = await Promise.race([Promise.all(children.map(async (child) => capture(await child.operation.result))), cancelled]);
                await settle();
                if (controller.signal.aborted || Date.now() >= query.deadlineAt)
                    throw new Error('context_deadline');
                return combine(values);
            }
            catch (error) {
                try {
                    await settle();
                }
                catch (cleanup) {
                    throw new AggregateError([error, cleanup], 'prompt lookup cleanup unconfirmed');
                }
                throw error;
            }
            finally {
                if (onAbort)
                    controller.signal.removeEventListener('abort', onAbort);
                clearTimeout(timer);
                query.signal.removeEventListener('abort', abort);
            }
        })();
        return { version: 1, result, cancelAndSettle: async () => {
                abort();
                await settle();
                await result.catch(() => undefined);
            } };
    }
    promptGeneSnapshot(query) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (query.signal?.aborted)
            abort();
        else
            query.signal?.addEventListener('abort', abort, { once: true });
        const maxRecords = query.maxRecords ?? 10000;
        const maxBytes = query.maxTotalBytes ?? 8 * 1024 * 1024;
        const scan = this.beginGeneScanV1({ ...query, signal: controller.signal });
        const result = (async () => {
            try {
                const page = await scan.next({ maxRecords, maxBytes });
                if (!page.complete || !page.snapshot)
                    throw new Error(page.scanned >= maxRecords ? 'snapshot_record_limit'
                        : page.bytes >= maxBytes ? 'snapshot_byte_limit' : 'snapshot_record_limit');
                return page.snapshot;
            }
            finally {
                await scan.close();
                query.signal?.removeEventListener('abort', abort);
            }
        })();
        return { version: 1, result, cancelAndSettle: async () => {
                abort();
                // close joins every submitted child next() and its cleanup. A late result
                // cannot escape merely because the prompt caller stopped waiting.
                await scan.close();
                await result.catch(() => undefined);
            } };
    }
    promptRelatedCapsules(query) {
        const genes = captureRelatedGenes(query.genes);
        const boundedQuery = { ...query, genes, deadlineAt: query.deadlineAt ?? Date.now() + 1000 };
        if (!Number.isFinite(boundedQuery.deadlineAt))
            throw new Error('invalid_snapshot_deadline');
        const limits = relatedQueryLimits(boundedQuery);
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (query.signal?.aborted)
            abort();
        else
            query.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, Math.max(0, Math.min(0x7fffffff, boundedQuery.deadlineAt - Date.now())));
        const operations = [];
        const sources = this.sources;
        let terminal;
        const settle = () => terminal ??= (async () => {
            await started.catch(() => undefined);
            const outcomes = await Promise.allSettled(operations.map(async ({ operation, release }) => {
                await operation.cancelAndSettle();
                release();
            }));
            const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
            if (failures.length)
                throw new AggregateError(failures, 'related source cleanup unconfirmed');
        })();
        // Defer factories one microtask so the operation owner is returned before
        // an adapter can start I/O. A failed later factory still joins earlier ones.
        const started = Promise.resolve().then(() => {
            if (controller.signal.aborted || genes.length === 0)
                return;
            for (const source of sources) {
                if (controller.signal.aborted)
                    break;
                const begin = source.beginPromptRelatedCapsulesV1;
                if (typeof begin !== 'function')
                    throw new Error('unsupported_prompt_related_capsules_v1');
                const childGenes = Object.freeze(genes.map(gene => Object.freeze({ ...gene })));
                // A second Union or direct caller must see the same child admission.
                // A malformed factory has no terminal owner, so its slot stays held.
                const release = acquireContextRead(source);
                const operation = begin.call(source, { ...boundedQuery, ...limits, genes: childGenes,
                    signal: controller.signal });
                if (!operation || operation.version !== 1 || typeof operation.cancelAndSettle !== 'function'
                    || !operation.result || typeof operation.result.then !== 'function')
                    throw new Error('invalid_prompt_related_capsules_operation_v1');
                operations.push({ operation, release });
            }
        });
        const result = (async () => {
            try {
                await started;
                if (controller.signal.aborted)
                    throw new Error('snapshot_aborted');
                if (genes.length === 0)
                    return { sources: [] };
                const childResults = Promise.all(operations.map(async ({ operation }, index) => {
                    const id = `union-source-${index}`;
                    try {
                        const value = await operation.result;
                        if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > 64)
                            return [emptyRelatedSource(id, 'unavailable')];
                        return value.sources.map((origin, position) => captureRelatedSource(origin, index, position, limits.maxCapsules, limits.maxRecords));
                    }
                    catch {
                        return [emptyRelatedSource(id, 'unavailable')];
                    }
                }));
                const cancelled = new Promise((_, reject) => {
                    const finish = () => { void settle().then(() => reject(new Error('snapshot_aborted')), reject); };
                    controller.signal.addEventListener('abort', finish, { once: true });
                    if (controller.signal.aborted)
                        finish();
                });
                const values = await Promise.race([childResults, cancelled]);
                await settle();
                if (controller.signal.aborted)
                    throw new Error('snapshot_aborted');
                const merged = values.flat();
                return { sources: merged.length > 64
                        ? [...merged.slice(0, 63), emptyRelatedSource('union-source-overflow', 'truncated')]
                        : merged };
            }
            catch (error) {
                try {
                    await settle();
                }
                catch (cleanup) {
                    throw new AggregateError([error, cleanup], 'related source cleanup unconfirmed');
                }
                throw error;
            }
            finally {
                clearTimeout(timer);
                query.signal?.removeEventListener('abort', abort);
            }
        })();
        return { version: 1, result, cancelAndSettle: async () => {
                abort();
                await started.catch(() => undefined);
                await settle();
            } };
    }
    /**
     * Merge one read across every source: deduplicate by asset_id with earlier sources winning, then fill
     * the result by {@link interleave} so every source gets a fair share of the cap.
     */
    async merged(read, limit) {
        const seen = new Set();
        const queues = [];
        const sources = this.sources;
        const windows = [];
        for (const source of sources)
            windows.push(await read(source));
        const requested = new Set(windows.flatMap(records => records.map(record => record.asset_id)));
        const foreignIds = new Map();
        // Bounded windows cannot prove absence. Generic providers retain exact get;
        // native Foreign reads all kinds once per merge, without retaining unrelated IDs.
        const shadowsRecord = async (source, record) => {
            if (source instanceof UnionReadStore
                && Object.getPrototypeOf(source) === UnionReadStore.prototype
                && source.get === UnionReadStore.prototype.get) {
                for (const child of source.sources)
                    if (await shadowsRecord(child, record))
                        return true;
                return false;
            }
            if (hasScopedReferenceId(record, source.referenceScope))
                return true;
            if (source instanceof ForeignJsonlSource
                && Object.getPrototypeOf(source) === ForeignJsonlSource.prototype
                && source.get === ForeignJsonlSource.prototype.get
                && source.existingAssetIds === ForeignJsonlSource.prototype.existingAssetIds) {
                if (!foreignIds.has(source))
                    foreignIds.set(source, source.existingAssetIds(requested));
                return foreignIds.get(source).has(record.asset_id);
            }
            return await source.get(record.asset_id) !== null;
        };
        for (const [index, records] of windows.entries()) {
            const unique = [];
            for (const record of records) {
                if (seen.has(record.asset_id))
                    continue;
                seen.add(record.asset_id);
                let shadowed = false;
                for (const earlier of sources.slice(0, index)) {
                    if (await shadowsRecord(earlier, record)) {
                        shadowed = true;
                        break;
                    }
                }
                // 窗外或未匹配 query 的 identity 仍属 earlier source；不借 secondary 的位置刷新年龄/信任。
                if (shadowed)
                    continue;
                unique.push(record);
            }
            queues.push(unique);
        }
        return interleave(queues, limit);
    }
    async queryGeneSnapshot(query = {}) {
        const maxRecords = query.maxRecords ?? 10000;
        if (!Number.isInteger(maxRecords) || maxRecords < 0 || maxRecords > 100000)
            throw new Error('invalid_snapshot_budget');
        const maxBytes = query.maxTotalBytes ?? 8 * 1024 * 1024;
        if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024)
            throw new Error('invalid_snapshot_budget');
        const boundedQuery = { ...query, deadlineAt: query.deadlineAt ?? Date.now() + 1000 };
        return withSnapshotDeadline(boundedQuery, async (signal) => {
            const scan = this.beginGeneScanV1({ ...boundedQuery, signal });
            try {
                const page = await scan.next({ maxRecords, maxBytes });
                if (!page.complete || !page.snapshot)
                    throw new Error(page.scanned >= maxRecords ? 'snapshot_record_limit'
                        : page.bytes >= maxBytes ? 'snapshot_byte_limit' : 'snapshot_record_limit');
                return page.snapshot;
            }
            finally {
                await scan.close();
            }
        });
    }
    beginGeneScanV1(query = {}) {
        const maxRecords = query.maxRecords ?? 10000;
        const maxBytes = query.maxTotalBytes ?? 8 * 1024 * 1024;
        if (!Number.isInteger(maxRecords) || maxRecords < 0 || maxRecords > 100000
            || !Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024)
            throw new Error('invalid_snapshot_budget');
        return new UnionGeneScanV1(this.sources, { ...query }, maxRecords, maxBytes);
    }
    async queryRelatedCapsules(query) {
        const input = { ...query };
        const genes = captureRelatedGenes(input.genes);
        const boundedQuery = { ...input, genes, deadlineAt: input.deadlineAt ?? Date.now() + 1000 };
        const limits = relatedQueryLimits(boundedQuery);
        if (genes.length === 0)
            return { sources: [] };
        // Own one absolute default for dispatch and outcome classification. Nested
        // unions inherit it instead of restarting an implicit timer for each child.
        // Start bounded origins together. A slow source cannot prevent a fast one from
        // starting; each deadline/rejection remains an explicit unknown origin, never [].
        const results = await Promise.all(this.sources.slice(0, 8).map(async (source, index) => {
            const id = `union-source-${index}`;
            if (!source.queryRelatedCapsules)
                return [emptyRelatedSource(id, 'unsupported')];
            try {
                return await withSnapshotDeadline(boundedQuery, async (signal) => {
                    // A union deadline only stops its own wait. Retain admission on the
                    // actual child Promise so a new union cannot replay a pending read.
                    // Each child receives a detached immutable view. Neither a child nor
                    // the caller may change another child's requested Gene identity.
                    const childGenes = Object.freeze(genes.map(gene => Object.freeze({ ...gene })));
                    const value = await withContextRead(source, () => source.queryRelatedCapsules({ ...boundedQuery, ...limits, genes: childGenes, signal }));
                    if (relatedQueryAborted({ ...boundedQuery, signal }))
                        throw new Error('snapshot_aborted');
                    if (!Array.isArray(value.sources) || value.sources.length === 0 || value.sources.length > 64)
                        return [emptyRelatedSource(id, 'unavailable')];
                    // Capture in this child's completion turn, not after Promise.all:
                    // another provider must not mutate the first source's authority/data.
                    return value.sources.map((origin, position) => {
                        if (relatedQueryAborted({ ...boundedQuery, signal }))
                            throw new Error('snapshot_aborted');
                        const captured = captureRelatedSource(origin, index, position, limits.maxCapsules, limits.maxRecords);
                        if (relatedQueryAborted({ ...boundedQuery, signal }))
                            throw new Error('snapshot_aborted');
                        return captured;
                    });
                });
            }
            catch {
                return [emptyRelatedSource(id, relatedQueryAborted(boundedQuery) ? 'aborted' : 'unavailable')];
            }
        }));
        const sources = results.flat();
        if (this.sources.length > 8)
            sources.push(emptyRelatedSource('union-source-overflow', 'truncated'));
        // Our output must satisfy the same contract we require of child providers,
        // including another UnionReadStore. Keep the inspected source evidence and
        // disclose the omitted suffix instead of rejecting the whole nested result.
        if (sources.length > 64)
            return { sources: [...sources.slice(0, 63), emptyRelatedSource('union-source-overflow', 'truncated')] };
        return { sources };
    }
    async put(asset) {
        return this.primary.put(asset);
    }
    async get(assetId) {
        for (const source of this.sources) {
            const found = await source.get(assetId);
            if (found)
                return found;
        }
        return null;
    }
    async getMany(assetIds) {
        if (this.get !== UnionReadStore.prototype.get)
            return getAssetsById(this, assetIds, undefined);
        const remaining = new Set(assetIds);
        const records = new Map();
        const deniedBy = (source, record) => {
            if (hasScopedReferenceId(record, source.referenceScope))
                return true;
            return source instanceof UnionReadStore && Object.getPrototypeOf(source) === UnionReadStore.prototype
                && source.get === UnionReadStore.prototype.get
                && source.sources.some(child => deniedBy(child, record));
        };
        for (const [index, source] of this.sources.entries()) {
            if (remaining.size === 0)
                break;
            const found = await getAssetsById(source, [...remaining]);
            for (const id of remaining) {
                const record = found.get(id);
                if (record === undefined)
                    continue;
                if (!this.sources.slice(0, index).some(earlier => deniedBy(earlier, record)))
                    records.set(id, record);
                remaining.delete(id);
            }
        }
        return records;
    }
    async list(kind, limit = DEFAULT_LIMIT) {
        return this.merged((source) => source.list(kind, limit), limit);
    }
    async search(q) {
        return this.merged((source) => source.search(q), q.limit ?? DEFAULT_LIMIT);
    }
}