import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { captureRegularAssetFileIdentity, fsyncDirectoryBestEffort } from '../assetstore/assetStoreStorage.js';
import { openSqliteDatabase } from '../util/sqlite.js';
import { canonicalEventPath } from '../util/canonicalEventPath.js';
import { AuditBudget, AuditWriteSkipped, openAuditFile } from './boundedAudit.js';
import { AuditCleanupError, auditCleanupSequence, withAuditCleanup } from './auditCleanup.js';
import { rootEventArchiveDir } from './eventArchive.js';
import { rootEvent } from './eventSchema.js';
const JOURNAL_SUFFIX = '.operations.sqlite';
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_OWNERS = 64;
const SEGMENT = /^root-events-\d{16}-\d{16}\.jsonl$/;
const owners = new Map();
const missing = (error) => error?.code === 'ENOENT';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export class RootOperationError extends Error {
    reason;
    constructor(reason) {
        super(`root_operation_${reason}`);
        this.reason = reason;
        this.name = 'RootOperationError';
    }
}
export function validateRootOperationTicket(value, raw, operationId) {
    const ticket = value;
    if (!ticket || ticket.schema !== 1 || ticket.operationId !== operationId
        || ticket.requestHash !== rootOperationRequestHash(snapshotRootOperation(raw))
        || typeof ticket.namespaceId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(ticket.namespaceId)) {
        throw new RootOperationError('ticket_invalid');
    }
    return { schema: 1, operationId, requestHash: ticket.requestHash, namespaceId: ticket.namespaceId };
}
export function validateRootOperationId(value) {
    if (typeof value !== 'string' || !/^(?:[-\w]{1,128}|sha256:[a-f0-9]{64})$(?![\s\S])/.test(value)) {
        throw new RootOperationError('identity_invalid');
    }
}
function canonical(value, depth = 0) {
    if (depth > 32)
        throw new RootOperationError('request_nesting_invalid');
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(',')}}`;
}
/** Normalize the writer's public envelope before the first await. Never hash caller-owned toJSON twice. */
export function snapshotRootOperation(raw) {
    const snapshot = JSON.parse(JSON.stringify(raw));
    if (snapshot.auditOperationId !== undefined || snapshot.auditRequestHash !== undefined)
        throw new RootOperationError('client_identity_denied');
    const parsed = rootEvent.parse({ ...snapshot, seq: 0, eventId: '00000000000000000000000000', ts: new Date(0).toISOString() });
    return { type: parsed.type, schemaVersion: parsed.schemaVersion, replayability: parsed.replayability,
        payload: parsed.payload, human: parsed.human, actor: parsed.actor };
}
export function rootOperationRequestHash(raw) { return digest(canonical(raw)); }
export function rootOperationEventHash(event) {
    const { auditOperationId: _id, auditRequestHash: _hash, ...raw } = event;
    return rootOperationRequestHash(snapshotRootOperation(raw));
}
export function validateRootOperationReceipt(value, raw, admission) {
    const event = rootEvent.parse(value), request = snapshotRootOperation(raw), hash = rootOperationRequestHash(request);
    validateRootOperationId(admission.operationId);
    const legacyId = admission.legacyActivityId;
    if (legacyId !== undefined && (typeof legacyId !== 'string' || request.type !== 'experience.activity'
        || request.payload?.id !== legacyId
        || admission.operationId !== `experience-activity-${legacyId}`))
        throw new RootOperationError('receipt_invalid');
    const keyed = event.auditOperationId === admission.operationId && event.auditRequestHash === hash;
    const unkeyedLegacy = legacyId !== undefined && event.auditOperationId === undefined && event.auditRequestHash === undefined
        && event.type === 'experience.activity' && event.payload?.id === legacyId;
    if (event.seq < 1 || rootOperationEventHash(event) !== hash || !keyed && !unkeyedLegacy) {
        throw new RootOperationError('receipt_invalid');
    }
    return event;
}
export function rootOperationFileIdentity(path) {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
        throw new RootOperationError('file_untrusted');
    const identity = captureRegularAssetFileIdentity(path);
    return `${identity.dev}:${identity.ino}:${identity.birthtimeNs}`;
}
function parentIdentity(path) {
    let stat = lstatSync(dirname(path), { bigint: true });
    const valid = (value) => value.isDirectory() && !value.isSymbolicLink();
    if (!valid(stat))
        throw new RootOperationError('parent_untrusted');
    if (process.platform === 'win32' && stat.dev === 0n) {
        const fd = openSync(dirname(path), constants.O_RDONLY);
        try {
            const opened = fstatSync(fd, { bigint: true }), after = lstatSync(dirname(path), { bigint: true });
            if (!valid(opened) || !valid(after) || opened.ino !== stat.ino || opened.ino !== after.ino
                || opened.birthtimeNs !== stat.birthtimeNs || opened.birthtimeNs !== after.birthtimeNs)
                throw new RootOperationError('parent_changed');
            stat = opened;
        }
        finally {
            closeSync(fd);
        }
    }
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
function journalIdentity(path) {
    if (lstatSync(path).size > MAX_JOURNAL_BYTES)
        throw new RootOperationError('journal_capacity');
    return rootOperationFileIdentity(path);
}
function validateNamespace(db, target, identity, allowEmpty = false) {
    const table = db.prepare("SELECT type FROM sqlite_schema WHERE name='root_operation_instance'").get();
    if (!table && allowEmpty && Number(db.prepare('SELECT count(*) AS n FROM sqlite_schema').get()?.['n']) === 0)
        return;
    if (table?.['type'] !== 'table')
        throw new RootOperationError('journal_changed');
    const row = db.prepare('SELECT target, parent_identity, journal_identity FROM root_operation_instance WHERE id=1').get();
    if (row?.['target'] !== target || row['parent_identity'] !== parentIdentity(target) || row['journal_identity'] !== identity) {
        throw new RootOperationError('journal_changed');
    }
}
function transaction(db, body) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = body();
        db.exec('COMMIT');
        return result;
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch { /* The connection remains owned until close. */ }
        throw error;
    }
}
function parseRecord(row) {
    const operationId = row['operation_id'], requestHash = row['request_hash'], line = row['line'];
    validateRootOperationId(operationId);
    if (typeof requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(requestHash)
        || typeof line !== 'string' || Buffer.byteLength(line) > 4096 || !line.endsWith('\n')
        || !Number.isSafeInteger(row['offset']) || Number(row['offset']) < 0
        || typeof row['identity'] !== 'string' || typeof row['prefix_hash'] !== 'string'
        || !/^[a-f0-9]{64}$/.test(row['prefix_hash']) || !['planned', 'committed'].includes(String(row['state']))
        || (row['archive'] !== null && (typeof row['archive'] !== 'string' || !SEGMENT.test(row['archive'])))) {
        throw new RootOperationError('metadata_invalid');
    }
    const event = rootEvent.parse(JSON.parse(line));
    if (rootOperationEventHash(event) !== requestHash || (row['state'] === 'planned'
        && (event.auditOperationId !== operationId || event.auditRequestHash !== requestHash)))
        throw new RootOperationError('metadata_invalid');
    return { operationId, requestHash, line, offset: Number(row['offset']), identity: row['identity'],
        prefixHash: row['prefix_hash'], state: row['state'],
        ...(row['archive'] === null ? {} : { archive: row['archive'] }) };
}
export class RootOperationJournal {
    db;
    target;
    identity;
    budget;
    constructor(db, target, identity, budget) {
        this.db = db;
        this.target = target;
        this.identity = identity;
        this.budget = budget;
    }
    check() {
        this.budget.check();
        if (journalIdentity(`${this.target}${JOURNAL_SUFFIX}`) !== this.identity)
            throw new RootOperationError('journal_changed');
        validateNamespace(this.db, this.target, this.identity);
    }
    namespaceId() {
        this.check();
        const value = this.db.prepare('SELECT instance FROM root_operation_instance WHERE id=1').get()?.['instance'];
        if (typeof value !== 'string')
            throw new RootOperationError('journal_changed');
        return value;
    }
    assertTicket(namespaceId, operationId, requestHash) {
        if (this.namespaceId() !== namespaceId)
            throw new RootOperationError('namespace_changed');
        const intent = this.get(operationId);
        if (intent?.requestHash !== requestHash)
            throw new RootOperationError('intent_missing');
    }
    admission(id, requestHash, namespaceId) {
        // These reads are one synchronous root-lock-owned group. Fence the group
        // before and after it, rather than reopening the same witness per query.
        this.check();
        const instance = this.db.prepare('SELECT instance FROM root_operation_instance WHERE id=1').get()?.['instance'];
        if (namespaceId !== undefined && instance !== namespaceId)
            throw new RootOperationError('namespace_changed');
        const row = this.db.prepare('SELECT * FROM root_operations WHERE operation_id=?').get(id);
        const record = row ? parseRecord(row) : undefined;
        if (namespaceId !== undefined && record?.requestHash !== requestHash)
            throw new RootOperationError('intent_missing');
        if (record && record.requestHash !== requestHash)
            throw new RootOperationError('request_conflict');
        const planned = this.db.prepare("SELECT operation_id FROM root_operations WHERE state='planned' LIMIT 1").get();
        if (planned && planned['operation_id'] !== id)
            throw new RootOperationError('pending');
        this.check();
        return record;
    }
    get(id) {
        this.check();
        const row = this.db.prepare('SELECT * FROM root_operations WHERE operation_id=?').get(id);
        return row ? parseRecord(row) : undefined;
    }
    assertHistorySequence(seq) {
        this.check();
        const known = Number(this.db.prepare("SELECT coalesce(max(json_extract(line,'$.seq')),0) AS n FROM root_operations").get()?.['n']);
        if (!Number.isSafeInteger(known) || known > seq)
            throw new RootOperationError('history_missing');
    }
    assertNoOtherPlan(id) {
        this.check();
        const row = this.db.prepare("SELECT operation_id FROM root_operations WHERE state='planned' LIMIT 1").get();
        if (row && row['operation_id'] !== id)
            throw new RootOperationError('pending');
    }
    prepare(record) {
        this.check();
        transaction(this.db, () => {
            this.assertNoOtherPlan(record.operationId);
            this.db.prepare('INSERT INTO root_operations VALUES(?,?,?,?,?,?,?,?)').run(record.operationId, record.requestHash, record.line, record.identity, record.offset, record.archive ?? null, record.prefixHash, record.state);
        });
        this.check();
    }
    committed(id, locator) {
        this.check();
        transaction(this.db, () => {
            this.check();
            if (Number(this.db.prepare("UPDATE root_operations SET state='committed',identity=?,offset=?,archive=? WHERE operation_id=?")
                .run(locator.identity, locator.offset, locator.archive ?? null, id).changes) !== 1)
                throw new RootOperationError('metadata_invalid');
        });
        this.check();
    }
}
/** Only the root lock owner may open this journal. A failed close retains that exact connection. */
export async function withRootOperationJournal(target, budget, body, existingOnly = false) {
    target = canonicalEventPath(target);
    const prior = owners.get(target);
    if (prior?.running)
        throw new RootOperationError('cleanup_pending');
    if (prior?.cleanup) {
        await prior.cleanup.retryCleanup();
        owners.delete(target);
    }
    else if (prior?.db) {
        prior.db.close();
        owners.delete(target);
    }
    for (const name of [...owners.keys()])
        rootOperationRootOwned(name);
    if (owners.size >= MAX_OWNERS)
        throw new RootOperationError('cleanup_capacity');
    const owner = { running: true };
    owners.set(target, owner);
    const path = `${target}${JOURNAL_SUFFIX}`;
    try {
        budget.check();
        let identity;
        try {
            identity = journalIdentity(path);
        }
        catch (error) {
            if (existingOnly && missing(error))
                throw new RootOperationError('namespace_missing');
            if (!missing(error))
                throw error;
            const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
            await withAuditCleanup(async () => { fsyncSync(fd); }, auditCleanupSequence([{ run: async () => { closeSync(fd); }, retryFailedOperation: true }]));
            fsyncDirectoryBestEffort(dirname(path));
            identity = journalIdentity(path);
        }
        const db = openSqliteDatabase(path, { create: false });
        owner.db = db;
        return await withAuditCleanup(async () => {
            budget.check();
            db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA max_page_count=8192;');
            validateNamespace(db, target, identity, !existingOnly);
            if (!db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='root_operations'").get())
                transaction(db, () => {
                    validateNamespace(db, target, identity, !existingOnly);
                    db.exec(`CREATE TABLE IF NOT EXISTS root_operation_instance(id INTEGER PRIMARY KEY CHECK(id=1),instance TEXT NOT NULL,
          target TEXT NOT NULL,parent_identity TEXT NOT NULL,journal_identity TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS root_operations(operation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,line TEXT NOT NULL,
          identity TEXT NOT NULL,offset INTEGER NOT NULL,archive TEXT,prefix_hash TEXT NOT NULL,state TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS root_operations_state ON root_operations(state);`);
                    if (!db.prepare('SELECT instance FROM root_operation_instance WHERE id=1').get()) {
                        db.prepare('INSERT INTO root_operation_instance VALUES(1,?,?,?,?)').run(randomUUID(), target, parentIdentity(target), identity);
                    }
                });
            return body(new RootOperationJournal(db, target, identity, budget));
        }, auditCleanupSequence([{ run: async () => { db.close(); owner.db = undefined; }, retryFailedOperation: true }]));
    }
    catch (error) {
        if (error instanceof AuditCleanupError)
            owner.cleanup = error;
        throw error;
    }
    finally {
        owner.running = false;
        if (!owner.db && !owner.cleanup)
            owners.delete(target);
    }
}
export function rootOperationRootOwned(path) {
    const target = canonicalEventPath(path), owner = owners.get(target);
    if (owner && !owner.running && !owner.cleanup && owner.db) {
        try {
            owner.db.close();
            if (owners.get(target) === owner)
                owners.delete(target);
        }
        catch { /* Retain the exact connection until its close is confirmed. */ }
    }
    if (owner?.cleanup?.cleanupComplete && !owner.running && !owner.db)
        owners.delete(target);
    return owners.has(target);
}
/** Synchronous/ordinary writers and rotation must not pass an unresolved operation's reserved suffix. */
export function assertNoPendingRootOperation(target) {
    target = canonicalEventPath(target);
    if (rootOperationRootOwned(target))
        throw new RootOperationError('cleanup_pending');
    const path = `${target}${JOURNAL_SUFFIX}`;
    let identity;
    try {
        identity = journalIdentity(path);
    }
    catch (error) {
        if (missing(error))
            return;
        throw error;
    }
    const db = openSqliteDatabase(path, { create: false, readOnly: true });
    let failed = false, failure;
    try {
        validateNamespace(db, target, identity);
        if (db.prepare("SELECT operation_id FROM root_operations WHERE state='planned' LIMIT 1").get())
            throw new RootOperationError('pending');
    }
    catch (error) {
        failed = true;
        failure = error;
    }
    try {
        db.close();
    }
    catch (cleanup) {
        owners.set(target, { running: false, db });
        if (failed)
            throw new AggregateError([failure, cleanup], 'root operation inspection and cleanup failed');
        throw cleanup;
    }
    if (failed)
        throw failure;
}
async function checkedIdentity(handle, path) {
    const stat = await handle.stat(), identity = rootOperationFileIdentity(path);
    const [dev, ino] = identity.split(':');
    if (String(stat.dev) !== dev || String(stat.ino) !== ino || !stat.isFile() || stat.nlink !== 1)
        throw new RootOperationError('target_changed');
    return identity;
}
async function readBytes(handle, count, budget, start = 0) {
    const bytes = Buffer.alloc(count);
    for (let offset = 0; offset < count;) {
        budget.check();
        const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, count - offset), start + offset);
        if (bytesRead <= 0)
            throw new RootOperationError('history_changed');
        offset += bytesRead;
    }
    budget.check();
    return bytes;
}
function archiveDir(path) { return rootEventArchiveDir(path); }
/** Read active and immutable archives under the caller's root lock, on checked existing descriptors. */
export async function readRootOperationHistory(path, active, budget, maxBytes) {
    const bySeq = new Map();
    let total = 0;
    const read = async (file, handle, archive) => {
        budget.check();
        const identity = await checkedIdentity(handle, file), stat = await handle.stat();
        total += stat.size;
        if (total > maxBytes)
            throw new AuditWriteSkipped('file_too_large');
        const bytes = await readBytes(handle, stat.size, budget);
        if (bytes.length && bytes.at(-1) !== 10)
            throw new RootOperationError('partial_event_tail');
        let offset = 0, previous;
        for (const raw of bytes.toString('utf8').split('\n')) {
            budget.check();
            if (!raw) {
                offset++;
                continue;
            }
            const line = `${raw}\n`;
            if (Buffer.byteLength(line) > 4096)
                throw new RootOperationError('history_invalid');
            const event = rootEvent.parse(JSON.parse(raw));
            if (previous !== undefined && event.seq !== previous + 1)
                throw new RootOperationError('history_gap');
            const prior = bySeq.get(event.seq);
            if (prior && canonical(prior.event) !== canonical(event))
                throw new RootOperationError('history_conflict');
            if (!prior || archive === undefined)
                bySeq.set(event.seq, { event, line, offset, identity, ...(archive ? { archive } : {}) });
            previous = event.seq;
            offset += Buffer.byteLength(line);
        }
        if (await checkedIdentity(handle, file) !== identity || (await handle.stat()).size !== stat.size)
            throw new RootOperationError('history_changed');
    };
    const directory = archiveDir(path);
    let names = [];
    try {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new RootOperationError('archive_untrusted');
        names = readdirSync(directory).filter(name => SEGMENT.test(name)).sort();
    }
    catch (error) {
        if (!missing(error))
            throw error;
    }
    for (const name of names) {
        budget.check();
        const file = join(directory, name);
        const handle = await openAuditFile(file, maxBytes - total, budget, true);
        await withAuditCleanup(() => read(file, handle, name), auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
    }
    await read(path, active);
    const ordered = [...bySeq.values()].sort((a, b) => a.event.seq - b.event.seq);
    for (let i = 0; i < ordered.length; i++)
        if (ordered[i].event.seq !== i + 1)
            throw new RootOperationError('history_gap');
    return ordered;
}
export async function rootOperationPrefixHash(handle, offset, budget) {
    return digest(await readBytes(handle, offset, budget));
}
/** Existing-only readback: missing receipt evidence is never permission to append again. */
export async function confirmRootOperation(path, active, record, journal, budget, maxBytes) {
    let locator = record;
    const confirm = async (handle, file) => {
        if (await checkedIdentity(handle, file) !== locator.identity)
            return false;
        const bytes = Buffer.from(record.line), stat = await handle.stat();
        if (stat.size < locator.offset + bytes.length)
            return false;
        if (!(await readBytes(handle, bytes.length, budget, locator.offset)).equals(bytes))
            return false;
        await handle.sync();
        if (await checkedIdentity(handle, file) !== locator.identity)
            throw new RootOperationError('target_changed');
        if (record.state !== 'committed' || record.identity !== locator.identity || record.offset !== locator.offset || record.archive !== locator.archive) {
            journal.committed(record.operationId, locator);
        }
        else
            journal.namespaceId(); // Revalidate the same journal binding without rewriting a durable receipt.
        return true;
    };
    if (record.archive) {
        const file = join(archiveDir(path), record.archive);
        try {
            const handle = await openAuditFile(file, maxBytes, budget, true);
            const found = await withAuditCleanup(() => confirm(handle, file), auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
            if (found)
                return rootEvent.parse(JSON.parse(record.line));
        }
        catch (error) {
            if (!missing(error))
                throw error;
        }
    }
    else if (await confirm(active, path))
        return rootEvent.parse(JSON.parse(record.line));
    if (record.state !== 'committed')
        throw new RootOperationError('target_changed');
    const history = await readRootOperationHistory(path, active, budget, maxBytes);
    const matches = history.filter(item => item.line === record.line);
    if (matches.length !== 1)
        throw new RootOperationError('history_missing');
    locator = matches[0];
    if (!locator.archive) {
        if (!await confirm(active, path))
            throw new RootOperationError('history_changed');
    }
    else {
        const file = join(archiveDir(path), locator.archive), handle = await openAuditFile(file, maxBytes, budget, true);
        await withAuditCleanup(async () => { if (!await confirm(handle, file))
            throw new RootOperationError('history_changed'); }, auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
    }
    return rootEvent.parse(JSON.parse(record.line));
}
/** The lock and exact prefix/identity prove that a dead writer's reserved suffix may be repaired. */
export async function repairRootOperation(path, handle, record, budget) {
    if (record.state !== 'planned' || record.archive || await checkedIdentity(handle, path) !== record.identity)
        throw new RootOperationError('target_changed');
    const stat = await handle.stat(), bytes = Buffer.from(record.line);
    if (stat.size < record.offset || await rootOperationPrefixHash(handle, record.offset, budget) !== record.prefixHash)
        throw new RootOperationError('prefix_changed');
    if (stat.size >= record.offset + bytes.length) {
        if (!(await readBytes(handle, bytes.length, budget, record.offset)).equals(bytes))
            throw new RootOperationError('suffix_changed');
        return false;
    }
    const suffix = await readBytes(handle, stat.size - record.offset, budget, record.offset);
    if (!bytes.subarray(0, suffix.length).equals(suffix))
        throw new RootOperationError('suffix_changed');
    budget.check();
    if (suffix.length) {
        await handle.truncate(record.offset);
        await handle.sync();
    }
    return true;
}