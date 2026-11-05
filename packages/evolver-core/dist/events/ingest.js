import { assertExecutionEligible } from '../reference/guard.js';
import { loadReferenceFence } from '../reference/store.js';
import { basename, dirname, join } from 'node:path';
import { EventStore, EventWriteNotCommittedError } from './eventStore.js';
import { createIssueDraftForEventBestEffort } from '../issueReporter/index.js';
import { DEFAULT_CONTEXT_PREPARATION_BUDGET_MS } from './boundedAudit.js';
import { prepareContextDelivery, recoverContextDeliveries, contextDeliveryStatus, snapshotContextDelivery } from '../ops/geneContextDeliveryJournal.js';
import { fitsRootEventLine } from './eventStore.js';
import { readGeneContextDeliveryReceipt } from '../ops/geneContextDelivery.js';
import { protectedAuditConfigured, protectedAuditRpc, protectedAuditRpcSync } from './protectedAuditRpc.js';
import { readRootEventHistoryStrict } from './eventArchive.js';
import { protectedAuditReadSnapshotSync } from './protectedAuditRpc.js';
import { contextDeliveryRpcObserver, startContextReadStage } from '../assetstore/contextReadDiagnostics.js';
const builtInEventStore = EventStore.isBuiltInObservationStore;
const builtInEventClock = EventStore.usesBuiltInClock;
/** 已知事件类型 (军杰 §9; 可 registerEventType 扩展). */
export const EVENT_TYPES = [
    'cycle.started', 'cycle.signals_collected', 'cycle.solidified', 'cycle.failed',
    'cycle.aborted', 'cycle.heartbeat', 'cycle.consumed',
    'cycle.execution_admitted', 'cycle.validation',
    'decision.gene_selected', 'decision.triggered', 'decision.suppressed',
    'personality.selected', 'personality.risk_gated',
    'personality.mutated', 'personality.stats_updated', 'personality.pivoted',
    'signals.extracted', 'mutation.built', 'capsule.produced', 'evolution_event.projected',
    'observer.quarantined', 'observer.dead_letter',
    'actor.human.nudge', 'actor.human.intervene', 'actor.human.teach', 'actor.human.observe',
    'actor.human.review.approve', 'actor.human.review.reject',
    'actor.human.trust.promote', 'actor.human.trust.revoke',
    'actor.human.source.qualify',
    'actor.human.sidecar.recover',
    'gene.distilled', 'gene.distill_shadowed',
    'experience.activity', 'experience.operation.requested', 'experience.source.recovered',
    'anti_gene.distilled', 'anti_gene.distill_shadowed',
    'anti_gene.benchmark_result', 'anti_gene.rollout_result',
    'reflection.recorded',
    'material.batch_ready',
    'value.reuse_hit', 'value.inject', 'value.reuse_outcome', 'value.recall',
    'value.gene_context_delivery', 'value.gene_context_observation',
    'execution.binding.created', 'execution.started', 'execution.decision', 'execution.terminal', 'execution.recovered',
    'execution.reference_access',
    // K_auto EvidenceProjection: coordinate-level partial revocation over (version, claim, scope, runtime,
    // verifier). A revoked event distrusts one (coordinate, value) pair; a reinstated event withdraws it. The
    // authoritative root-event stream is the single source of truth (see algo/kautoProjection.projectRevocations).
    'governance.projection.revoked', 'governance.projection.reinstated',
];
const knownTypes = new Set(EVENT_TYPES);
export function registerEventType(t) { knownTypes.add(t); }
export function isKnownEventType(t) { return knownTypes.has(t); }
export class IngestValidationError extends Error {
    constructor(message) { super(message); this.name = 'IngestValidationError'; }
}
export class UnknownEventTypeError extends Error {
    type;
    constructor(type) {
        super(`未知事件类型: ${type}`);
        this.type = type;
        this.name = 'UnknownEventTypeError';
    }
}
function validateIngest(raw, referenceScope) {
    if (raw.type.startsWith('value.') || ['capsule.produced', 'evolution_event.projected', 'cycle.solidified', 'decision.gene_selected', 'execution.started', 'execution.terminal'].includes(raw.type)) {
        assertExecutionEligible(raw.payload, referenceScope);
    }
    if (!isKnownEventType(raw.type))
        throw new UnknownEventTypeError(raw.type);
    if (!raw.human || typeof raw.human.title !== 'string' || raw.human.title.length === 0)
        throw new IngestValidationError('human.title 必填 (军杰 §9.2)');
    if (raw.type.startsWith('decision.') && !raw.human.why)
        throw new IngestValidationError(`${raw.type}: decision.* 必填 human.why (Why 面板)`);
    if (raw.actor?.kind === 'human' && !raw.actor.id)
        throw new IngestValidationError('actor.kind=human 必带 actor.id (审计, 军杰 §9.7)');
}
const builtInObservationIngestors = new WeakSet();
/** root_events 的全仓唯一写入口 (军杰 §9.2). EventStore 不对外暴露 (见 public.ts). */
export class Ingestor {
    store;
    referenceScope;
    sink;
    /** Product observation admission. A structural V1 callback cannot attest that
     * it stopped after cancellation: only the ordinary built-in writer owns the
     * append, terminal result and durable readback used by automatic recall.
     * This is a composition check, not a JavaScript sandbox for hostile code
     * already running inside the process. */
    static isBuiltInObservationSink(value) {
        try {
            if (!value || typeof value !== 'object' || !builtInObservationIngestors.has(value)
                || Object.getPrototypeOf(value) !== Ingestor.prototype)
                return false;
            const ingestor = value;
            const store = Object.getOwnPropertyDescriptor(ingestor, 'store')?.value;
            if (!store || !builtInEventStore(store) || Object.getPrototypeOf(store) !== EventStore.prototype)
                return false;
            return Object.getOwnPropertyDescriptor(ingestor, 'sink')?.value === undefined
                && Object.getOwnPropertyDescriptor(ingestor, 'path') === undefined
                && Object.getOwnPropertyDescriptor(Ingestor.prototype, 'path')?.get === BUILT_IN_INGEST_PATH
                && ingestor.path === Object.getOwnPropertyDescriptor(store, 'path')?.value
                && Object.getOwnPropertyDescriptor(ingestor, 'beginContextObservationV1') === undefined
                && Object.getOwnPropertyDescriptor(ingestor, 'ingest') === undefined
                && ingestor.beginContextObservationV1 === BUILT_IN_OBSERVATION_BEGIN
                && ingestor.ingest === BUILT_IN_INGEST
                && Object.getOwnPropertyDescriptor(store, 'append') === undefined
                && store.append === BUILT_IN_EVENT_APPEND
                && builtInEventClock(store)
                && Object.getOwnPropertyDescriptor(store, 'lockPath')?.value === `${store.path}.lock`;
        }
        catch {
            return false;
        }
    }
    constructor(opts) {
        this.store = 'store' in opts ? opts.store : new EventStore(opts);
        this.sink = opts.sink;
        const eventDir = dirname(this.store.path);
        this.referenceScope = loadReferenceFence(join(basename(eventDir) === 'evolution' ? dirname(eventDir) : eventDir, 'assets'));
        builtInObservationIngestors.add(this);
    }
    /**
     * Local delivery audit only, with the authority snapshot already loaded by the bounded selection path.
     * No synchronous constructor/reference read, issue reporter, sink, outbox or detached worker. A returned
     * event confirms append+fsync, not host receipt. Throws/skips never claim a durable receipt.
     */
    static async ingestBoundedReceipt(raw, opts) {
        if (raw.type !== 'value.gene_context_delivery')
            throw new IngestValidationError('bounded receipt requires value.gene_context_delivery');
        raw = validatedEvent(raw, opts.referenceScope);
        return EventStore.appendBounded(raw, opts);
    }
    ingestBoundedReceipt(raw, options = {}) {
        return Ingestor.ingestBoundedReceipt(raw, { ...options, path: this.store.path, referenceScope: this.referenceScope });
    }
    static prepareContextDelivery(raw, opts) {
        const deadlineAt = opts.deadlineAt ?? Date.now() + DEFAULT_CONTEXT_PREPARATION_BUDGET_MS;
        const snapshot = validatedPreparation(raw, opts.referenceScope);
        if (protectedAuditConfigured()) {
            const path = opts.path;
            const prepared = protectedAuditRpcSync('prepare_delivery', path, snapshot, { deadlineAt });
            return protectedPreparedDelivery(path, prepared.operationId);
        }
        return prepareContextDelivery(snapshot, opts.path, projector(opts.referenceScope), { ...opts, deadlineAt });
    }
    prepareContextDelivery(raw, options = {}) {
        return Ingestor.prepareContextDelivery(raw, { ...options, path: this.store.path, referenceScope: this.referenceScope });
    }
    /** Async preparation avoids a synchronous RPC child on the bounded product path.
     * The returned confirmation/release capability retains the legacy sync semantics. */
    static async prepareContextDeliveryAsync(raw, opts) {
        const path = opts.path, referenceScope = opts.referenceScope;
        const deadlineAt = opts.deadlineAt ?? Date.now() + DEFAULT_CONTEXT_PREPARATION_BUDGET_MS, signal = opts.signal;
        const snapshot = validatedPreparation(raw, referenceScope);
        if (protectedAuditConfigured()) {
            const observer = contextDeliveryRpcObserver();
            const prepared = await protectedAuditRpc('prepare_delivery', path, snapshot, { deadlineAt, ...(signal ? { signal } : {}), ...(observer ? { observer } : {}) });
            return protectedPreparedDelivery(path, prepared.operationId);
        }
        return prepareContextDelivery(snapshot, path, projector(referenceScope), { deadlineAt, ...(signal ? { signal } : {}) });
    }
    prepareContextDeliveryAsync(raw, options = {}) {
        return Ingestor.prepareContextDeliveryAsync(raw, { ...options, path: this.store.path, referenceScope: this.referenceScope });
    }
    static recoverContextDeliveries(opts) {
        if (protectedAuditConfigured())
            return protectedAuditRpc('recover_deliveries', opts.path, undefined, { deadlineAt: opts.deadlineAt ?? Date.now() + 30_000,
                ...(opts.signal ? { signal: opts.signal } : {}) });
        return recoverContextDeliveries(opts.path, projector(opts.referenceScope), opts);
    }
    recoverContextDeliveries(options = {}) {
        return Ingestor.recoverContextDeliveries({ ...options, path: this.store.path, referenceScope: this.referenceScope });
    }
    static contextDeliveryStatus(path) {
        if (protectedAuditConfigured())
            return protectedAuditRpcSync('delivery_status', path, undefined, { deadlineAt: Date.now() + 30_000 });
        return contextDeliveryStatus(path);
    }
    /**
     * Start one observation with a stable operation identity. The caller may stop admission,
     * but must await the original operation before releasing its owner or replaying it.
     */
    beginContextObservationV1(raw, attempt) {
        if (!attempt.operationId || typeof attempt.operationId !== 'string')
            throw new IngestValidationError('observation_operation_id_required');
        const cancellation = new AbortController();
        const abort = () => cancellation.abort();
        if (attempt.signal.aborted)
            abort();
        else
            attempt.signal.addEventListener('abort', abort, { once: true });
        const result = this.ingest(raw, {
            operationId: attempt.operationId, signal: cancellation.signal,
            ...(attempt.deadlineAt === undefined ? {} : { deadlineAt: attempt.deadlineAt }),
            ...(attempt.expectedPath === undefined ? {} : { expectedPath: attempt.expectedPath }),
            ...(attempt.expectedAlias === undefined ? {} : { expectedAlias: attempt.expectedAlias }),
        }).then(() => ({ operationId: attempt.operationId, outcome: 'committed' }), error => ({ operationId: attempt.operationId,
            outcome: error instanceof EventWriteNotCommittedError && error.operationId === attempt.operationId
                ? 'not_committed' : 'unknown' })).finally(() => attempt.signal.removeEventListener('abort', abort));
        return { version: 1, result, cancelAndSettle: () => { abort(); return result; } };
    }
    /** Diagnostic only: legacy intent has no business identity. Never use this scan to authorize replay. */
    static experienceLegacyAuditStatus(path, limit = 50) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new IngestValidationError('invalid_legacy_status_limit');
        const events = protectedAuditConfigured() ? protectedAuditReadSnapshotSync('root_strict', path) : readRootEventHistoryStrict(path);
        const completed = new Set(events.filter(e => e.payload?.phase === 'committed')
            .map(e => e.payload.operationId));
        return events.filter(e => {
            const p = e.payload;
            return e.type === 'experience.operation.requested' && p?.['source'] === 'experience-library'
                && typeof p['operationId'] === 'string' && p['requestHash'] === undefined && !completed.has(p['operationId']);
        }).slice(0, limit).map(e => {
            const p = e.payload;
            return { operationId: p.operationId, assetId: p.assetId, action: p.action, proof: 'unresolved',
                missingEvidence: 'business_operation_identity' };
        });
    }
    /** Durable experience projection has no external sink replay. The root writer owns exact-once readback. */
    async ingestExperienceAuditV1(raw, operationId, deadlineAt = Date.now() + 30_000, expectedNamespace) {
        raw = validatedEvent(raw, this.referenceScope);
        const p = raw.payload;
        if (p?.['source'] !== 'experience-library' || typeof p['operationId'] !== 'string'
            || !['experience.operation.requested', 'actor.human.teach', 'actor.human.review.approve', 'actor.human.review.reject', 'experience.source.recovered'].includes(raw.type)) {
            throw new IngestValidationError('invalid_experience_audit');
        }
        return this.store.appendExperienceAuditV1(raw, operationId, deadlineAt, expectedNamespace);
    }
    /** No dispatch: callers checkpoint this namespace binding before asking for an idempotent root write. */
    async prepareIdempotent(raw, admission) {
        return this.store.prepareIdempotent(validatedEvent(raw, this.referenceScope), admission);
    }
    /** Durable root audit only. Replay never re-dispatches a sink or issue reporter. */
    async ingestIdempotent(raw, admission) {
        raw = validatedEvent(raw, this.referenceScope);
        return this.store.appendIdempotent(raw, admission);
    }
    async ingest(raw, admission = {}) {
        try {
            raw = validatedEvent(raw, this.referenceScope);
        }
        catch (error) {
            if (admission.operationId)
                throw new EventWriteNotCommittedError(admission.operationId, error);
            throw error;
        }
        const evt = await this.store.append(raw, admission);
        createIssueDraftForEventBestEffort(evt, {
            rootDir: join(dirname(this.store.path), 'issue-reporter'),
            workspaceScope: process.cwd(),
            env: process.env,
        });
        this.sink?.dispatch(evt);
        return evt;
    }
    // 读 passthrough (写只能经 ingest)
    readAll() { return this.store.readAll(); }
    readAllStrict() { return this.store.readAllStrict(); }
    iterate(fromSeq = 0) { return this.store.iterate(fromSeq); }
    tail(n = 1) { return this.store.tail(n); }
    recover() { return this.store.recover(); }
    get path() { return this.store.path; }
}
const BUILT_IN_OBSERVATION_BEGIN = Ingestor.prototype.beginContextObservationV1;
const BUILT_IN_INGEST = Ingestor.prototype.ingest;
const BUILT_IN_INGEST_PATH = Object.getOwnPropertyDescriptor(Ingestor.prototype, 'path').get;
const BUILT_IN_EVENT_APPEND = EventStore.prototype.append;
function validateDelivery(raw, scope) {
    validateIngest(raw, scope);
    const receipt = readGeneContextDeliveryReceipt(raw.payload?.['receipt']);
    if (!receipt)
        throw new IngestValidationError('invalid_delivery_receipt');
    assertExecutionEligible([...receipt.geneAssetIds, ...receipt.capsuleAssetIds,
        ...receipt.sections.flatMap(section => [section.geneAssetId, ...(section.capsuleAssetId ? [section.capsuleAssetId] : [])]),
        ...receipt.qualificationRefs.map(reference => reference.assetId)], scope);
    // Omission IDs describe withheld content, including reference_only assets.
}
function validatedEvent(raw, scope) {
    // Preserve object-provenance fences before JSON detachment removes WeakSet branding.
    validateIngest(raw, scope);
    if (raw.type !== 'value.gene_context_delivery')
        return raw;
    let snapshot;
    try {
        snapshot = JSON.parse(JSON.stringify(raw));
    }
    catch {
        throw new IngestValidationError('invalid_delivery_receipt');
    }
    if (snapshot?.type !== 'value.gene_context_delivery')
        throw new IngestValidationError('invalid_delivery_receipt');
    // All delivery writers validate detached JSON data before their first await.
    // Preserve valid legacy event metadata; the durable outbox applies its narrower whitelist separately.
    validateDelivery(snapshot, scope);
    return snapshot;
}
function validatedPreparation(raw, scope) {
    const finish = startContextReadStage('delivery_validate');
    try {
        const snapshot = snapshotContextDelivery(validatedEvent(raw, scope), '00000000-0000-0000-0000-000000000000');
        validateDelivery(snapshot, scope);
        if (!fitsRootEventLine(snapshot))
            throw new IngestValidationError('delivery_receipt_too_large');
        finish?.('fulfilled');
        return snapshot;
    }
    catch (error) {
        finish?.('rejected');
        throw error;
    }
}
function protectedPreparedDelivery(path, id) {
    return Object.freeze({ operationId: id,
        confirmOutput() {
            protectedAuditRpcSync('confirm_delivery_output', path, id, { deadlineAt: Date.now() + 30_000 });
        },
        outputUnknown() {
            protectedAuditRpcSync('unknown_delivery_output', path, id, { deadlineAt: Date.now() + 30_000 });
        },
        project(options = {}) {
            return protectedAuditRpc('project_delivery', path, id, { deadlineAt: options.deadlineAt ?? Date.now() + 30_000,
                ...(options.signal ? { signal: options.signal } : {}) });
        },
        release() {
            protectedAuditRpcSync('release_delivery', path, id, { deadlineAt: Date.now() + 30_000 });
        },
    });
}
function projector(scope) {
    return (path, authority, options) => {
        // Recovery revalidates the historical receipt against the current local reference fence.
        // It records past output only; no selection, execution grant or external sink is invoked.
        // Read and classify persisted metadata under the same root lock as projection.
        return EventStore.projectContextDelivery(authority, { ...options, path }, raw => validateDelivery(raw, scope));
    };
}