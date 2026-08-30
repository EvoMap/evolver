import { createCipheriv, createDecipheriv, createHash, privateDecrypt, publicEncrypt, randomBytes, constants, } from 'node:crypto';
import { captureBodiesEnabled, positiveIntegerFromEnv } from './bodyCapture.js';
import { proxyTraceUploadPayloadSizeBytes } from './traceUploadPayload.js';
function truthy(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}
export function traceUploadMaxBytes(env = process.env) {
    return positiveIntegerFromEnv(env, [
        'EVOLVER_LLM_TRACE_MAX_UPLOAD_BYTES',
        'EVOMAP_PROXY_TRACE_MAX_UPLOAD_BYTES',
        'EVOLVER_LLM_TRACE_ENVELOPE_MAX_CHARS',
        'EVOMAP_PROXY_TRACE_ENVELOPE_MAX_BYTES',
        'EVOLVER_HUB_MAILBOX_OUTBOUND_MAX_BODY_BYTES',
        'EVOMAP_OUTBOUND_SYNC_MAX_BODY_BYTES',
        'EVOMAP_MAILBOX_OUTBOUND_MAX_BODY_BYTES',
    ], 4 * 1024 * 1024);
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
function parseNodeSecret(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return /^[a-f0-9]{64}$/i.test(trimmed) ? trimmed : undefined;
}
function deriveNodeSecretTraceKey(nodeSecret) {
    return createHash('sha256').update(`evomap-proxy-trace-v1:${nodeSecret}`, 'utf8').digest();
}
function traceEnvelopeRequired(env = process.env, opts = {}) {
    return truthy(env['EVOLVER_LLM_TRACE_ENCRYPTION'])
        || truthy(env['EVOMAP_PROXY_TRACE_ENCRYPTION'])
        || truthy(env['EVOLVER_LLM_TRACE_PROFILE_ANALYSIS'])
        || truthy(env['EVOMAP_PROXY_TRACE_PROFILE_ANALYSIS'])
        || opts.profileAnalysisEnabled === true
        || captureBodiesEnabled(env);
}
function resolveTraceHubPublicKey(env = process.env, explicitPublicKey) {
    const key = String(env['EVOLVER_LLM_TRACE_HUB_PUBLIC_KEY']
        || env['EVOMAP_PROXY_TRACE_HUB_PUBLIC_KEY']
        || (typeof explicitPublicKey === 'string' ? explicitPublicKey : '')
        || '').trim();
    return key || null;
}
function resolveNodeSecretVersion(opts) {
    return parseNodeSecretVersion(opts.nodeSecretVersion);
}
function optionalShortString(value, max) {
    const trimmed = String(value ?? '').trim();
    return trimmed.length > 0 && trimmed.length <= max ? trimmed : undefined;
}
/**
 * Producer-generation enum, kept byte-for-byte in lockstep with three consumers:
 *   - hub `normalizeProducerGeneration` (proxyTraceWarehouseService.js) — lenient: anything else → 'unknown'
 *   - v2 `isProducerGeneration` (traceBackfill.ts) — case-sensitive 'v1'|'v2'|'unknown'
 *   - v1 extractor `isProducerGeneration` (extractor.js)
 * The default for unset is 'v2' (this is the v2 proxy). A non-empty value outside the enum is normalized to
 * 'unknown' rather than passed through, so a future caller wiring e.g. 'v3' can never produce an envelope that
 * fails our own backfill validation (isProducerGeneration). Output is ALWAYS within {'v1','v2','unknown'}.
 */
function normalizeProducerGeneration(value) {
    // Unset/empty → 'v2' (this is the v2 proxy). Any NON-EMPTY value outside the enum — including an
    // over-length string — normalizes to 'unknown' (hub slices to 16 then maps non-v1/v2 → 'unknown'; we
    // must not let a >16 junk value fall through to the 'v2' default). Output is ALWAYS within the enum.
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === '')
        return 'v2';
    return normalized === 'v1' || normalized === 'v2' || normalized === 'unknown' ? normalized : 'unknown';
}
function traceProducerMetadata(opts) {
    const producerVersion = optionalShortString(opts.producerVersion, 32);
    return {
        producer_generation: normalizeProducerGeneration(opts.producerGeneration),
        producer_component: optionalShortString(opts.producerComponent, 32) ?? 'proxy',
        ...(producerVersion ? { producer_version: producerVersion } : {}),
    };
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function stringOrNull(value) {
    return typeof value === 'string' ? value : null;
}
function booleanOrNull(value) {
    return typeof value === 'boolean' ? value : null;
}
function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function traceUsageSummary(value) {
    if (!isRecord(value))
        return undefined;
    const out = {};
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
        const n = value[key];
        if (typeof n === 'number' && Number.isFinite(n))
            out[key] = n;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function plaintextSummary(record) {
    if (!isRecord(record) || record['event'] !== 'llm_turn')
        return undefined;
    const usage = traceUsageSummary(record['usage']);
    return {
        event: 'llm_trace_plaintext_summary',
        payload_schema: 'llm_turn_summary',
        ts: stringOrNull(record['ts']) ?? '',
        route: stringOrNull(record['route']),
        provider: stringOrNull(record['provider']),
        wire_api: stringOrNull(record['wire_api']),
        original_model: stringOrNull(record['original_model']),
        chosen_model: stringOrNull(record['chosen_model']),
        tier: stringOrNull(record['tier']),
        reason: stringOrNull(record['reason']),
        fallback: stringOrNull(record['fallback']),
        router_enabled: booleanOrNull(record['router_enabled']),
        upstream_mode: stringOrNull(record['upstream_mode']),
        status: numberOrNull(record['status']),
        stream: booleanOrNull(record['stream']),
        ttfb_ms: numberOrNull(record['ttfb_ms']),
        latency_ms: numberOrNull(record['latency_ms']),
        ...(usage ? { usage } : {}),
    };
}
function incompleteBodyEnvelopeReason(value) {
    if (typeof value !== 'string')
        return undefined;
    try {
        const parsed = JSON.parse(value);
        if (!isRecord(parsed))
            return undefined;
        if (parsed['capture_complete'] === false || parsed['body_omitted'] === true) {
            return typeof parsed['reason'] === 'string' ? parsed['reason'].slice(0, 64) : 'body_capture_incomplete';
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function traceRecordIncompleteReason(record) {
    if (!isRecord(record))
        return undefined;
    if (record['body_truncated'] === true)
        return 'body_truncated';
    const requestReason = incompleteBodyEnvelopeReason(record['requestBody']);
    if (requestReason)
        return requestReason;
    const responseReason = incompleteBodyEnvelopeReason(record['responseBody']);
    if (responseReason)
        return responseReason;
    const attempts = record['attempts'];
    if (!Array.isArray(attempts))
        return undefined;
    for (const attempt of attempts) {
        if (!isRecord(attempt))
            continue;
        if (attempt['body_truncated'] === true)
            return 'attempt_body_truncated';
        const attemptRequestReason = incompleteBodyEnvelopeReason(attempt['requestBody']);
        if (attemptRequestReason)
            return attemptRequestReason;
        const attemptResponseReason = incompleteBodyEnvelopeReason(attempt['responseBody']);
        if (attemptResponseReason)
            return attemptResponseReason;
    }
    return undefined;
}
function annotateUploadStatus(envelope, record, env) {
    let out = envelope;
    const incompleteReason = traceRecordIncompleteReason(record);
    if (incompleteReason) {
        out = {
            ...out,
            payload_complete: false,
            payload_incomplete_reason: incompleteReason,
        };
    }
    if (out.hub_uploadable === false)
        return out;
    const maxUploadBytes = traceUploadMaxBytes(env);
    const sizeBytes = proxyTraceUploadPayloadSizeBytes(out);
    if (sizeBytes <= maxUploadBytes)
        return out;
    let blocked = {
        ...out,
        hub_uploadable: false,
        hub_upload_blocked_reason: 'max_upload_bytes',
        hub_upload_max_bytes: maxUploadBytes,
    };
    for (let i = 0; i < 4; i += 1) {
        const wrappedSizeBytes = proxyTraceUploadPayloadSizeBytes(blocked);
        if (blocked.hub_upload_size_bytes === wrappedSizeBytes)
            return blocked;
        blocked = { ...blocked, hub_upload_size_bytes: wrappedSizeBytes };
    }
    return blocked;
}
export function materializeTraceForStorage(record, env = process.env, opts = {}) {
    if (!traceEnvelopeRequired(env, opts))
        return { ok: true, record };
    const publicKey = resolveTraceHubPublicKey(env, opts.hubPublicKey);
    try {
        const nodeSecretVersion = resolveNodeSecretVersion(opts);
        const nodeSecret = parseNodeSecret(opts.nodeSecret);
        const nodeSecretKey = nodeSecret ? deriveNodeSecretTraceKey(nodeSecret) : undefined;
        const dataKey = nodeSecretKey ?? randomBytes(32);
        const iv = randomBytes(12);
        // Pin authTagLength to 16 (#281): without it the decrypt side would accept a short/truncated GCM tag, which is
        // easier to forge. Encrypt + decrypt both fix 16 so only a full 128-bit tag authenticates.
        const cipher = createCipheriv('aes-256-gcm', dataKey, iv, { authTagLength: 16 });
        const plaintext = Buffer.from(JSON.stringify(record), 'utf8');
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        let hubKeyEnvelope;
        try {
            if (publicKey) {
                const wrapped = publicEncrypt({
                    key: publicKey,
                    padding: constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: 'sha256',
                }, dataKey);
                hubKeyEnvelope = {
                    algorithm: 'rsa-oaep-sha256',
                    key_id: createHash('sha256').update(publicKey).digest('hex').slice(0, 16),
                    wrapped_key: wrapped.toString('base64'),
                };
            }
            else if (!nodeSecretKey) {
                return { ok: false, reason: 'hub_public_key_missing' };
            }
        }
        catch (err) {
            return { ok: false, reason: 'hub_key_wrap_failed', error: err instanceof Error ? err.message : String(err) };
        }
        const summary = plaintextSummary(record);
        const envelope = {
            schema_version: 1,
            event: 'llm_trace_envelope',
            encrypted: true,
            payload_schema: 'prism_trace_row',
            algorithm: 'aes-256-gcm',
            key_id: createHash('sha256').update(dataKey).digest('hex').slice(0, 16),
            ...(nodeSecretVersion !== undefined ? { secret_version: nodeSecretVersion } : {}),
            ...traceProducerMetadata(opts),
            iv: iv.toString('base64'),
            tag: tag.toString('base64'),
            ciphertext: ciphertext.toString('base64'),
            ...(hubKeyEnvelope ? { hub_key_envelope: hubKeyEnvelope } : {}),
            ...(summary ? { plaintext_summary: summary } : {}),
        };
        return {
            ok: true,
            record: annotateUploadStatus(envelope, record, env),
        };
    }
    catch (err) {
        return { ok: false, reason: 'trace_encrypt_failed', error: err instanceof Error ? err.message : String(err) };
    }
}
export function decryptHubTraceEnvelope(envelope, privateKey) {
    if (!envelope.hub_key_envelope)
        throw new Error('hub_key_envelope_required');
    const dataKey = privateDecrypt({
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
    }, Buffer.from(envelope.hub_key_envelope.wrapped_key, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(envelope.iv, 'base64'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
}