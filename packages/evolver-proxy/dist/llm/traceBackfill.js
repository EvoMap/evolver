import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mailbox } from '@evomap/evolver-core';
import { traceCollectionEnabled } from './traceConfig.js';
import { buildProxyTraceUploadPayload, PROXY_TRACE_UPLOAD_SCHEMA, } from './traceUploadPayload.js';
const TRACE_BACKFILL_STATE_PREFIX = 'llm_trace_backfill:v1:';
const DEFAULT_TRACE_BACKFILL_MAX_ROWS = 100;
const DEFAULT_TRACE_BACKFILL_MAX_SCAN_BYTES = 8 * 1024 * 1024;
const DEFAULT_TRACE_BACKFILL_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_TRACE_BACKFILL_MAX_PENDING = 100;
const TRACE_CURSOR_GUARD_BYTES = 4096;
const SUMMARY_ALLOWED_KEYS = new Set([
    'event',
    'payload_schema',
    'ts',
    'route',
    'provider',
    'wire_api',
    'original_model',
    'chosen_model',
    'tier',
    'reason',
    'fallback',
    'router_enabled',
    'upstream_mode',
    'status',
    'stream',
    'ttfb_ms',
    'latency_ms',
    'usage',
]);
const SUMMARY_STRING_OR_NULL_KEYS = [
    'route',
    'provider',
    'wire_api',
    'original_model',
    'chosen_model',
    'tier',
    'reason',
    'fallback',
    'upstream_mode',
];
const SUMMARY_NUMBER_OR_NULL_KEYS = ['status', 'ttfb_ms', 'latency_ms'];
const USAGE_ALLOWED_KEYS = new Set([
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
]);
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isNonEmptyBase64(value) {
    return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.has(key));
}
function hasOwnKey(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function parseNodeSecretVersion(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0)
        return value;
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed))
        return undefined;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
function isProducerGeneration(value) {
    return value === 'v1' || value === 'v2' || value === 'unknown';
}
function storeState(store, key) {
    try {
        return store?.getState?.(key) ?? undefined;
    }
    catch {
        return undefined;
    }
}
/** Mirrors v1 extractor truthyState: accepts the string/number/boolean truthy forms the store may surface. */
function truthyState(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}
/**
 * v1 parity (extractor.js readTraceNodeSecretVersionDecryptEnabled): the hub-keyring decrypt path is OFF by
 * default. It is enabled only when ANY of these env vars / store-state keys is truthy. Without it, an encrypted
 * row that only carries a secret_version (no hub_key_envelope) can only be decrypted by the hub keyring, which
 * older hubs cannot do — so we must refuse the upload.
 */
function readTraceNodeSecretVersionDecryptEnabled(env = process.env, store) {
    const candidates = [
        env['EVOMAP_PROXY_TRACE_NODE_SECRET_VERSION_DECRYPT'],
        env['EVOMAP_PROXY_TRACE_HUB_KEYRING_DECRYPT'],
        storeState(store, 'trace_node_secret_version_decrypt_enabled'),
        storeState(store, 'proxy_trace_node_secret_version_decrypt_enabled'),
        storeState(store, 'trace_hub_keyring_decrypt_enabled'),
        storeState(store, 'proxy_trace_hub_keyring_decrypt_enabled'),
    ];
    const rawEnabled = candidates.find((value) => value !== undefined && value !== null && value !== '');
    return truthyState(rawEnabled);
}
/**
 * v1 parity (extractor.js secretVersionTraceDecryptAllowed). An encrypted envelope is hub-decryptable when it
 * carries a hub_key_envelope (always allowed). A secret_version-only envelope is allowed ONLY when the
 * node-secret-version keyring-decrypt flag is enabled; otherwise the hub could never decrypt it.
 */
function secretVersionTraceDecryptAllowed(record, env, store) {
    if (!record || typeof record !== 'object')
        return false;
    if (record.hub_key_envelope)
        return true;
    if (parseNodeSecretVersion(record.secret_version) === undefined)
        return false;
    return readTraceNodeSecretVersionDecryptEnabled(env, store);
}
function isOptionalShortString(value, max) {
    return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max);
}
function isOptionalNonNegativeSafeInteger(value) {
    return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}
function isStringOrNull(value) {
    return typeof value === 'string' || value === null;
}
function isBooleanOrNull(value) {
    return typeof value === 'boolean' || value === null;
}
function isFiniteNumberOrNull(value) {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
}
function isHubTraceUsageSummary(value) {
    if (!isRecord(value) || !hasOnlyKeys(value, USAGE_ALLOWED_KEYS))
        return false;
    return Object.values(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}
function isHubTracePlaintextSummary(value) {
    if (!isRecord(value) || !hasOnlyKeys(value, SUMMARY_ALLOWED_KEYS))
        return false;
    if (value['event'] !== 'llm_trace_plaintext_summary')
        return false;
    if (value['payload_schema'] !== 'llm_turn_summary')
        return false;
    if (typeof value['ts'] !== 'string')
        return false;
    for (const key of SUMMARY_STRING_OR_NULL_KEYS) {
        if (!isStringOrNull(value[key]))
            return false;
    }
    if (!isBooleanOrNull(value['router_enabled']))
        return false;
    if (!isBooleanOrNull(value['stream']))
        return false;
    for (const key of SUMMARY_NUMBER_OR_NULL_KEYS) {
        if (!isFiniteNumberOrNull(value[key]))
            return false;
    }
    return !hasOwnKey(value, 'usage') || isHubTraceUsageSummary(value['usage']);
}
function isHubKeyEnvelope(value) {
    if (!isRecord(value))
        return false;
    const allowed = new Set(['algorithm', 'key_id', 'wrapped_key']);
    return hasOnlyKeys(value, allowed)
        && value['algorithm'] === 'rsa-oaep-sha256'
        && typeof value['key_id'] === 'string'
        && /^[a-f0-9]{16}$/i.test(value['key_id'])
        && isNonEmptyBase64(value['wrapped_key']);
}
export function isHubDecryptableTraceEnvelope(record) {
    if (!isRecord(record))
        return false;
    const allowed = new Set([
        'schema_version',
        'event',
        'encrypted',
        'payload_schema',
        'algorithm',
        'key_id',
        'iv',
        'tag',
        'ciphertext',
        'hub_key_envelope',
        'secret_version',
        'producer_generation',
        'producer_version',
        'producer_component',
        'plaintext_summary',
        'payload_complete',
        'payload_incomplete_reason',
        'hub_uploadable',
        'hub_upload_blocked_reason',
        'hub_upload_size_bytes',
        'hub_upload_max_bytes',
    ]);
    return hasOnlyKeys(record, allowed)
        && record['schema_version'] === 1
        && record['event'] === 'llm_trace_envelope'
        && record['encrypted'] === true
        && record['payload_schema'] === 'prism_trace_row'
        && record['algorithm'] === 'aes-256-gcm'
        && typeof record['key_id'] === 'string'
        && /^[a-f0-9]{16}$/i.test(record['key_id'])
        && isNonEmptyBase64(record['iv'])
        && isNonEmptyBase64(record['tag'])
        && isNonEmptyBase64(record['ciphertext'])
        && (!hasOwnKey(record, 'hub_key_envelope') || isHubKeyEnvelope(record['hub_key_envelope']))
        && (isHubKeyEnvelope(record['hub_key_envelope']) || parseNodeSecretVersion(record['secret_version']) !== undefined)
        && (record['secret_version'] === undefined || parseNodeSecretVersion(record['secret_version']) !== undefined)
        && (record['producer_generation'] === undefined || isProducerGeneration(record['producer_generation']))
        && isOptionalShortString(record['producer_version'], 32)
        && isOptionalShortString(record['producer_component'], 32)
        && (record['payload_complete'] === undefined || record['payload_complete'] === false)
        && isOptionalShortString(record['payload_incomplete_reason'], 64)
        && (record['hub_uploadable'] === undefined || record['hub_uploadable'] === false)
        && isOptionalShortString(record['hub_upload_blocked_reason'], 64)
        && isOptionalNonNegativeSafeInteger(record['hub_upload_size_bytes'])
        && isOptionalNonNegativeSafeInteger(record['hub_upload_max_bytes'])
        && (!hasOwnKey(record, 'plaintext_summary') || isHubTracePlaintextSummary(record['plaintext_summary']));
}
export function traceUploadBlockedReason(record) {
    if (record.hub_uploadable === false) {
        const reason = record.hub_upload_blocked_reason ?? 'hub_upload_blocked';
        return reason === 'payload_incomplete' ? undefined : reason;
    }
    return undefined;
}
function isProxyTraceUploadPayload(payload) {
    if (!isRecord(payload))
        return false;
    const allowed = new Set([
        'schema',
        'encrypted',
        'trace',
        'node_secret_version',
        'secret_version',
        'producer_generation',
        'producer_version',
        'producer_component',
    ]);
    return hasOnlyKeys(payload, allowed)
        && payload['schema'] === PROXY_TRACE_UPLOAD_SCHEMA
        && payload['encrypted'] === true
        && isHubDecryptableTraceEnvelope(payload['trace'])
        && (payload['node_secret_version'] === undefined || parseNodeSecretVersion(payload['node_secret_version']) !== undefined)
        && (payload['secret_version'] === undefined || parseNodeSecretVersion(payload['secret_version']) !== undefined)
        && (payload['producer_generation'] === undefined || isProducerGeneration(payload['producer_generation']))
        && isOptionalShortString(payload['producer_version'], 32)
        && isOptionalShortString(payload['producer_component'], 32);
}
export function normalizeProxyTraceOutboundPayload(payload, env = process.env, store) {
    if (!traceCollectionEnabled(env, store) || env['EVOLVER_LLM_TRACE_MAILBOX'] === '0') {
        return { ok: false, reason: 'proxy_trace_upload_disabled' };
    }
    // v1 parity (isProxyTraceUploadPayloadAllowed): an encrypted row that carries a secret_version but no
    // hub_key_envelope is decryptable only by the hub keyring. Refuse it at egress unless the keyring-decrypt
    // flag is enabled — a hub_key_envelope row is always allowed.
    const gate = (trace) => {
        const blockedReason = traceUploadBlockedReason(trace);
        if (blockedReason)
            return { ok: false, reason: blockedReason };
        if (!secretVersionTraceDecryptAllowed(trace, env, store)) {
            return { ok: false, reason: 'hub_keyring_decrypt_unsupported' };
        }
        return { ok: true, payload: buildProxyTraceUploadPayload(trace) };
    };
    if (isProxyTraceUploadPayload(payload))
        return gate(payload.trace);
    if (isRecord(payload) && payload['schema'] === PROXY_TRACE_UPLOAD_SCHEMA && payload['encrypted'] === true) {
        const trace = payload['trace'];
        if (isHubDecryptableTraceEnvelope(trace)) {
            return gate(trace);
        }
        return { ok: false, reason: 'proxy_trace_payload_rejected' };
    }
    if (isHubDecryptableTraceEnvelope(payload))
        return gate(payload);
    return { ok: false, reason: 'proxy_trace_payload_rejected' };
}
export function traceUploadIdempotencyKey(record) {
    return `proxy_trace:${createHash('sha256').update(JSON.stringify(record)).digest('hex')}`;
}
export function enqueueTraceEnvelope(store, record, opts = {}) {
    if (!traceCollectionEnabled(opts.env ?? process.env, store)) {
        return { queued: false, duplicate: false };
    }
    if (traceUploadBlockedReason(record)) {
        return { queued: false, duplicate: false };
    }
    // v1 parity (validateTraceUpload): refuse — without enqueueing — an encrypted row that carries a
    // secret_version but no hub_key_envelope unless the node-secret-version keyring-decrypt flag is enabled.
    // The hub could otherwise never decrypt it. The mailbox store doubles as the decrypt-flag state source.
    if (!secretVersionTraceDecryptAllowed(record, opts.env ?? process.env, store)) {
        return { queued: false, duplicate: false };
    }
    const idempotencyKey = traceUploadIdempotencyKey(record);
    const payload = buildProxyTraceUploadPayload(record);
    if (store.hasMessageWithIdempotencyKey?.(idempotencyKey)
        || store.hasMessageWithPayload?.('proxy_trace', payload)
        || store.hasMessageWithPayload?.('proxy_trace', record)) {
        return { queued: false, duplicate: true };
    }
    const env = mailbox.createEnvelope({
        id: idempotencyKey,
        type: 'proxy_trace',
        payload,
        correlationId: idempotencyKey,
        idempotencyKey,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(opts.runtimeNamespace ? { runtimeNamespace: opts.runtimeNamespace } : {}),
        ...(opts.sourceAgent ? { sourceAgent: opts.sourceAgent } : {}),
        ...(opts.targetAgent ? { targetAgent: opts.targetAgent } : {}),
    });
    return { queued: store.send(env).stored, duplicate: false };
}
function numberFromEnv(env, keys, fallback) {
    for (const key of keys) {
        const raw = Number(env[key]);
        if (Number.isFinite(raw) && raw > 0)
            return Math.floor(raw);
    }
    return fallback;
}
function cursorKey(file) {
    return `${TRACE_BACKFILL_STATE_PREFIX}${createHash('sha256').update(file).digest('hex').slice(0, 24)}`;
}
function currentCursorState(file, offset) {
    const stat = statSync(file);
    return {
        dev: Number(stat.dev) || 0,
        ino: Number(stat.ino) || 0,
        birthtimeMs: Math.floor(Number(stat.birthtimeMs) || 0),
        size: Number(stat.size) || 0,
        offset,
        guard: cursorGuard(file, offset),
    };
}
function cursorGuard(file, offset) {
    if (offset <= 0)
        return '';
    const bytesToRead = Math.min(TRACE_CURSOR_GUARD_BYTES, offset);
    const fd = openSync(file, 'r');
    try {
        const buf = Buffer.alloc(bytesToRead);
        const bytesRead = readSync(fd, buf, 0, bytesToRead, offset - bytesToRead);
        return createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
    }
    finally {
        closeSync(fd);
    }
}
function parseCursor(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.dev === 'number'
            && typeof parsed.ino === 'number'
            && typeof parsed.birthtimeMs === 'number'
            && typeof parsed.size === 'number'
            && typeof parsed.offset === 'number'
            && (typeof parsed.guard === 'string' || parsed.guard === undefined)
            && parsed.offset >= 0)
            return { ...parsed, guard: parsed.guard ?? '' };
    }
    catch {
        return null;
    }
    return null;
}
function sameFileIdentity(a, b) {
    if (!a)
        return false;
    if (a.dev && b.dev && a.ino && b.ino)
        return a.dev === b.dev && a.ino === b.ino;
    return a.birthtimeMs > 0 && a.birthtimeMs === b.birthtimeMs;
}
function cursorOffset(store, file) {
    const statState = currentCursorState(file, 0);
    const saved = parseCursor(store.getState?.(cursorKey(file)));
    if (!sameFileIdentity(saved, statState))
        return 0;
    if (!saved || saved.offset > statState.size || saved.size > statState.size)
        return 0;
    if (saved.guard !== cursorGuard(file, saved.offset))
        return 0;
    return saved.offset;
}
function readCompleteLines(file, offset, maxBytes, maxLineBytes) {
    const stat = statSync(file);
    const bytesToRead = Math.min(maxBytes, Math.max(0, stat.size - offset));
    if (bytesToRead <= 0)
        return { lines: [], nextOffset: offset, lineTooLong: false };
    const fd = openSync(file, 'r');
    try {
        const buf = Buffer.alloc(bytesToRead);
        const bytesRead = readSync(fd, buf, 0, bytesToRead, offset);
        let pos = 0;
        let nextOffset = offset;
        let lineTooLong = false;
        const lines = [];
        while (pos < bytesRead) {
            const nl = buf.indexOf(0x0a, pos);
            if (nl === -1) {
                if (bytesRead === bytesToRead && offset + bytesRead < stat.size) {
                    const partialLineBytes = bytesRead - pos;
                    if (partialLineBytes > maxLineBytes) {
                        nextOffset = offset + bytesRead;
                        lineTooLong = true;
                    }
                }
                break;
            }
            const rawLine = buf.subarray(pos, nl);
            nextOffset = offset + nl + 1;
            pos = nl + 1;
            if (rawLine.length === 0)
                continue;
            if (rawLine.length > maxLineBytes) {
                lineTooLong = true;
                continue;
            }
            lines.push({ raw: rawLine.toString('utf8'), nextOffset });
        }
        return { lines, nextOffset, lineTooLong };
    }
    finally {
        closeSync(fd);
    }
}
function traceFiles(dir) {
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((name) => /^llm-trace-\d{8}\.jsonl$/.test(name))
        .sort()
        .map((name) => join(dir, name));
}
function bump(stats, reason) {
    stats.skipped += 1;
    stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
}
function persistCursor(store, file, offset) {
    store.setState?.(cursorKey(file), JSON.stringify(currentCursorState(file, offset)));
}
export function backfillProxyTraceUploads(opts) {
    const env = opts.env ?? process.env;
    const maxRows = numberFromEnv(env, ['EVOLVER_LLM_TRACE_BACKFILL_MAX_ROWS', 'EVOMAP_PROXY_TRACE_BACKFILL_MAX_ROWS'], DEFAULT_TRACE_BACKFILL_MAX_ROWS);
    const maxScanBytes = numberFromEnv(env, ['EVOLVER_LLM_TRACE_BACKFILL_MAX_SCAN_BYTES', 'EVOMAP_PROXY_TRACE_BACKFILL_MAX_SCAN_BYTES'], DEFAULT_TRACE_BACKFILL_MAX_SCAN_BYTES);
    const maxLineBytes = numberFromEnv(env, ['EVOLVER_LLM_TRACE_BACKFILL_MAX_LINE_BYTES', 'EVOMAP_PROXY_TRACE_BACKFILL_MAX_LINE_BYTES'], DEFAULT_TRACE_BACKFILL_MAX_LINE_BYTES);
    const maxPending = numberFromEnv(env, ['EVOLVER_LLM_TRACE_MAX_PENDING_UPLOADS', 'EVOMAP_PROXY_TRACE_MAX_PENDING_UPLOADS'], DEFAULT_TRACE_BACKFILL_MAX_PENDING);
    const stats = { scanned: 0, queued: 0, duplicates: 0, skipped: 0, files: 0, reasons: {} };
    let stopBackfill = false;
    for (const file of traceFiles(opts.dir)) {
        if (stopBackfill || stats.scanned >= maxRows)
            break;
        let pending = opts.store.countPending?.('proxy', opts.runtimeNamespace);
        if (pending !== undefined && pending >= maxPending) {
            bump(stats, 'max_pending_uploads');
            break;
        }
        stats.files += 1;
        let offset = cursorOffset(opts.store, file);
        try {
            const read = readCompleteLines(file, offset, maxScanBytes, maxLineBytes);
            if (read.lineTooLong)
                bump(stats, 'line_too_long');
            let processedLineCount = 0;
            for (const line of read.lines) {
                if (stats.scanned >= maxRows)
                    break;
                if (pending !== undefined && pending >= maxPending) {
                    bump(stats, 'max_pending_uploads');
                    stopBackfill = true;
                    break;
                }
                processedLineCount += 1;
                stats.scanned += 1;
                offset = line.nextOffset;
                let parsed;
                try {
                    parsed = JSON.parse(line.raw);
                }
                catch {
                    bump(stats, 'invalid_json');
                    continue;
                }
                if (!isHubDecryptableTraceEnvelope(parsed)) {
                    bump(stats, 'not_hub_decryptable');
                    continue;
                }
                const blockedReason = traceUploadBlockedReason(parsed);
                if (blockedReason) {
                    bump(stats, blockedReason);
                    continue;
                }
                const queued = enqueueTraceEnvelope(opts.store, parsed, {
                    now: opts.now?.(),
                    env,
                    ...(opts.runtimeNamespace ? { runtimeNamespace: opts.runtimeNamespace } : {}),
                    ...(opts.sourceAgent ? { sourceAgent: opts.sourceAgent } : {}),
                    ...(opts.targetAgent ? { targetAgent: opts.targetAgent } : {}),
                });
                if (queued.duplicate)
                    stats.duplicates += 1;
                else if (queued.queued) {
                    stats.queued += 1;
                    if (pending !== undefined)
                        pending += 1;
                }
            }
            if (processedLineCount === read.lines.length && read.nextOffset > offset)
                offset = read.nextOffset;
            persistCursor(opts.store, file, offset);
        }
        catch {
            bump(stats, 'read_failed');
        }
    }
    return stats;
}