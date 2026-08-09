import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { ulid as makeUlid } from 'ulid';
import { createEnvelope, ENVELOPE_SCHEMA_VERSION, normalizePriority, sanitizePayload, specForType, } from './envelope.js';
const nodeRequire = createRequire(import.meta.url);
function isBunRuntime() {
    return typeof process.versions === 'object' && typeof process.versions.bun === 'string';
}
function openSqliteDatabase(path, options = {}) {
    if (isBunRuntime()) {
        const { Database } = nodeRequire('bun:sqlite');
        return options.readOnly ? new Database(path, { readonly: true }) : new Database(path);
    }
    // node:sqlite is exposed only as `node:sqlite` (no bare `sqlite` alias). Load it through createRequire so
    // bundlers do not statically strip the prefix and break Vitest/Vite or Bun standalone builds.
    const { DatabaseSync } = nodeRequire('node:sqlite');
    return options.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
}
const MAILBOX_PREVIEW_MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAILBOX_PREVIEW_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAILBOX_PREVIEW_COPY_BUFFER_BYTES = 64 * 1024;
function mailboxPreviewError(code) {
    return new Error(`mailbox_preview_${code}`);
}
function mailboxPreviewNoFollowFlag() {
    return constants['O_NOFOLLOW'] ?? 0;
}
function mailboxPreviewStat(path) {
    let stat;
    try {
        stat = lstatSync(path, { bigint: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw mailboxPreviewError('target_unsafe');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1n) {
        throw mailboxPreviewError('target_unsafe');
    }
    return stat;
}
function sameMailboxPreviewSnapshot(left, right) {
    const hasStableFileId = left.dev !== 0n || left.ino !== 0n || right.dev !== 0n || right.ino !== 0n;
    const sameIdentity = hasStableFileId
        ? left.dev === right.dev && left.ino === right.ino
        : left.birthtimeNs === right.birthtimeNs && left.mode === right.mode;
    return sameIdentity
        && left.mode === right.mode
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
function assertMailboxPreviewSize(stat) {
    if (stat.size > BigInt(MAILBOX_PREVIEW_MAX_FILE_BYTES)
        || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw mailboxPreviewError('target_too_large');
    }
    return Number(stat.size);
}
function writeMailboxPreviewChunk(fd, chunk, position) {
    let offset = 0;
    while (offset < chunk.length) {
        const written = writeSync(fd, chunk, offset, chunk.length - offset, position + offset);
        if (written <= 0)
            throw mailboxPreviewError('snapshot_write_failed');
        offset += written;
    }
}
function copyStableMailboxPreviewFile(sourcePath, destinationPath, expected) {
    const expectedBytes = assertMailboxPreviewSize(expected);
    let sourceFd;
    let destinationFd;
    try {
        sourceFd = openSync(sourcePath, constants.O_RDONLY | mailboxPreviewNoFollowFlag());
        const opened = fstatSync(sourceFd, { bigint: true });
        if (!opened.isFile() || !sameMailboxPreviewSnapshot(expected, opened)) {
            throw mailboxPreviewError('target_changed');
        }
        destinationFd = openSync(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | mailboxPreviewNoFollowFlag(), 0o600);
        const digest = createHash('sha256');
        const buffer = Buffer.allocUnsafe(MAILBOX_PREVIEW_COPY_BUFFER_BYTES);
        let total = 0;
        for (;;) {
            const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
            if (bytesRead === 0)
                break;
            if (total > MAILBOX_PREVIEW_MAX_FILE_BYTES - bytesRead) {
                throw mailboxPreviewError('target_too_large');
            }
            const chunk = buffer.subarray(0, bytesRead);
            digest.update(chunk);
            writeMailboxPreviewChunk(destinationFd, chunk, total);
            total += bytesRead;
        }
        fsyncSync(destinationFd);
        const afterDescriptor = fstatSync(sourceFd, { bigint: true });
        const afterPath = mailboxPreviewStat(sourcePath);
        if (total !== expectedBytes
            || !sameMailboxPreviewSnapshot(opened, afterDescriptor)
            || !afterPath
            || !sameMailboxPreviewSnapshot(afterDescriptor, afterPath)) {
            throw mailboxPreviewError('target_changed');
        }
        return Object.freeze({ stat: afterDescriptor, digest: digest.digest('hex'), bytes: total });
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('mailbox_preview_'))
            throw error;
        throw mailboxPreviewError('snapshot_failed');
    }
    finally {
        if (sourceFd !== undefined)
            closeSync(sourceFd);
        if (destinationFd !== undefined)
            closeSync(destinationFd);
    }
}
function hashStableMailboxPreviewFile(path, expected) {
    const before = mailboxPreviewStat(path);
    if (!before || !sameMailboxPreviewSnapshot(expected.stat, before)) {
        throw mailboxPreviewError('target_changed');
    }
    assertMailboxPreviewSize(before);
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | mailboxPreviewNoFollowFlag());
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || !sameMailboxPreviewSnapshot(before, opened)) {
            throw mailboxPreviewError('target_changed');
        }
        const digest = createHash('sha256');
        const buffer = Buffer.allocUnsafe(MAILBOX_PREVIEW_COPY_BUFFER_BYTES);
        let total = 0;
        for (;;) {
            const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0)
                break;
            if (total > MAILBOX_PREVIEW_MAX_FILE_BYTES - bytesRead) {
                throw mailboxPreviewError('target_too_large');
            }
            digest.update(buffer.subarray(0, bytesRead));
            total += bytesRead;
        }
        const afterDescriptor = fstatSync(fd, { bigint: true });
        const afterPath = mailboxPreviewStat(path);
        if (total !== expected.bytes
            || digest.digest('hex') !== expected.digest
            || !sameMailboxPreviewSnapshot(opened, afterDescriptor)
            || !afterPath
            || !sameMailboxPreviewSnapshot(afterDescriptor, afterPath)) {
            throw mailboxPreviewError('target_changed');
        }
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('mailbox_preview_'))
            throw error;
        throw mailboxPreviewError('target_changed');
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function assertMailboxRollbackJournalAbsent(mailboxPath) {
    try {
        lstatSync(`${mailboxPath}-journal`);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw mailboxPreviewError('target_unsafe');
    }
    throw mailboxPreviewError('hot_rollback_journal');
}
function assertMailboxPreviewTargetAbsent(mailboxPath) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
            lstatSync(`${mailboxPath}${suffix}`);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                continue;
            throw mailboxPreviewError('target_unsafe');
        }
        throw mailboxPreviewError('target_unsafe');
    }
    if (mailboxPreviewStat(mailboxPath))
        throw mailboxPreviewError('target_changed');
}
function stableMailboxPreviewCopy(mailboxPath) {
    const databaseStat = mailboxPreviewStat(mailboxPath);
    if (!databaseStat)
        throw mailboxPreviewError('target_changed');
    assertMailboxRollbackJournalAbsent(mailboxPath);
    const walPath = `${mailboxPath}-wal`;
    const walStat = mailboxPreviewStat(walPath);
    const totalBytes = databaseStat.size + (walStat?.size ?? 0n);
    if (totalBytes > BigInt(MAILBOX_PREVIEW_MAX_TOTAL_BYTES)) {
        throw mailboxPreviewError('target_too_large');
    }
    const snapshotDir = mkdtempSync(join(tmpdir(), 'evolver-mailbox-preview-'));
    const snapshotPath = join(snapshotDir, basename(mailboxPath));
    try {
        chmodSync(snapshotDir, 0o700);
        const databaseSnapshot = copyStableMailboxPreviewFile(mailboxPath, snapshotPath, databaseStat);
        const walSnapshot = walStat
            ? copyStableMailboxPreviewFile(walPath, `${snapshotPath}-wal`, walStat)
            : null;
        assertMailboxRollbackJournalAbsent(mailboxPath);
        const currentWal = mailboxPreviewStat(walPath);
        if ((walSnapshot === null) !== (currentWal === null)) {
            throw mailboxPreviewError('target_changed');
        }
        hashStableMailboxPreviewFile(mailboxPath, databaseSnapshot);
        if (walSnapshot)
            hashStableMailboxPreviewFile(walPath, walSnapshot);
        return { dir: snapshotDir, path: snapshotPath };
    }
    catch (error) {
        try {
            rmSync(snapshotDir, { recursive: true, force: true });
        }
        catch { /* preserve primary error */ }
        throw error;
    }
}
export const MAX_ATTEMPTS = 5;
export const DEFAULT_IMPORT_JSONL_MAX_LINE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_IMPORT_JSONL_MAX_BYTES = 128 * 1024 * 1024;
export const DEFAULT_IMPORT_JSONL_MAX_RECORDS = 100_000;
const JSONL_READ_CHUNK_BYTES = 64 * 1024;
export const MAILBOX_CLAIM_OWNER = Symbol('mailboxClaimOwner');
export class MailboxJsonlImportError extends Error {
    code;
    line;
    constructor(code, line, message) {
        super(`Mailbox JSONL line ${line}: ${message}`);
        this.name = 'MailboxJsonlImportError';
        this.code = code;
        this.line = line;
    }
}
export function mailboxClaimOwner(envelope) {
    return envelope[MAILBOX_CLAIM_OWNER];
}
export function expBackoffMs(attempt) {
    return Math.min(4000 * 2 ** (attempt - 1), 5 * 60 * 1000); // 4s→8s→…→5min
}
function asRow(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
/** Read one mailbox state value without creating, migrating, or taking write ownership of the database. */
export function readMailboxState(path, key) {
    const database = openSqliteDatabase(path, { readOnly: true });
    try {
        const row = database.prepare('SELECT v FROM kv WHERE k = ?').get(key);
        return typeof row?.['v'] === 'string' ? row['v'] : undefined;
    }
    finally {
        database.close();
    }
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function nullableTimestamp(value) {
    if (value === null)
        return null;
    return finiteNumber(value);
}
function timestampField(record, ...keys) {
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(record, key))
            return nullableTimestamp(record[key]);
    }
    return undefined;
}
function nullableStringField(record, ...keys) {
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(record, key))
            continue;
        const value = record[key];
        if (value === null)
            return null;
        if (typeof value === 'string')
            return value;
        return undefined;
    }
    return undefined;
}
function importedStatus(value) {
    switch (value) {
        case 'pending':
        case 'in_flight':
        case 'done':
        case 'failed':
        case 'expired':
            return value;
        case 'synced':
        case 'delivered':
            return 'done';
        case 'rejected':
            return 'failed';
        default:
            return undefined;
    }
}
function recoverImportedStatus(type, requested) {
    if (!specForType(type)) {
        return requested === 'pending' || requested === 'in_flight' ? 'failed' : requested;
    }
    // A V1 worker and its lease cannot survive migration. Requeue in-flight work instead of creating a V2 row
    // with status=in_flight and leasedUntil=NULL, which SQLite will never consider expired or claimable.
    return requested === 'in_flight' ? 'pending' : requested;
}
function normalizeImportedEnvelope(record, now = Date.now()) {
    const id = nonEmptyString(record['id']);
    const type = nonEmptyString(record['type']);
    if (!id || !type)
        return undefined;
    const createdAt = finiteNumber(record['createdAt']) ?? finiteNumber(record['created_at']) ?? now;
    const spec = specForType(type);
    const directionValue = record['direction'];
    const direction = directionValue === 'outbound' || directionValue === 'inbound' || directionValue === 'local'
        ? directionValue
        : spec?.direction;
    if (!direction)
        return undefined;
    const handlerValue = record['handler'];
    const handler = handlerValue === 'core' || handlerValue === 'proxy' || handlerValue === 'agent'
        ? handlerValue
        : spec?.handler ?? (direction === 'outbound' ? 'proxy' : 'agent');
    const originalStatus = importedStatus(record['status']) ?? 'pending';
    // Preserve unknown V1 types for audit without dispatching a contract that V2 cannot handle.
    const status = recoverImportedStatus(type, originalStatus);
    // V1 `channel` names a transport (normally `evomap-hub`); V2 runtimeNamespace is an isolation boundary.
    const runtimeNamespace = nonEmptyString(record['runtimeNamespace']) ?? 'default';
    const correlationId = nonEmptyString(record['correlationId'])
        ?? nonEmptyString(record['correlation_id'])
        ?? nonEmptyString(record['ref_id'])
        ?? id;
    const attempts = Math.max(0, Math.floor(finiteNumber(record['attempts']) ?? finiteNumber(record['retry_count']) ?? 0));
    const importedTtlAt = timestampField(record, 'ttlAt', 'expires_at');
    const ttlAt = importedTtlAt === undefined
        ? (spec?.ttlClass === 'control' ? createdAt + 60 * 60 * 1000 : createdAt + 7 * 24 * 60 * 60 * 1000)
        : importedTtlAt;
    const updatedAt = finiteNumber(record['updatedAt'])
        ?? finiteNumber(record['updated_at'])
        ?? finiteNumber(record['synced_at'])
        ?? createdAt;
    return {
        id,
        type,
        direction,
        status,
        handler,
        payload: sanitizePayload(record['payload'] ?? {}),
        correlationId,
        replyTo: nonEmptyString(record['replyTo']) ?? nonEmptyString(record['reply_to']) ?? null,
        receiptId: nonEmptyString(record['receiptId']) ?? nonEmptyString(record['receipt_id']) ?? id,
        idempotencyKey: nonEmptyString(record['idempotencyKey']) ?? nonEmptyString(record['idempotency_key']) ?? id,
        sourceAgent: nonEmptyString(record['sourceAgent']) ?? nonEmptyString(record['source_agent']) ?? '',
        targetAgent: nonEmptyString(record['targetAgent']) ?? nonEmptyString(record['target_agent']) ?? '',
        runtimeNamespace,
        priority: normalizePriority(record['priority']),
        attempts,
        nextRetryAt: timestampField(record, 'nextRetryAt', 'next_retry_at') ?? null,
        ttlAt,
        createdAt,
        updatedAt,
        schemaVersion: nonEmptyString(record['schemaVersion']) ?? ENVELOPE_SCHEMA_VERSION,
        feedsMaterial: typeof record['feedsMaterial'] === 'boolean' ? record['feedsMaterial'] : spec?.feedsMaterial ?? false,
        lastError: nullableStringField(record, 'lastError', 'last_error', 'error') ?? null,
    };
}
function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const nested of Object.values(value))
            deepFreeze(nested);
        Object.freeze(value);
    }
    return value;
}
const mailboxFatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
function decodeMailboxImportLine(bytes, line) {
    try {
        return mailboxFatalUtf8Decoder.decode(bytes);
    }
    catch {
        throw new MailboxJsonlImportError('invalid_utf8', line, 'invalid UTF-8');
    }
}
/**
 * Parse and normalize a V1 mailbox journal without opening or mutating a V2 mailbox.
 * The returned batch is sealed so dry-run and apply can consume the exact same records.
 */
export function prepareMailboxJsonlImport(source, options = {}) {
    if (typeof source === 'string' && !existsSync(source)) {
        return Object.freeze({
            records: Object.freeze([]),
            sourceRecords: 0,
            messageCandidates: 0,
            uniqueMessageCandidates: 0,
            updateCandidates: 0,
        });
    }
    const maxLineBytes = positiveInteger(options.maxLineBytes ?? process.env['EVOLVER_IMPORT_JSONL_MAX_LINE_BYTES'], DEFAULT_IMPORT_JSONL_MAX_LINE_BYTES);
    const maxRecords = positiveInteger(options.maxRecords ?? process.env['EVOLVER_IMPORT_JSONL_MAX_RECORDS'], DEFAULT_IMPORT_JSONL_MAX_RECORDS);
    const maxBytes = positiveInteger(options.maxBytes ?? process.env['EVOLVER_IMPORT_JSONL_MAX_BYTES'], DEFAULT_IMPORT_JSONL_MAX_BYTES);
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const buf = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);
    const records = [];
    const messageIds = new Set();
    let sourceRecords = 0;
    let messageCandidates = 0;
    let updateCandidates = 0;
    let fd;
    let ownsFd = false;
    let position = 0;
    let parts = [];
    let lineBytes = 0;
    let lineNumber = 1;
    let overlong = false;
    const reset = () => { parts = []; lineBytes = 0; overlong = false; };
    const append = (segment) => {
        if (overlong || segment.length === 0)
            return;
        if (lineBytes + segment.length > maxLineBytes) {
            reset();
            overlong = true;
            return;
        }
        parts.push(Buffer.from(segment));
        lineBytes += segment.length;
    };
    const finish = () => {
        const currentLine = lineNumber;
        lineNumber += 1;
        if (overlong) {
            reset();
            throw new MailboxJsonlImportError('line_too_large', currentLine, `record exceeds ${maxLineBytes} bytes`);
        }
        if (lineBytes === 0) {
            reset();
            return;
        }
        const text = decodeMailboxImportLine(Buffer.concat(parts, lineBytes), currentLine).trim();
        reset();
        if (!text)
            return;
        sourceRecords += 1;
        if (sourceRecords > maxRecords) {
            throw new MailboxJsonlImportError('too_many_records', currentLine, `journal exceeds ${maxRecords} records`);
        }
        let record;
        try {
            record = JSON.parse(text);
        }
        catch {
            throw new MailboxJsonlImportError('invalid_json', currentLine, 'invalid JSON');
        }
        const row = asRow(record);
        if (!row) {
            throw new MailboxJsonlImportError('invalid_record', currentLine, 'record must be a JSON object');
        }
        if (Object.prototype.hasOwnProperty.call(row, '_op')) {
            if (row['_op'] !== 'update') {
                throw new MailboxJsonlImportError('unsupported_operation', currentLine, 'unsupported _op value');
            }
            const id = nonEmptyString(row['id']);
            const fields = asRow(row['fields']);
            if (!id || !fields) {
                throw new MailboxJsonlImportError('invalid_update', currentLine, 'update requires a non-empty id and object fields');
            }
            records.push(deepFreeze({ kind: 'update', id, fields }));
            updateCandidates += 1;
            return;
        }
        const envelope = normalizeImportedEnvelope(row, now);
        if (!envelope) {
            throw new MailboxJsonlImportError('invalid_message', currentLine, 'message requires a non-empty id, type, and valid direction');
        }
        records.push(deepFreeze({ kind: 'message', envelope }));
        messageCandidates += 1;
        messageIds.add(envelope.id);
    };
    try {
        if (typeof source === 'number') {
            fd = source;
        }
        else {
            fd = openSync(source, 'r');
            ownsFd = true;
        }
        for (;;) {
            const bytes = readSync(fd, buf, 0, buf.length, position);
            if (bytes <= 0)
                break;
            position += bytes;
            if (position > maxBytes) {
                throw new MailboxJsonlImportError('journal_too_large', lineNumber, `journal exceeds ${maxBytes} bytes`);
            }
            let start = 0;
            for (let i = 0; i < bytes; i += 1) {
                if (buf[i] !== 0x0a)
                    continue;
                append(buf.subarray(start, i));
                finish();
                start = i + 1;
            }
            if (start < bytes)
                append(buf.subarray(start, bytes));
        }
        finish();
    }
    finally {
        if (ownsFd && fd !== undefined)
            closeSync(fd);
    }
    return Object.freeze({
        records: Object.freeze(records),
        sourceRecords,
        messageCandidates,
        uniqueMessageCandidates: messageIds.size,
        updateCandidates,
    });
}
function rowToEnvelope(r) {
    return {
        id: r['id'], type: r['type'], direction: r['direction'],
        status: r['status'], handler: r['handler'],
        payload: r['payload'] ? JSON.parse(r['payload']) : {},
        correlationId: r['correlationId'], replyTo: r['replyTo'] ?? null,
        receiptId: r['receiptId'], idempotencyKey: r['idempotencyKey'],
        sourceAgent: r['sourceAgent'], targetAgent: r['targetAgent'],
        runtimeNamespace: r['runtimeNamespace'],
        priority: normalizePriority(r['priority']),
        attempts: r['attempts'], nextRetryAt: r['nextRetryAt'] ?? null,
        ttlAt: r['ttlAt'] ?? null,
        createdAt: r['createdAt'], updatedAt: r['updatedAt'],
        schemaVersion: r['schemaVersion'], feedsMaterial: Boolean(r['feedsMaterial']),
        lastError: r['lastError'] ?? null,
    };
}
function applyImportedV1UpdateToEnvelope(current, fields) {
    const requestedStatus = importedStatus(fields['status']) ?? current.status;
    const status = recoverImportedStatus(current.type, requestedStatus);
    const attempts = Math.max(0, Math.floor(finiteNumber(fields['attempts']) ?? finiteNumber(fields['retry_count']) ?? current.attempts));
    const importedNextRetryAt = timestampField(fields, 'nextRetryAt', 'next_retry_at');
    const nextRetryAt = importedNextRetryAt === undefined ? current.nextRetryAt : importedNextRetryAt;
    const importedTtlAt = timestampField(fields, 'ttlAt', 'expires_at');
    const ttlAt = importedTtlAt === undefined ? current.ttlAt : importedTtlAt;
    const updatedAt = finiteNumber(fields['updatedAt'])
        ?? finiteNumber(fields['updated_at'])
        ?? finiteNumber(fields['synced_at'])
        ?? current.updatedAt;
    const payload = Object.prototype.hasOwnProperty.call(fields, 'payload')
        ? sanitizePayload(fields['payload'])
        : current.payload;
    const priority = Object.prototype.hasOwnProperty.call(fields, 'priority')
        ? normalizePriority(fields['priority'])
        : current.priority;
    const importedLastError = nullableStringField(fields, 'lastError', 'last_error', 'error');
    const lastError = importedLastError === undefined ? current.lastError : importedLastError;
    return {
        ...current,
        status,
        payload,
        priority,
        attempts,
        nextRetryAt,
        ttlAt,
        updatedAt,
        lastError,
    };
}
function buildMailboxPreparedImportPlan(batch, getById, getBaseline) {
    const eligibleIds = new Set();
    const insertedIds = new Set();
    const managedIds = new Set();
    const protectedIds = new Set();
    const updatedIds = new Set();
    const finalById = new Map();
    for (const record of batch.records) {
        if (record.kind === 'update') {
            if (!eligibleIds.has(record.id))
                continue;
            const current = finalById.get(record.id);
            if (!current)
                continue;
            const updated = applyImportedV1UpdateToEnvelope(current, record.fields);
            if (JSON.stringify(updated) !== JSON.stringify(current))
                updatedIds.add(record.id);
            finalById.set(record.id, updated);
            continue;
        }
        const envelope = { ...record.envelope };
        if (eligibleIds.has(envelope.id))
            continue;
        let current = finalById.get(envelope.id);
        if (!current) {
            current = getById(envelope.id);
            if (current)
                finalById.set(envelope.id, current);
        }
        if (!current) {
            finalById.set(envelope.id, envelope);
            insertedIds.add(envelope.id);
            eligibleIds.add(envelope.id);
            protectedIds.delete(envelope.id);
            continue;
        }
        const baseline = getBaseline(envelope.id);
        if (baseline !== undefined && JSON.stringify(current) === baseline) {
            eligibleIds.add(envelope.id);
            managedIds.add(envelope.id);
            protectedIds.delete(envelope.id);
        }
        else {
            protectedIds.add(envelope.id);
        }
    }
    return {
        preview: Object.freeze({
            sourceRecords: batch.sourceRecords,
            messageCandidates: batch.messageCandidates,
            uniqueMessageCandidates: batch.uniqueMessageCandidates,
            updateCandidates: batch.updateCandidates,
            insertedMessages: insertedIds.size,
            updatedMessages: updatedIds.size,
            managedMessages: managedIds.size,
            protectedMessages: protectedIds.size,
        }),
        finalById,
        insertedIds,
        managedIds,
        eligibleIds,
    };
}
function previewPreparedMailboxDatabase(batch, database) {
    try {
        database.exec('BEGIN');
        const hasMessages = database.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='messages'").get() !== undefined;
        const hasImportState = database.prepare("SELECT 1 present FROM sqlite_master WHERE type='table' AND name='v1_import_state'").get() !== undefined;
        const readMessage = hasMessages
            ? database.prepare('SELECT * FROM messages WHERE id=?')
            : undefined;
        const readBaseline = hasImportState
            ? database.prepare('SELECT snapshot FROM v1_import_state WHERE id=?')
            : undefined;
        const plan = buildMailboxPreparedImportPlan(batch, (id) => {
            const row = readMessage?.get(id);
            return row ? rowToEnvelope(row) : undefined;
        }, (id) => {
            const snapshot = readBaseline?.get(id)?.['snapshot'];
            return typeof snapshot === 'string' ? snapshot : undefined;
        });
        database.exec('COMMIT');
        return plan.preview;
    }
    catch (error) {
        try {
            database.exec('ROLLBACK');
        }
        catch {
            // Preserve the primary preview error.
        }
        throw error;
    }
}
/** Preview a prepared import against an optional existing mailbox without creating or migrating it. */
export function previewPreparedMailboxImport(batch, mailboxPath) {
    if (!mailboxPath) {
        return buildMailboxPreparedImportPlan(batch, () => undefined, () => undefined).preview;
    }
    const databaseStat = mailboxPreviewStat(mailboxPath);
    if (!databaseStat) {
        assertMailboxPreviewTargetAbsent(mailboxPath);
        return buildMailboxPreparedImportPlan(batch, () => undefined, () => undefined).preview;
    }
    const snapshot = stableMailboxPreviewCopy(mailboxPath);
    let database;
    let preview;
    let operationError;
    try {
        database = openSqliteDatabase(snapshot.path, { readOnly: true });
        preview = previewPreparedMailboxDatabase(batch, database);
    }
    catch (error) {
        operationError = error;
    }
    try {
        database?.close();
    }
    catch (error) {
        operationError ??= error;
    }
    let cleanupError;
    try {
        rmSync(snapshot.dir, { recursive: true, force: true });
    }
    catch (error) {
        cleanupError = error;
    }
    if (operationError !== undefined)
        throw operationError;
    if (cleanupError !== undefined)
        throw mailboxPreviewError('cleanup_failed');
    return preview;
}
function ensureMessageColumn(db, name, definition) {
    const columns = db.prepare('PRAGMA table_info(messages)').all();
    if (!columns.some((column) => column['name'] === name)) {
        db.exec(`ALTER TABLE messages ADD COLUMN ${definition}`);
    }
}
/** mailbox sqlite 引擎 (WAL + busy_timeout). 状态机 pending→in_flight→done/failed/expired + 租约 + 重试/DLQ. */
export class MailboxStore {
    db;
    constructor(opts) {
        mkdirSync(dirname(opts.path), { recursive: true });
        this.db = openSqliteDatabase(opts.path);
        this.db.exec('PRAGMA journal_mode = WAL');
        // PRAGMA can't be parameterized, so the value is string-interpolated — sanitize to a non-negative integer
        // first so a non-numeric busyTimeoutMs can never become SQL injection (defense-in-depth; #196).
        const rawBusy = Number(opts.busyTimeoutMs ?? 5000);
        const busyTimeoutMs = Number.isFinite(rawBusy) ? Math.max(0, Math.floor(rawBusy)) : 5000;
        this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, type TEXT, direction TEXT, status TEXT, handler TEXT,
      payload TEXT, correlationId TEXT, replyTo TEXT, receiptId TEXT, idempotencyKey TEXT,
      sourceAgent TEXT, targetAgent TEXT, runtimeNamespace TEXT, priority TEXT NOT NULL DEFAULT 'normal',
      attempts INTEGER, nextRetryAt INTEGER, ttlAt INTEGER, createdAt INTEGER, updatedAt INTEGER,
      schemaVersion TEXT, feedsMaterial INTEGER, dlq INTEGER DEFAULT 0, leasedUntil INTEGER, workerId TEXT,
      lastError TEXT, claimCheckpoint TEXT)`);
        ensureMessageColumn(this.db, 'priority', "priority TEXT NOT NULL DEFAULT 'normal'");
        ensureMessageColumn(this.db, 'lastError', 'lastError TEXT');
        ensureMessageColumn(this.db, 'claimCheckpoint', 'claimCheckpoint TEXT');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_status ON messages(status, handler)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_corr ON messages(correlationId)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_message_view ON messages(runtimeNamespace,type,direction,status,createdAt)');
        this.db.exec('CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, result TEXT, at INTEGER)');
        this.db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
        this.db.exec('CREATE TABLE IF NOT EXISTS v1_import_state (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)');
    }
    /** 通用 KV 状态(M6: sync 游标 inbound_cursor / lifecycle reauth 退避 / node_id 等). */
    getState(key) {
        const r = this.db.prepare('SELECT v FROM kv WHERE k=?').get(key);
        return r ? r['v'] : undefined;
    }
    setState(key, value) {
        this.db.prepare('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(key, value);
    }
    /** 投递; 同 id 幂等(OR IGNORE). 返回 receiptId. */
    send(e) {
        const r = this.db.prepare(`INSERT OR IGNORE INTO messages
      (id,type,direction,status,handler,payload,correlationId,replyTo,receiptId,idempotencyKey,sourceAgent,targetAgent,runtimeNamespace,priority,attempts,nextRetryAt,ttlAt,createdAt,updatedAt,schemaVersion,feedsMaterial,lastError,dlq)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(e.id, e.type, e.direction, e.status, e.handler, JSON.stringify(e.payload), e.correlationId, e.replyTo, e.receiptId, e.idempotencyKey, e.sourceAgent, e.targetAgent, e.runtimeNamespace, e.priority, e.attempts, e.nextRetryAt, e.ttlAt, e.createdAt, e.updatedAt, e.schemaVersion, e.feedsMaterial ? 1 : 0, e.lastError);
        return { receiptId: e.id, stored: Number(r.changes) > 0 };
    }
    getById(id) {
        const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
        return r ? rowToEnvelope(r) : undefined;
    }
    list(opts = {}) {
        const where = [];
        const args = [];
        if (opts.status) {
            where.push('status = ?');
            args.push(opts.status);
        }
        if (opts.handler) {
            where.push('handler = ?');
            args.push(opts.handler);
        }
        if (opts.runtimeNamespace) {
            where.push('runtimeNamespace = ?');
            args.push(opts.runtimeNamespace);
        }
        if (opts.type) {
            where.push('type = ?');
            args.push(opts.type);
        }
        if (opts.direction) {
            where.push('direction = ?');
            args.push(opts.direction);
        }
        if (opts.typeDirections && opts.typeDirections.length > 0) {
            const selectors = opts.typeDirections.slice(0, 20);
            where.push(`(${selectors.map(() => '(type = ? AND direction = ?)').join(' OR ')})`);
            for (const selector of selectors)
                args.push(selector.type, selector.direction);
        }
        const sql = `SELECT * FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY createdAt ${opts.newestFirst ? 'DESC' : 'ASC'} LIMIT ?`;
        // Clamp the LIMIT bind. The IPC list route feeds this `?limit=` straight from an external query string, so a
        // non-finite value (NaN from `?limit=abc`, Infinity from `?limit=1e400`) would bind as null/error and a huge
        // finite value is an unbounded read (memory DoS) even on the token-authed endpoint. Finite + positive + capped.
        const lim = Number.isFinite(opts.limit) && opts.limit > 0
            ? Math.min(Math.floor(opts.limit), 10_000)
            : 1000;
        args.push(lim);
        const offset = Number.isFinite(opts.offset) && opts.offset > 0
            ? Math.min(Math.floor(opts.offset), 10_000)
            : 0;
        const pagedSql = `${sql} OFFSET ?`;
        args.push(offset);
        return this.db.prepare(pagedSql).all(...args).map(rowToEnvelope);
    }
    countMessages(opts = {}) {
        const where = [];
        const args = [];
        if (opts.status) {
            where.push('status = ?');
            args.push(opts.status);
        }
        if (opts.runtimeNamespace) {
            where.push('runtimeNamespace = ?');
            args.push(opts.runtimeNamespace);
        }
        if (opts.type) {
            where.push('type = ?');
            args.push(opts.type);
        }
        if (opts.direction) {
            where.push('direction = ?');
            args.push(opts.direction);
        }
        const row = this.db.prepare(`SELECT COUNT(*) c FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...args);
        return Number(row['c']);
    }
    countByStatus(status) {
        return Number(this.db.prepare('SELECT COUNT(*) c FROM messages WHERE status = ?').get(status)['c']);
    }
    /** pending 计数(可按 handler/runtimeNamespace 分区), 用于 agent wake 去抖. */
    countPending(handler, runtimeNamespace) {
        const where = ["status='pending'", 'dlq=0'];
        const args = [];
        if (handler !== undefined) {
            where.push('handler=?');
            args.push(handler);
        }
        if (runtimeNamespace !== undefined) {
            where.push('runtimeNamespace=?');
            args.push(runtimeNamespace);
        }
        return Number(this.db.prepare(`SELECT COUNT(*) c FROM messages WHERE ${where.join(' AND ')}`).get(...args)['c']);
    }
    /** 只统计「现在就能 claim」的出站, 供 cadence 判定, 避免 deferred 拉低 idle 退避.
     *  谓词须与 claim() 对齐: 到点 pending + 租约过期的 in_flight 孤儿; 否则孤儿出站(claim 能回收却不被计)会被误判 idle, 恢复最多慢一个 idle 周期. */
    countClaimable(handler, now, runtimeNamespace) {
        const where = ['dlq=0', 'handler=?', "(status='pending' OR (status='in_flight' AND leasedUntil < ?))", '(nextRetryAt IS NULL OR nextRetryAt <= ?)'];
        const args = [handler, now, now];
        if (runtimeNamespace !== undefined) {
            where.push('runtimeNamespace=?');
            args.push(runtimeNamespace);
        }
        return Number(this.db.prepare(`SELECT COUNT(*) c FROM messages WHERE ${where.join(' AND ')}`).get(...args)['c']);
    }
    hasMessageWithIdempotencyKey(idempotencyKey) {
        return this.db.prepare('SELECT 1 FROM messages WHERE idempotencyKey = ? LIMIT 1').get(idempotencyKey) !== undefined;
    }
    hasMessageWithPayload(type, payload) {
        return this.db.prepare('SELECT 1 FROM messages WHERE type = ? AND payload = ? LIMIT 1')
            .get(type, JSON.stringify(payload)) !== undefined;
    }
    /** 原子 claim: pending(或租约过期的 in_flight) → in_flight + 租约. 可按 runtimeNamespace 分区. */
    claim(handler, limit, leaseMs, now, runtimeNamespace) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const nsClause = runtimeNamespace !== undefined ? ' AND runtimeNamespace=?' : '';
            const nsArgs = runtimeNamespace !== undefined ? [runtimeNamespace] : [];
            const rows = this.db.prepare(`SELECT * FROM messages WHERE handler=? AND dlq=0
         AND (status='pending' OR (status='in_flight' AND leasedUntil < ?))
         AND (nextRetryAt IS NULL OR nextRetryAt <= ?)${nsClause}
         ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END, createdAt LIMIT ?`).all(handler, now, now, ...nsArgs, limit);
            const workerId = makeUlid();
            const upd = this.db.prepare(`UPDATE messages SET status='in_flight', leasedUntil=?, workerId=?, updatedAt=? WHERE id=?`);
            for (const r of rows)
                upd.run(now + leaseMs, workerId, now, r['id']);
            this.db.exec('COMMIT');
            return rows.map((r) => ({
                ...rowToEnvelope(r),
                status: 'in_flight',
                [MAILBOX_CLAIM_OWNER]: workerId,
            }));
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    complete(id, now) {
        this.db.prepare(`UPDATE messages SET status='done', dlq=0, lastError=NULL, leasedUntil=NULL, workerId=NULL, updatedAt=? WHERE id=?`).run(now, id);
    }
    /** 失败: attempts<N→退避回 pending; ≥N→DLQ(不自动丢). */
    fail(id, err, now, maxAttempts = MAX_ATTEMPTS) {
        const m = this.getById(id);
        if (!m)
            return;
        const attempts = m.attempts + 1;
        if (attempts >= maxAttempts) {
            this.db.prepare(`UPDATE messages SET status='failed', dlq=1, attempts=?, lastError=?, leasedUntil=NULL, updatedAt=? WHERE id=?`).run(attempts, err, now, id);
        }
        else {
            this.db.prepare(`UPDATE messages SET status='pending', attempts=?, nextRetryAt=?, lastError=?, leasedUntil=NULL, workerId=NULL, updatedAt=? WHERE id=?`)
                .run(attempts, now + expBackoffMs(attempts), err, now, id);
        }
    }
    /** 暂缓: transient upstream outage 不消耗 attempts, 仅设置下次可 claim 时间. */
    defer(id, err, now, retryAfterMs) {
        const delay = Math.max(0, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
        this.db.prepare(`UPDATE messages SET status='pending', nextRetryAt=?, lastError=?, leasedUntil=NULL, workerId=NULL, updatedAt=? WHERE id=?`)
            .run(now + delay, err, now, id);
    }
    deferUnlessProcessed(id, processedKey, err, now, retryAfterMs) {
        return this.transitionUnlessProcessed(id, [processedKey], (current) => current.status === 'pending', () => this.defer(id, err, now, retryAfterMs));
    }
    failUnlessProcessed(id, processedKey, err, now, maxAttempts = 5) {
        return this.transitionUnlessProcessed(id, [processedKey], (current) => current.status === 'pending', () => this.fail(id, err, now, maxAttempts));
    }
    completeClaimed(id, now, claimOwner) {
        return this.transitionUnlessProcessed(id, [], (current) => current.status === 'in_flight', () => this.complete(id, now), claimOwner);
    }
    /** Atomically complete the current worker's lease and persist its idempotency result. */
    completeClaimedAndMarkProcessed(id, processedKey, result, now, claimOwner) {
        return this.transitionUnlessProcessed(id, [], (current) => current.status === 'in_flight', () => {
            this.markProcessed(processedKey, result, now);
            this.complete(id, now);
        }, claimOwner);
    }
    renewClaim(id, now, leaseMs, claimOwner) {
        const result = this.db.prepare(`UPDATE messages SET leasedUntil=?, updatedAt=?
      WHERE id=? AND status='in_flight' AND workerId=?`).run(now + leaseMs, now, id, claimOwner);
        return result.changes === 1;
    }
    setClaimedCheckpoint(id, checkpoint, now, claimOwner) {
        const encoded = JSON.stringify(checkpoint);
        return this.transitionUnlessProcessed(id, [], (current) => current.status === 'in_flight', () => {
            this.db.prepare('UPDATE messages SET claimCheckpoint=?, updatedAt=? WHERE id=?').run(encoded, now, id);
        }, claimOwner);
    }
    getClaimedCheckpoint(id) {
        const row = this.db.prepare('SELECT claimCheckpoint FROM messages WHERE id=?').get(id);
        const encoded = row?.['claimCheckpoint'];
        if (typeof encoded !== 'string')
            return undefined;
        try {
            return JSON.parse(encoded);
        }
        catch {
            return undefined;
        }
    }
    deferClaimed(id, err, now, retryAfterMs, claimOwner) {
        return this.transitionUnlessProcessed(id, [], (current) => current.status === 'in_flight', () => this.defer(id, err, now, retryAfterMs), claimOwner);
    }
    failClaimed(id, err, now, claimOwner, maxAttempts = MAX_ATTEMPTS) {
        return this.transitionUnlessProcessed(id, [], (current) => current.status === 'in_flight', () => this.fail(id, err, now, maxAttempts), claimOwner);
    }
    /** Transition only the row held by the current worker, unless a concurrent success marker already exists. */
    deferClaimedUnlessProcessed(id, processedKey, err, now, retryAfterMs, claimOwner) {
        return this.transitionUnlessProcessed(id, [processedKey], (current) => current.status === 'in_flight', () => this.defer(id, err, now, retryAfterMs), claimOwner);
    }
    /** Transition only the row held by the current worker, unless a concurrent success marker already exists. */
    failClaimedUnlessProcessed(id, processedKey, err, now, claimOwner, maxAttempts = MAX_ATTEMPTS) {
        return this.transitionUnlessProcessed(id, [processedKey], (current) => current.status === 'in_flight', () => this.fail(id, err, now, maxAttempts), claimOwner);
    }
    /** Atomically fail a non-leased intent and persist the replayable terminal result. */
    failAndMarkProcessedUnlessProcessed(id, blockingProcessedKeys, resultKey, result, err, now, maxAttempts = MAX_ATTEMPTS) {
        return this.transitionUnlessProcessed(id, blockingProcessedKeys, (current) => current.status === 'pending', () => {
            this.fail(id, err, now, maxAttempts);
            this.markProcessed(resultKey, result, now);
        });
    }
    /** Atomically fail the current worker's leased intent and persist the replayable terminal result. */
    failClaimedAndMarkProcessedUnlessProcessed(id, blockingProcessedKeys, resultKey, result, err, now, claimOwner, maxAttempts = MAX_ATTEMPTS) {
        return this.transitionUnlessProcessed(id, blockingProcessedKeys, (current) => current.status === 'in_flight', () => {
            this.fail(id, err, now, maxAttempts);
            this.markProcessed(resultKey, result, now);
        }, claimOwner);
    }
    transitionUnlessProcessed(id, processedKeys, isEligible, transition, expectedClaimOwner) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const current = this.getById(id);
            if (processedKeys.some((key) => this.isProcessed(key))
                || !current
                || !isEligible(current)
                || (expectedClaimOwner !== undefined && this.messageClaimOwner(id) !== expectedClaimOwner)) {
                this.db.exec('COMMIT');
                return false;
            }
            transition();
            this.db.exec('COMMIT');
            return true;
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch {
                // Preserve the primary transaction error.
            }
            throw error;
        }
    }
    /** DLQ 重放(人工/agent 显式, 不自动丢). */
    replayDlq(id, now) {
        this.db.prepare(`UPDATE messages SET status='pending', dlq=0, attempts=0, nextRetryAt=NULL, lastError=NULL, leasedUntil=NULL, updatedAt=? WHERE id=?`).run(now, id);
    }
    dlq() { return this.db.prepare('SELECT * FROM messages WHERE dlq=1').all().map(rowToEnvelope); }
    /** TTL 扫描: ttlAt 过期且未 done/dlq → expired. */
    expireOld(now) {
        const r = this.db.prepare(`UPDATE messages SET status='expired', updatedAt=? WHERE ttlAt < ? AND status NOT IN ('done','expired') AND dlq=0`).run(now, now);
        return Number(r.changes);
    }
    /** M2-5 关联线程: 同 correlationId 全部消息(请求+应答), 按 createdAt 排序. */
    findByCorrelation(correlationId) {
        return this.db.prepare('SELECT * FROM messages WHERE correlationId=? ORDER BY createdAt').all(correlationId).map(rowToEnvelope);
    }
    /** 关联线程中除 requestId 外最新一条 = 应答(durable, 跨重启/进程). */
    getReply(correlationId, requestId) {
        const r = this.db.prepare('SELECT * FROM messages WHERE correlationId=? AND id<>? ORDER BY createdAt DESC LIMIT 1').get(correlationId, requestId);
        return r ? rowToEnvelope(r) : undefined;
    }
    /** 构造并投递一条对 `to` 的应答(继承 correlationId, 收发方对调, replyTo 清空). */
    reply(to, replyType, payload, now, over = {}) {
        const env = createEnvelope({
            type: replyType,
            payload,
            correlationId: to.correlationId,
            sourceAgent: to.targetAgent,
            targetAgent: to.sourceAgent,
            runtimeNamespace: to.runtimeNamespace,
            replyTo: null,
            now,
            ...over,
        });
        const res = this.send(env);
        return { envelope: env, ...res };
    }
    /** M2-5 轻量状态视图(运维/IPC 查询用). */
    getStatus(id) {
        const r = this.db.prepare('SELECT id,type,status,priority,attempts,nextRetryAt,ttlAt,dlq,lastError FROM messages WHERE id=?').get(id);
        if (!r)
            return undefined;
        return {
            id: r['id'], type: r['type'], status: r['status'],
            priority: normalizePriority(r['priority']),
            attempts: Number(r['attempts']), nextRetryAt: r['nextRetryAt'] ?? null,
            ttlAt: r['ttlAt'] ?? null, dlq: Number(r['dlq']) === 1,
            lastError: r['lastError'] ?? null,
        };
    }
    /** 幂等(A13): 副作用 handler 用 idempotencyKey 去重; 命中返缓存不重跑. */
    isProcessed(key) { return this.db.prepare('SELECT 1 FROM idempotency WHERE key=?').get(key) !== undefined; }
    getProcessed(key) {
        const r = this.db.prepare('SELECT result FROM idempotency WHERE key=?').get(key);
        return r ? JSON.parse(r['result']) : undefined;
    }
    markProcessed(key, result, now) {
        this.db.prepare('INSERT OR IGNORE INTO idempotency (key,result,at) VALUES (?,?,?)').run(key, JSON.stringify(result ?? null), now);
    }
    replaceProcessed(key, result, now) {
        this.db.prepare(`INSERT INTO idempotency (key,result,at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET result=excluded.result, at=excluded.at`).run(key, JSON.stringify(result ?? null), now);
    }
    /** Persist a monotonic outcome and its lightweight concurrency marker in one SQLite transaction. */
    replaceProcessedWithMarker(key, result, markerKey, markerResult, now) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.replaceProcessed(key, result, now);
            this.replaceProcessed(markerKey, markerResult, now);
            this.db.exec('COMMIT');
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch {
                // Preserve the primary transaction error.
            }
            throw error;
        }
    }
    /** Backfill a concurrency marker only when the durable source result still satisfies the caller's predicate. */
    markProcessedIf(sourceKey, markerKey, markerResult, now, matches) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const sourceResult = this.getProcessed(sourceKey);
            if (sourceResult === undefined || !matches(sourceResult)) {
                this.db.exec('COMMIT');
                return false;
            }
            this.markProcessed(markerKey, markerResult, now);
            this.db.exec('COMMIT');
            return true;
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch {
                // Preserve the primary transaction error.
            }
            throw error;
        }
    }
    deleteProcessed(keys) {
        if (keys.length === 0)
            return;
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const remove = this.db.prepare('DELETE FROM idempotency WHERE key=?');
            for (const key of keys)
                remove.run(key);
            this.db.exec('COMMIT');
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch {
                // Preserve the primary transaction error.
            }
            throw error;
        }
    }
    messageClaimOwner(id) {
        const row = this.db.prepare('SELECT workerId FROM messages WHERE id=?').get(id);
        return typeof row?.['workerId'] === 'string' ? row['workerId'] : undefined;
    }
    /** Build the target-aware plan shared by preview and apply. */
    buildPreparedImportPlan(batch) {
        const readImportState = this.db.prepare('SELECT snapshot FROM v1_import_state WHERE id=?');
        return buildMailboxPreparedImportPlan(batch, (id) => this.getById(id), (id) => {
            const snapshot = readImportState.get(id)?.['snapshot'];
            return typeof snapshot === 'string' ? snapshot : undefined;
        });
    }
    /** Preview the exact import result against the current mailbox snapshot without writing to it. */
    previewPreparedImport(batch) {
        this.db.exec('BEGIN');
        try {
            const preview = this.buildPreparedImportPlan(batch).preview;
            this.db.exec('COMMIT');
            return preview;
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch {
                // Preserve the primary preview error.
            }
            throw error;
        }
    }
    writeImportedEnvelopeFields(current) {
        this.db.prepare(`UPDATE messages
      SET status=?, payload=?, priority=?, attempts=?, nextRetryAt=?, ttlAt=?, updatedAt=?, lastError=?
      WHERE id=?`).run(current.status, JSON.stringify(current.payload), current.priority, current.attempts, current.nextRetryAt, current.ttlAt, current.updatedAt, current.lastError, current.id);
    }
    /** Apply a parsed batch; planning and writes share one transaction and one normalized journal. */
    importPrepared(batch) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const plan = this.buildPreparedImportPlan(batch);
            for (const id of plan.insertedIds) {
                const envelope = plan.finalById.get(id);
                if (!envelope || !this.send(envelope).stored) {
                    throw new Error(`Mailbox import plan became stale for ${id}`);
                }
            }
            for (const id of plan.managedIds) {
                const envelope = plan.finalById.get(id);
                if (envelope)
                    this.writeImportedEnvelopeFields(envelope);
            }
            const writeImportState = this.db.prepare('INSERT INTO v1_import_state (id,snapshot) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot');
            for (const id of plan.eligibleIds) {
                const envelope = plan.finalById.get(id);
                if (envelope)
                    writeImportState.run(id, JSON.stringify(envelope));
            }
            this.db.exec('COMMIT');
            return plan.preview.insertedMessages;
        }
        catch (error) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch {
                // Preserve the primary import error.
            }
            throw error;
        }
    }
    importJsonl(source) {
        return this.importPrepared(prepareMailboxJsonlImport(source));
    }
    close() { this.db.close(); }
}