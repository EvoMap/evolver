// LLM trace capture — the reason the proxy sits on the wire at all. Every /v1/messages turn produces one trace
// record (models, tier decision, status, latency, token usage, stop_reason) appended as JSONL so the ingest
// pipeline can mine routing/economics signals the session transcripts can't see.
//
// Native request/response body capture is v1-compatible default full unless explicitly downgraded (see
// bodyCapture.ts). Body fields are redacted+capped. If encryption material is missing, the sink still writes the
// metadata row with bodies stripped so trace coverage stays auditable without falling back to plaintext bodies.
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { appendFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isNodeSecret, parseNodeSecretVersion } from '@evomap/evolver-adapter-public';
import { captureBodiesEnabled } from './bodyCapture.js';
import { traceCollectionEnabled, traceHubPublicKey, traceProfileAnalysisEnabled } from './traceConfig.js';
import { materializeTraceForStorage } from './traceEnvelope.js';
import { backfillProxyTraceUploads, enqueueTraceEnvelope, isHubDecryptableTraceEnvelope, } from './traceBackfill.js';
export const DEFAULT_TRACE_FILE_CAP_BYTES = 64 * 1024 * 1024;
function dayStamp(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}
function evomapHome(env = process.env) {
    return String(env['EVOLVER_HOME'] ?? env['EVOMAP_HOME'] ?? join(env['HOME'] || homedir(), '.evomap'));
}
function readTrimmedFile(path) {
    try {
        const value = readFileSync(path, 'utf8').trim();
        return value || undefined;
    }
    catch {
        return undefined;
    }
}
function traceEncryptionExplicitlyDisabled(env = process.env) {
    const raw = String(env['EVOLVER_LLM_TRACE_ENCRYPTION'] ?? env['EVOMAP_PROXY_TRACE_ENCRYPTION'] ?? '').trim().toLowerCase();
    return raw === '0' || raw === 'false' || raw === 'off' || raw === 'none';
}
function traceFlagEnabled(value) {
    const raw = String(value ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}
function metadataOnlyFallbackAllowed(env = process.env, profileAnalysisEnabled = false) {
    return captureBodiesEnabled(env)
        && !traceFlagEnabled(env['EVOLVER_LLM_TRACE_ENCRYPTION'])
        && !traceFlagEnabled(env['EVOMAP_PROXY_TRACE_ENCRYPTION'])
        && !traceFlagEnabled(env['EVOLVER_LLM_TRACE_PROFILE_ANALYSIS'])
        && !traceFlagEnabled(env['EVOMAP_PROXY_TRACE_PROFILE_ANALYSIS'])
        && !profileAnalysisEnabled;
}
export function resolveTraceNodeSecretMaterial(env = process.env, store, explicitNodeSecretVersion) {
    const explicitVersion = explicitNodeSecretVersion !== undefined ? parseNodeSecretVersion(explicitNodeSecretVersion) : undefined;
    const envSecretRaw = env['EVOMAP_NODE_SECRET'] ?? env['A2A_NODE_SECRET'];
    const envSecret = envSecretRaw && isNodeSecret(envSecretRaw) ? envSecretRaw : undefined;
    // EVOMAP-first to match the node_secret env precedence above, keeping (secret, version) paired.
    const envVersion = parseNodeSecretVersion(env['EVOMAP_NODE_SECRET_VERSION'] ?? env['A2A_NODE_SECRET_VERSION']);
    const storeSecretRaw = store?.getState?.('node_secret');
    const storeSecret = storeSecretRaw && isNodeSecret(storeSecretRaw) ? storeSecretRaw : undefined;
    const storeSource = store?.getState?.('node_secret_source');
    const storeVersion = parseNodeSecretVersion(store?.getState?.('node_secret_version'));
    if (storeSource === 'hub_rotate' && storeSecret) {
        return { nodeSecret: storeSecret, nodeSecretVersion: explicitVersion ?? storeVersion };
    }
    if (envSecret) {
        return {
            nodeSecret: envSecret,
            nodeSecretVersion: explicitVersion ?? envVersion ?? (envSecret === storeSecret ? storeVersion : undefined),
        };
    }
    if (storeSecret)
        return { nodeSecret: storeSecret, nodeSecretVersion: explicitVersion ?? storeVersion };
    const home = evomapHome(env);
    const legacySecret = readTrimmedFile(join(home, 'node_secret'));
    if (!legacySecret || !isNodeSecret(legacySecret))
        return { ...(explicitVersion !== undefined ? { nodeSecretVersion: explicitVersion } : {}) };
    const legacyVersion = parseNodeSecretVersion(readTrimmedFile(join(home, 'node_secret_version')));
    return { nodeSecret: legacySecret, nodeSecretVersion: explicitVersion ?? legacyVersion };
}
export function resolveTraceNodeSecretVersion(env = process.env, store, explicitNodeSecretVersion) {
    return resolveTraceNodeSecretMaterial(env, store, explicitNodeSecretVersion).nodeSecretVersion;
}
function metadataOnlyTraceRecord(record) {
    const { requestBody: _requestBody, responseBody: _responseBody, request_headers: _requestHeaders, response_headers: _responseHeaders, transport_metadata: _transportMetadata, attempts, ...rest } = record;
    const strippedAttempts = attempts?.map((attempt) => {
        const { requestBody: _attemptRequestBody, responseBody: _attemptResponseBody, ...attemptMeta } = attempt;
        return { ...attemptMeta, body_truncated: true };
    });
    return {
        ...rest,
        body_truncated: true,
        ...(strippedAttempts && strippedAttempts.length > 0 ? { attempts: strippedAttempts } : {}),
    };
}
/**
 * Append-only NDJSON sink, one file per UTC day (`llm-trace-YYYYMMDD.jsonl`). Fire-and-forget writes; any
 * failure (bad dir, full disk, cap reached) degrades to a single warn and NEVER propagates — trace capture
 * must not be able to break serving.
 */
export class JsonlTraceSink {
    opts;
    now;
    cap;
    log;
    warned = false;
    chmodWarned = false;
    envelopeWarned = false;
    plaintextWarned = false;
    mailboxWarned = false;
    cappedDay = null;
    securedFiles = new Set();
    /** Appends are chained, not raced: two in-flight fs appends to one path have no ordering guarantee, and
     * out-of-order trace lines would corrupt the day-file as a timeline. Still fire-and-forget to callers. */
    tail = Promise.resolve();
    constructor(opts) {
        this.opts = opts;
        this.now = opts.now ?? (() => Date.now());
        this.cap = opts.fileCapBytes ?? DEFAULT_TRACE_FILE_CAP_BYTES;
        this.log = opts.logger ?? console;
        try {
            mkdirSync(opts.dir, { recursive: true });
        }
        catch {
            /* surfaced on first write instead */
        }
        this.backfillExistingTraceUploads();
    }
    filePath() {
        return join(this.opts.dir, `llm-trace-${dayStamp(this.now())}.jsonl`);
    }
    /**
     * Await the appends queued so far. write() is fire-and-forget (it chains the fs append onto `tail` and returns),
     * so a caller that needs the trace durable on disk — a graceful shutdown, or a test asserting file contents —
     * must await this rather than guess a wall-clock delay. Never rejects: write() already swallows append errors
     * into `tail`.
     */
    flush() {
        return this.tail;
    }
    write = (record) => {
        try {
            const env = this.opts.env ?? process.env;
            if (!traceCollectionEnabled(env, this.opts.mailboxStore))
                return;
            const day = dayStamp(this.now());
            if (this.cappedDay === day)
                return;
            const file = this.filePath();
            try {
                if (statSync(file).size >= this.cap) {
                    this.cappedDay = day;
                    this.log.warn?.(JSON.stringify({ event: 'llm_trace_capped', file, cap_bytes: this.cap }));
                    return;
                }
            }
            catch {
                /* file does not exist yet → first write of the day */
            }
            const profileAnalysisEnabled = traceProfileAnalysisEnabled(env, this.opts.mailboxStore);
            const traceSecret = resolveTraceNodeSecretMaterial(env, this.opts.mailboxStore, this.opts.nodeSecretVersion);
            const materialized = materializeTraceForStorage(record, env, {
                nodeSecretVersion: traceSecret.nodeSecretVersion,
                nodeSecret: traceSecret.nodeSecret,
                hubPublicKey: traceHubPublicKey(env, this.opts.mailboxStore),
                profileAnalysisEnabled,
                producerGeneration: 'v2',
                producerVersion: this.opts.producerVersion,
                producerComponent: 'proxy',
            });
            let storedRecord;
            if (materialized.ok) {
                storedRecord = materialized.record;
                this.enqueueOutboundTrace(materialized.record);
            }
            else if (traceEncryptionExplicitlyDisabled(env)) {
                // Escape hatch: body capture is on but no encryption key is available AND trace
                // encryption is explicitly disabled, so redacted-but-plaintext request/response bodies
                // are written to the local trace file. Warn once so this never happens silently
                // (see docs/trace-body-capture.md).
                if (!this.plaintextWarned) {
                    this.plaintextWarned = true;
                    this.log.warn?.(JSON.stringify({ event: 'llm_trace_plaintext_bodies', reason: 'trace_encryption_disabled' }));
                }
                storedRecord = record;
            }
            else {
                if (!this.envelopeWarned) {
                    this.envelopeWarned = true;
                    this.log.warn?.(JSON.stringify({ event: 'llm_trace_hub_undecryptable', reason: materialized.reason }));
                }
                if (!metadataOnlyFallbackAllowed(env, profileAnalysisEnabled))
                    return;
                storedRecord = metadataOnlyTraceRecord(record);
            }
            const line = `${JSON.stringify(storedRecord)}\n`;
            this.tail = this.tail.then(async () => {
                if (!this.securedFiles.has(file)) {
                    try {
                        statSync(file);
                        await this.secureTraceFile(file);
                    }
                    catch {
                        /* new file: appendFile mode below controls initial permissions */
                    }
                }
                await appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
                await this.secureTraceFile(file);
            }).catch((err) => {
                if (!this.warned) {
                    this.warned = true;
                    this.log.warn?.(JSON.stringify({ event: 'llm_trace_write_failed', error: err instanceof Error ? err.message : String(err) }));
                }
            });
        }
        catch (err) {
            if (!this.warned) {
                this.warned = true;
                this.log.warn?.(JSON.stringify({ event: 'llm_trace_write_failed', error: err instanceof Error ? err.message : String(err) }));
            }
        }
    };
    async secureTraceFile(file) {
        if (this.securedFiles.has(file))
            return true;
        try {
            await chmod(file, 0o600);
            this.securedFiles.add(file);
            return true;
        }
        catch (err) {
            if (!this.chmodWarned) {
                this.chmodWarned = true;
                this.log.warn?.(JSON.stringify({ event: 'llm_trace_chmod_failed', error: err instanceof Error ? err.message : String(err) }));
            }
            return false;
        }
    }
    enqueueOutboundTrace(storedRecord) {
        if (!this.opts.mailboxStore || !isHubDecryptableTraceEnvelope(storedRecord))
            return;
        try {
            enqueueTraceEnvelope(this.opts.mailboxStore, storedRecord, {
                now: this.now(),
                env: this.opts.env ?? process.env,
                ...(this.opts.runtimeNamespace ? { runtimeNamespace: this.opts.runtimeNamespace } : {}),
                ...(this.opts.sourceAgent ? { sourceAgent: this.opts.sourceAgent } : {}),
                ...(this.opts.targetAgent ? { targetAgent: this.opts.targetAgent } : {}),
            });
        }
        catch (err) {
            if (!this.mailboxWarned) {
                this.mailboxWarned = true;
                this.log.warn?.(JSON.stringify({ event: 'llm_trace_enqueue_failed', error: err instanceof Error ? err.message : String(err) }));
            }
        }
    }
    backfillExistingTraceUploads() {
        if (!this.opts.mailboxStore)
            return null;
        try {
            return backfillProxyTraceUploads({
                dir: this.opts.dir,
                store: this.opts.mailboxStore,
                env: this.opts.env ?? process.env,
                now: this.now,
                ...(this.opts.runtimeNamespace ? { runtimeNamespace: this.opts.runtimeNamespace } : {}),
                ...(this.opts.sourceAgent ? { sourceAgent: this.opts.sourceAgent } : {}),
                ...(this.opts.targetAgent ? { targetAgent: this.opts.targetAgent } : {}),
            });
        }
        catch (err) {
            if (!this.mailboxWarned) {
                this.mailboxWarned = true;
                this.log.warn?.(JSON.stringify({ event: 'llm_trace_backfill_failed', error: err instanceof Error ? err.message : String(err) }));
            }
            return null;
        }
    }
}