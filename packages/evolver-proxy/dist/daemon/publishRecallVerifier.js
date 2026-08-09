import { assetstore, mailbox, wire } from '@evomap/evolver-core';
const DEFAULT_STATE_KEY = 'publish_recall_verifier:v1';
const DEFAULT_BACKOFF_MS = [5_000, 15_000, 60_000];
const OUTCOME_KINDS = ['ok', 'missing', 'mismatch', 'error', 'skipped'];
const FETCH_TIMEOUT = Symbol('publish_recall_fetch_timeout');
// Public Hub fetches retain these delivery diagnostics on the unwrapped canonical asset.
const RECALL_HASH_EXCLUDED_FIELDS = [
    'asset_id',
    'gdi_score',
    'success_rate',
    'reuse_count',
    'source_node_id',
    'payload_backfill_reason',
];
const defaultTimers = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
};
export function resolvePublishRecallConfig(env = process.env) {
    return {
        enabled: env['EVOLVE_RECALL_VERIFY'] === '1',
        sampleRate: sampleRate(env['EVOLVE_RECALL_VERIFY_SAMPLE_RATE']),
        queueMax: boundedInt(env['EVOLVE_RECALL_VERIFY_QUEUE_MAX'], 256, 1, 4_096),
        outcomeMax: boundedInt(env['EVOLVE_RECALL_VERIFY_OUTCOME_MAX'], 256, 1, 4_096),
        initialWaitMs: boundedInt(env['EVOLVE_RECALL_VERIFY_INITIAL_WAIT_MS'], 5_000, 0, 24 * 60 * 60_000),
        pollMs: boundedInt(env['EVOLVE_RECALL_VERIFY_POLL_MS'], 5_000, 10, 60 * 60_000),
        fetchTimeoutMs: boundedInt(env['EVOLVE_RECALL_VERIFY_FETCH_TIMEOUT_MS'], 8_000, 1, 10 * 60_000),
        maxAttempts: boundedInt(env['EVOLVE_RECALL_VERIFY_ATTEMPTS'], 3, 1, 20),
        backoffMs: DEFAULT_BACKOFF_MS,
    };
}
export class PublishRecallVerifier {
    opts;
    now;
    random;
    timers;
    stateKey;
    state;
    timer;
    started = false;
    stopping = false;
    running;
    activeEntry;
    persistenceHealthy = true;
    constructor(opts) {
        this.opts = opts;
        this.now = opts.now ?? (() => Date.now());
        this.random = opts.random ?? Math.random;
        this.timers = opts.timers ?? defaultTimers;
        this.stateKey = opts.stateKey ?? DEFAULT_STATE_KEY;
        this.state = this.loadState();
    }
    start() {
        if (this.started)
            return;
        this.stopping = false;
        this.started = true;
        this.schedule();
    }
    async stop() {
        this.started = false;
        this.stopping = true;
        this.clearTimer();
        const active = this.running;
        if (active)
            await active.catch(() => undefined);
    }
    enqueue(input) {
        if (!this.opts.config.enabled)
            return { enqueued: false, reason: 'feature_disabled' };
        if (!this.opts.fetchAssetById)
            return { enqueued: false, reason: 'fetch_unavailable' };
        const assetId = input.assetId.trim();
        const publishedAt = finiteTimestamp(input.publishedAt, this.now());
        const base = {
            assetId,
            ...(input.assetType ? { assetType: input.assetType } : {}),
            attempts: 0,
        };
        if (!assetId)
            return this.skip(base, 'missing_asset_id');
        if (!isContentAssetId(assetId))
            return this.skip(base, 'invalid_asset_id');
        if (this.opts.config.sampleRate < 1 && this.random() >= this.opts.config.sampleRate) {
            return this.skip(base, 'sampled_out');
        }
        if (this.state.queue.some((entry) => entry.assetId === assetId)) {
            return { enqueued: false, reason: 'already_queued' };
        }
        while (this.state.queue.length >= this.opts.config.queueMax) {
            const dropIndex = this.state.queue.findIndex((entry) => entry !== this.activeEntry);
            if (dropIndex < 0)
                return this.skip(base, 'queue_full');
            const [dropped] = this.state.queue.splice(dropIndex, 1);
            if (dropped)
                this.recordOutcome({
                    assetId: dropped.assetId,
                    ...(dropped.assetType ? { assetType: dropped.assetType } : {}),
                    outcome: 'skipped',
                    reason: 'queue_full',
                    attempts: dropped.attempts,
                    at: this.now(),
                    latencyMs: 0,
                    ageMs: Math.max(0, this.now() - dropped.publishedAt),
                }, false);
        }
        this.state.queue.push({
            assetId,
            ...(input.assetType ? { assetType: input.assetType } : {}),
            publishedAt,
            attempts: 0,
            nextAttemptAt: publishedAt + this.opts.config.initialWaitMs,
        });
        this.persist();
        this.schedule();
        return { enqueued: true };
    }
    observeAcceptedPublish(envelope, result) {
        try {
            if (!this.opts.config.enabled || !this.opts.fetchAssetById)
                return 0;
            if (envelope.type !== 'asset_submit')
                return 0;
            const receipt = asRecord(result);
            if (receipt['status'] !== 'accepted')
                return 0;
            const assets = assetsFromEnvelope(envelope);
            const submittedIds = optionalStringArray(receipt['submittedAssetIds']);
            const receiptIds = optionalStringArray(receipt['assetIds']);
            const singleReceiptId = stringValue(receipt['assetId']);
            const refs = assets.map((asset, index) => ({
                assetId: submittedIds[index]
                    ?? receiptIds[index]
                    ?? (index === 0 ? singleReceiptId : undefined)
                    ?? verifiedEnvelopeAssetId(asset)
                    ?? '',
                assetType: asset.type,
            }));
            let enqueued = 0;
            for (const ref of refs) {
                if (this.enqueue(ref).enqueued)
                    enqueued += 1;
            }
            return enqueued;
        }
        catch {
            return 0;
        }
    }
    runDue() {
        if (this.stopping || !this.opts.config.enabled || !this.opts.fetchAssetById || this.running)
            return Promise.resolve(0);
        const run = this.processDue();
        this.running = run;
        return run.finally(() => {
            if (this.running === run)
                this.running = undefined;
            this.schedule();
        });
    }
    async processDue() {
        let processed = 0;
        const due = this.state.queue.filter((entry) => entry.nextAttemptAt <= this.now());
        for (const entry of due) {
            if (this.stopping)
                break;
            if (!this.state.queue.includes(entry))
                continue;
            this.activeEntry = entry;
            try {
                await this.process(entry);
            }
            finally {
                if (this.activeEntry === entry)
                    this.activeEntry = undefined;
            }
            processed += 1;
        }
        return processed;
    }
    inspect() {
        return {
            version: 1,
            queue: this.state.queue.map((entry) => ({ ...entry })),
            outcomes: this.state.outcomes.map((outcome) => ({ ...outcome })),
            counts: { ...this.state.counts },
        };
    }
    status() {
        return {
            enabled: this.opts.config.enabled,
            fetchAvailable: Boolean(this.opts.fetchAssetById),
            queued: this.state.queue.length,
            counts: { ...this.state.counts },
            lastOutcome: this.state.outcomes.length > 0 ? { ...this.state.outcomes[this.state.outcomes.length - 1] } : null,
            persistenceHealthy: this.persistenceHealthy,
        };
    }
    async process(entry) {
        if (entry.attempts >= this.opts.config.maxAttempts) {
            this.finish(entry, 'error', 'retry_exhausted', 0);
            return;
        }
        const startedAt = this.now();
        entry.attempts += 1;
        // If this process exits mid-fetch, do not let a restarted verifier immediately overlap the old request.
        entry.nextAttemptAt = startedAt
            + this.opts.config.fetchTimeoutMs
            + this.backoffForAttempt(entry.attempts);
        this.persist();
        let recalled;
        try {
            recalled = await this.fetchWithTimeout(entry.assetId);
        }
        catch (error) {
            const reason = error === FETCH_TIMEOUT ? 'fetch_timeout' : 'fetch_error';
            // The fetch seam has no cancellation contract. Retrying a timed-out request could overlap the still-running
            // operation, so timeout is terminal; ordinary failures remain retryable from their completion time.
            if (error === FETCH_TIMEOUT || entry.attempts >= this.opts.config.maxAttempts) {
                this.finish(entry, 'error', reason, this.elapsed(startedAt));
            }
            else {
                this.deferFromNow(entry);
            }
            return;
        }
        if (!recalled) {
            if (entry.attempts < this.opts.config.maxAttempts)
                this.deferFromNow(entry);
            else
                this.finish(entry, 'missing', 'not_found', this.elapsed(startedAt));
            return;
        }
        let computedAssetId;
        try {
            computedAssetId = wire.computeAssetId(recalled, RECALL_HASH_EXCLUDED_FIELDS);
        }
        catch {
            this.finish(entry, 'error', 'hash_recompute_failed', this.elapsed(startedAt), recalled.asset_id);
            return;
        }
        if (!computedAssetId) {
            this.finish(entry, 'error', 'hash_recompute_failed', this.elapsed(startedAt), recalled.asset_id);
            return;
        }
        if (recalled.asset_id !== entry.assetId || computedAssetId !== entry.assetId) {
            this.finish(entry, 'mismatch', 'asset_id_mismatch', this.elapsed(startedAt), recalled.asset_id, computedAssetId ?? undefined);
            return;
        }
        this.finish(entry, 'ok', undefined, this.elapsed(startedAt), recalled.asset_id, computedAssetId);
    }
    deferFromNow(entry) {
        entry.nextAttemptAt = this.now() + this.backoffForAttempt(entry.attempts);
        this.persist();
    }
    async fetchWithTimeout(assetId) {
        let timeoutHandle;
        const timeout = new Promise((_resolve, reject) => {
            timeoutHandle = this.timers.setTimeout(() => reject(FETCH_TIMEOUT), this.opts.config.fetchTimeoutMs);
            const handle = timeoutHandle;
            handle?.unref?.();
        });
        try {
            return await Promise.race([this.opts.fetchAssetById(assetId), timeout]);
        }
        finally {
            if (timeoutHandle !== undefined) {
                try {
                    this.timers.clearTimeout(timeoutHandle);
                }
                catch { /* best-effort timeout cleanup */ }
            }
        }
    }
    finish(entry, outcome, reason, latencyMs, recalledAssetId, computedAssetId) {
        this.remove(entry);
        const at = this.now();
        this.recordOutcome({
            assetId: entry.assetId,
            ...(entry.assetType ? { assetType: entry.assetType } : {}),
            outcome,
            ...(reason ? { reason } : {}),
            attempts: entry.attempts,
            at,
            latencyMs,
            ageMs: Math.max(0, at - entry.publishedAt),
            ...(recalledAssetId ? { recalledAssetId } : {}),
            ...(computedAssetId ? { computedAssetId } : {}),
        });
    }
    skip(base, reason) {
        this.recordOutcome({
            assetId: base.assetId,
            ...(base.assetType ? { assetType: base.assetType } : {}),
            outcome: 'skipped',
            reason,
            attempts: base.attempts,
            at: this.now(),
            latencyMs: 0,
        });
        return { enqueued: false, reason };
    }
    recordOutcome(outcome, persist = true) {
        this.state.outcomes.push(outcome);
        while (this.state.outcomes.length > this.opts.config.outcomeMax)
            this.state.outcomes.shift();
        this.state.counts[outcome.outcome] += 1;
        if (persist)
            this.persist();
    }
    remove(entry) {
        const index = this.state.queue.indexOf(entry);
        if (index >= 0)
            this.state.queue.splice(index, 1);
    }
    elapsed(startedAt) {
        return Math.max(0, this.now() - startedAt);
    }
    backoffForAttempt(attempt) {
        const values = this.opts.config.backoffMs.length > 0 ? this.opts.config.backoffMs : DEFAULT_BACKOFF_MS;
        return Math.max(0, values[Math.min(attempt - 1, values.length - 1)] ?? 0);
    }
    schedule() {
        if (!this.started || !this.opts.config.enabled || !this.opts.fetchAssetById || this.running)
            return;
        this.clearTimer();
        if (this.state.queue.length === 0)
            return;
        const earliest = Math.min(...this.state.queue.map((entry) => entry.nextAttemptAt));
        const delay = Math.max(0, Math.min(this.opts.config.pollMs, earliest - this.now()));
        this.timer = this.timers.setTimeout(() => {
            this.timer = undefined;
            void this.runDue().catch(() => { this.schedule(); });
        }, delay);
        const handle = this.timer;
        handle?.unref?.();
    }
    clearTimer() {
        if (this.timer === undefined)
            return;
        try {
            this.timers.clearTimeout(this.timer);
        }
        catch { /* best-effort timer cleanup */ }
        this.timer = undefined;
    }
    loadState() {
        try {
            const raw = this.opts.store.getState(this.stateKey);
            if (!raw)
                return emptyState();
            const parsed = JSON.parse(raw);
            const restored = restoreState(parsed, this.opts.config.queueMax, this.opts.config.outcomeMax);
            if (restored)
                return restored;
            this.persistenceHealthy = false;
            return emptyState();
        }
        catch {
            this.persistenceHealthy = false;
            return emptyState();
        }
    }
    persist() {
        try {
            this.opts.store.setState(this.stateKey, JSON.stringify(this.state));
            this.persistenceHealthy = true;
        }
        catch {
            this.persistenceHealthy = false;
        }
    }
}
function emptyState() {
    return {
        version: 1,
        queue: [],
        outcomes: [],
        counts: { ok: 0, missing: 0, mismatch: 0, error: 0, skipped: 0 },
    };
}
function restoreState(value, queueMax, outcomeMax) {
    const record = asRecord(value);
    if (record['version'] !== 1 || !Array.isArray(record['queue']) || !Array.isArray(record['outcomes']))
        return null;
    const queue = record['queue'].map(parseQueueEntry).filter((entry) => Boolean(entry)).slice(-queueMax);
    const outcomes = record['outcomes'].map(parseOutcome).filter((entry) => Boolean(entry)).slice(-outcomeMax);
    const countsRecord = asRecord(record['counts']);
    const counts = emptyState().counts;
    for (const kind of OUTCOME_KINDS)
        counts[kind] = finiteCount(countsRecord[kind]);
    return { version: 1, queue, outcomes, counts };
}
function parseQueueEntry(value) {
    const record = asRecord(value);
    const assetId = stringValue(record['assetId']);
    const publishedAt = finiteNumber(record['publishedAt']);
    const attempts = finiteNumber(record['attempts']);
    const nextAttemptAt = finiteNumber(record['nextAttemptAt']);
    if (!assetId || publishedAt === undefined || attempts === undefined || nextAttemptAt === undefined)
        return null;
    const assetType = assetKind(record['assetType']);
    return {
        assetId,
        ...(assetType ? { assetType } : {}),
        publishedAt,
        attempts: Math.max(0, Math.floor(attempts)),
        nextAttemptAt,
    };
}
function parseOutcome(value) {
    const record = asRecord(value);
    const assetId = stringValue(record['assetId']);
    const outcome = OUTCOME_KINDS.find((kind) => kind === record['outcome']);
    const attempts = finiteNumber(record['attempts']);
    const at = finiteNumber(record['at']);
    const latencyMs = finiteNumber(record['latencyMs']);
    const ageMs = record['ageMs'] === undefined ? undefined : finiteNumber(record['ageMs']);
    if (assetId === undefined || !outcome || attempts === undefined || at === undefined || latencyMs === undefined
        || (record['ageMs'] !== undefined && ageMs === undefined))
        return null;
    const assetType = assetKind(record['assetType']);
    return {
        assetId,
        ...(assetType ? { assetType } : {}),
        outcome,
        ...(stringValue(record['reason']) ? { reason: stringValue(record['reason']) } : {}),
        attempts: Math.max(0, Math.floor(attempts)),
        at,
        latencyMs: Math.max(0, latencyMs),
        ...(ageMs !== undefined ? { ageMs: Math.max(0, ageMs) } : {}),
        ...(stringValue(record['recalledAssetId']) ? { recalledAssetId: stringValue(record['recalledAssetId']) } : {}),
        ...(stringValue(record['computedAssetId']) ? { computedAssetId: stringValue(record['computedAssetId']) } : {}),
    };
}
function assetsFromEnvelope(envelope) {
    const payload = asRecord(envelope.payload);
    if (Array.isArray(payload['assets']))
        return payload['assets'].filter(isAssetRecord);
    return isAssetRecord(envelope.payload) ? [envelope.payload] : [];
}
function isAssetRecord(value) {
    const record = asRecord(value);
    return Boolean(assetKind(record['type']));
}
function assetKind(value) {
    return value === 'Gene' || value === 'Capsule' || value === 'EvolutionEvent' || value === 'AntiGene'
        ? value
        : undefined;
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function optionalStringArray(value) {
    return Array.isArray(value) ? value.map(stringValue) : [];
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function isContentAssetId(value) {
    return /^sha256:[a-f0-9]{64}$/i.test(value);
}
function verifiedEnvelopeAssetId(asset) {
    const declared = stringValue(asset.asset_id);
    if (!declared || !isContentAssetId(declared))
        return undefined;
    try {
        return wire.computeAssetId(asset) === declared ? declared : undefined;
    }
    catch {
        return undefined;
    }
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function finiteTimestamp(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function finiteCount(value) {
    const count = finiteNumber(value);
    return count === undefined ? 0 : Math.max(0, Math.floor(count));
}
function boundedInt(value, fallback, min, max) {
    if (!value?.trim())
        return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}
function sampleRate(value) {
    if (!value?.trim())
        return 1;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;
}