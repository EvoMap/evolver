import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { AuditBudget, withAuditLock } from './boundedAudit.js';
import { rootEventArchiveDir } from './eventArchive.js';
import { assertOpenedRegularAssetFile, assertOptionalRegularFile, createBufferDurableExclusive } from '../assetstore/assetStoreStorage.js';
import { bytesDigest, journalDigest, journalFileIdentity, journalParentIdentity, journalWitnessPath, stableJson, sqliteTransaction, withDurableJournal } from '../util/durableJournal.js';
import { rootEvent } from './eventSchema.js';
const makeId = monotonicFactory();
const suffix = '.experience-audit.sqlite';
const MAX_ROWS = 4096;
export function isExperienceAuditKey(value) {
    return value !== undefined && /^experience-(?:request|completion|recovery)-[a-f0-9]{64}$/.test(value);
}
const retainedFiles = new Map();
const descriptorIdentity = (fd) => {
    const stat = fstatSync(fd, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
};
function retryFileCleanup(path) {
    const owner = retainedFiles.get(path);
    if (!owner)
        return;
    try {
        if (descriptorIdentity(owner.fd) !== owner.identity)
            return fail('EXPERIENCE_AUDIT_CLEANUP_UNKNOWN');
        closeSync(owner.fd);
        retainedFiles.delete(path);
    }
    catch (cause) {
        if (cause?.code === 'EBADF') {
            retainedFiles.delete(path);
            return;
        }
        throw cause;
    }
}
function ownedFile(ownerPath, target, flags, run) {
    retryFileCleanup(ownerPath);
    if (retainedFiles.size >= 64)
        return fail('EXPERIENCE_AUDIT_CLEANUP_CAPACITY');
    const identity = journalFileIdentity(target);
    const fd = openSync(target, flags | (constants.O_NOFOLLOW ?? 0));
    let result, failure, failed = false;
    try {
        if (descriptorIdentity(fd) !== identity)
            return fail('EXPERIENCE_AUDIT_UNKNOWN');
        result = run(fd);
    }
    catch (cause) {
        failed = true;
        failure = cause;
    }
    try {
        closeSync(fd);
    }
    catch (cause) {
        retainedFiles.set(ownerPath, { fd, identity });
        if (!failed) {
            failed = true;
            failure = cause;
        }
    }
    if (failed)
        throw failure;
    return result;
}
export class ExperienceAuditError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const fail = (code = 'EXPERIENCE_AUDIT_UNKNOWN') => { throw new ExperienceAuditError(code); };
function database(path, write, run) {
    return withDurableJournal(`${path}${suffix}`, 'experience-audit-v1', write, db => {
        if (write)
            db.exec(`CREATE TABLE IF NOT EXISTS experience_audit (key TEXT PRIMARY KEY, hash TEXT NOT NULL,
      state TEXT NOT NULL, line TEXT NOT NULL, locator TEXT NOT NULL, previous TEXT, prefix TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS experience_audit_pending ON experience_audit(state) WHERE state='planned';
      CREATE TABLE IF NOT EXISTS experience_audit_pairs (operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
        request_key TEXT NOT NULL UNIQUE, completion_key TEXT UNIQUE);`);
        else if (!db.prepare("SELECT name FROM sqlite_schema WHERE name='experience_audit'").get())
            return undefined;
        return run(db);
    });
}
function projection(row) {
    const line = row['line'];
    if (typeof line !== 'string' || Buffer.byteLength(line) > 4096 || !line.endsWith('\n'))
        return fail();
    const event = rootEvent.parse(JSON.parse(line));
    if (event.auditOperationId !== row['key'] || event.auditRequestHash !== row['hash'])
        return fail();
    const snapshot = snapshotExperienceAuditV1({ type: event.type, payload: event.payload, actor: event.actor, human: event.human });
    if (journalDigest(snapshot) !== row['hash'] || `${JSON.stringify(event)}\n` !== line)
        return fail();
    const locator = (value) => {
        if (typeof value !== 'string' || value.length > 2048)
            return fail();
        const p = JSON.parse(value);
        if (!Number.isSafeInteger(p.offset) || p.offset < 0 || typeof p.identity !== 'string'
            || (p.archive !== undefined && !/^root-events-\d{16}-\d{16}\.jsonl$/.test(p.archive)))
            return fail();
        return p;
    };
    return { key: String(row['key']), hash: String(row['hash']), state: String(row['state']), line,
        locator: locator(row['locator']), ...(row['previous'] === null ? {} : { previous: locator(row['previous']) }), prefix: String(row['prefix']) };
}
function readAt(fd, offset, length) {
    const data = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
        const n = readSync(fd, data, read, length - read, offset + read);
        if (!n)
            return fail();
        read += n;
    }
    return data;
}
function locationPath(path, locator) {
    if (!locator.archive)
        return path;
    return join(rootEventArchiveDir(path), locator.archive);
}
function settle(path, saved, check = () => undefined) {
    for (const locator of [saved.locator, ...(saved.previous ? [saved.previous] : [])]) {
        check();
        const target = locationPath(path, locator);
        if (assertOptionalRegularFile(target) === null || journalFileIdentity(target) !== locator.identity)
            continue;
        const result = ownedFile(path, target, constants.O_RDWR | constants.O_APPEND, fd => {
            assertOpenedRegularAssetFile(fd, target);
            const size = fstatSync(fd).size, line = Buffer.from(saved.line);
            if (size < locator.offset)
                return undefined;
            const count = Math.min(line.length, size - locator.offset);
            if (!readAt(fd, locator.offset, count).equals(line.subarray(0, count)))
                return undefined;
            if (count < line.length) {
                // Only a planned reservation at the exact current tail may finish its own prefix.
                // All supported append/recover/archive paths settle reservations before progressing.
                if (saved.state !== 'planned' || locator.archive || size !== locator.offset + count)
                    return undefined;
                const start = Math.max(0, locator.offset - 8192);
                if (bytesDigest(readAt(fd, start, locator.offset - start)) !== saved.prefix)
                    return undefined;
                check();
                let at = count;
                // Once dispatched, finish and sync this original exact slot. Expiry must
                // not detach a submitted writer or substitute a second envelope.
                while (at < line.length) {
                    const n = writeSync(fd, line, at, line.length - at);
                    if (n <= 0)
                        return fail();
                    at += n;
                }
            }
            fsyncSync(fd);
            assertOpenedRegularAssetFile(fd, target);
            if (journalFileIdentity(target) !== locator.identity)
                return fail();
            database(path, true, db => db.prepare("UPDATE experience_audit SET state='projected' WHERE key=? AND hash=?").run(saved.key, saved.hash));
            return rootEvent.parse(JSON.parse(saved.line));
        });
        if (result)
            return result;
    }
    return fail();
}
/** Called with the root lock held, including by ordinary append, truncate recovery and archive. */
export function recoverExperienceAuditUnderLock(path, check = () => undefined) {
    check();
    retryFileCleanup(path);
    if (assertOptionalRegularFile(`${path}${suffix}`) === null) {
        if (assertOptionalRegularFile(journalWitnessPath(`${path}${suffix}`), 'temp_file') !== null)
            return fail();
        return;
    }
    const pending = database(path, true, db => db.prepare("SELECT * FROM experience_audit WHERE state='planned' ORDER BY rowid LIMIT ?").all(MAX_ROWS).map(projection)) ?? [];
    for (const row of pending)
        settle(path, row, check);
}
export function snapshotExperienceAuditV1(raw) {
    try {
        const encoded = JSON.stringify(raw);
        if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 4096)
            return fail('EXPERIENCE_AUDIT_INVALID');
        raw = JSON.parse(encoded);
    }
    catch {
        return fail('EXPERIENCE_AUDIT_INVALID');
    }
    const p = raw.payload;
    const common = ['assetId', 'operationId', 'action', 'source', 'sourceVerified', 'phase', 'requestHash'];
    const committed = ['state', 'namespace', 'commitId', 'commitSequence', 'committedAt', 'evidenceDigest'];
    if (!p || p['source'] !== 'experience-library' || p['sourceVerified'] !== false
        || typeof p['assetId'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(p['assetId'])
        || typeof p['operationId'] !== 'string' || !/^[a-f0-9-]{36}$/.test(p['operationId'])
        || typeof p['requestHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(p['requestHash'])
        || !['capture', 'approve', 'pause', 'resume', 'remove', 'recover-source'].includes(String(p['action']))
        || !['requested', 'committed'].includes(String(p['phase'])))
        return fail('EXPERIENCE_AUDIT_INVALID');
    const completion = p['phase'] === 'committed';
    if (Object.keys(p).some(key => ![...common, ...(completion ? committed : [])].includes(key)))
        return fail('EXPERIENCE_AUDIT_INVALID');
    const type = !completion ? 'experience.operation.requested' : p['action'] === 'recover-source' ? 'experience.source.recovered'
        : p['action'] === 'capture' ? 'actor.human.teach' : ['approve', 'resume'].includes(String(p['action'])) ? 'actor.human.review.approve' : 'actor.human.review.reject';
    if (raw.type !== type || raw.actor?.kind !== 'human' || !raw.actor.id || raw.human.detail !== undefined || raw.human.why !== undefined)
        return fail('EXPERIENCE_AUDIT_INVALID');
    if (completion && (typeof p['namespace'] !== 'string' || !/^[a-f0-9]{64}$/.test(p['namespace'])
        || typeof p['commitId'] !== 'string' || !/^[a-f0-9-]{36}$/.test(p['commitId'])
        || !Number.isSafeInteger(p['commitSequence']) || Number(p['commitSequence']) < 1
        || typeof p['committedAt'] !== 'string' || Number.isNaN(Date.parse(p['committedAt']))
        || typeof p['evidenceDigest'] !== 'string' || !/^[a-f0-9]{64}$/.test(p['evidenceDigest'])
        || !['pending', 'untrusted', 'active', 'paused', 'removed', 'detached'].includes(String(p['state']))))
        return fail('EXPERIENCE_AUDIT_INVALID');
    const states = { capture: ['pending', 'untrusted'], approve: ['active'], resume: ['active'], pause: ['paused'], remove: ['removed'], 'recover-source': ['detached'] };
    if (completion && !states[String(p['action'])]?.includes(String(p['state'])))
        return fail('EXPERIENCE_AUDIT_INVALID');
    return JSON.parse(JSON.stringify({ type, payload: p, actor: { kind: 'human', id: raw.actor.id }, human: { title: raw.human.title, severity: raw.human.severity ?? 'info' } }));
}
/** Versioned, exact-slot projection. It never uses a history search to certify non-commit. */
export async function appendExperienceAudit(path, raw, key, options) {
    if (!/^experience-(?:request|completion|recovery)-[a-f0-9]{64}$/.test(key))
        return fail('EXPERIENCE_AUDIT_ID_INVALID');
    const snapshot = snapshotExperienceAuditV1(raw), hash = journalDigest(snapshot);
    const payload = snapshot.payload;
    const phase = payload.phase === 'requested' ? 'request' : 'completion';
    if (!key.startsWith(`experience-${phase}-`) || raw.auditOperationId !== undefined || raw.auditRequestHash !== undefined
        || raw.experienceAuditNamespace !== undefined)
        return fail('EXPERIENCE_AUDIT_ID_INVALID');
    if (options.expectedNamespace !== undefined && !/^[a-f0-9]{64}$/.test(options.expectedNamespace))
        return fail('EXPERIENCE_AUDIT_UNKNOWN');
    const budget = new AuditBudget({ deadlineAt: options.deadlineAt }, 'experience');
    return withAuditLock(`${path}.lock`, budget, async () => {
        const check = () => budget.check();
        check();
        options.validate?.();
        const present = assertOptionalRegularFile(`${path}${suffix}`) !== null;
        if (!present && options.expectedNamespace !== undefined)
            return fail('EXPERIENCE_AUDIT_NAMESPACE_CHANGED');
        // Capacity and cooperative parsing precede namespace creation. This is an
        // authority-loss refusal check, never an exactly-once replay search.
        if (!present) {
            options.capacity(0);
            options.assertHistory(check);
            if (assertOptionalRegularFile(journalWitnessPath(`${path}${suffix}`)) !== null)
                database(path, true, () => undefined);
        }
        recoverExperienceAuditUnderLock(path, check);
        if (present)
            options.assertHistory(check);
        check();
        const prior = database(path, false, db => db.prepare('SELECT * FROM experience_audit WHERE key=?').get(key));
        if (prior && prior['hash'] !== hash)
            return fail('OPERATION_REUSED');
        database(path, true, () => undefined);
        const namespace = journalDigest({ parent: journalParentIdentity(`${path}${suffix}`), journal: journalFileIdentity(`${path}${suffix}`) });
        if (options.expectedNamespace !== undefined && namespace !== options.expectedNamespace)
            return fail('EXPERIENCE_AUDIT_NAMESPACE_CHANGED');
        if (prior)
            return settle(path, projection(prior), check);
        const capacity = database(path, false, db => {
            const count = Number(db.prepare('SELECT count(*) AS n FROM experience_audit').get()?.['n']);
            const reserved = Number(db.prepare('SELECT count(*) AS n FROM experience_audit_pairs WHERE completion_key IS NULL').get()?.['n']);
            const pair = db.prepare('SELECT * FROM experience_audit_pairs WHERE operation_id=?').get(payload.operationId);
            if (pair && pair['request_hash'] !== payload.requestHash)
                return fail('OPERATION_REUSED');
            if (phase === 'request' && pair || phase === 'completion' && (!pair || pair['completion_key'] !== null))
                return fail('EXPERIENCE_AUDIT_PAIR_INVALID');
            if (count + reserved + (phase === 'request' ? 2 : 0) > MAX_ROWS)
                return fail('EXPERIENCE_AUDIT_CAPACITY');
        });
        void capacity;
        if (assertOptionalRegularFile(path) === null) {
            createBufferDurableExclusive(path, Buffer.alloc(0));
            options.created?.();
        }
        let offset = 0, prefix = '', seq = 0;
        ownedFile(path, path, constants.O_RDONLY, fd => {
            assertOpenedRegularAssetFile(fd, path);
            offset = fstatSync(fd).size;
            if (offset > options.maxFileBytes)
                return fail('EXPERIENCE_AUDIT_CAPACITY');
            const tail = readAt(fd, Math.max(0, offset - 8192), Math.min(8192, offset));
            prefix = bytesDigest(tail);
            if (offset && tail.at(-1) !== 10)
                return fail('EXPERIENCE_AUDIT_UNKNOWN');
            seq = offset ? rootEvent.parse(JSON.parse(tail.toString('utf8').trimEnd().split('\n').at(-1))).seq : options.lastSeq();
        });
        if (!Number.isSafeInteger(seq) || seq >= Number.MAX_SAFE_INTEGER)
            return fail();
        const event = rootEvent.parse({ ...snapshot, seq: seq + 1, eventId: makeId(), ts: new Date().toISOString(),
            auditOperationId: key, auditRequestHash: hash, experienceAuditNamespace: namespace });
        const line = `${JSON.stringify(event)}\n`;
        if (Buffer.byteLength(line) > 4096 || offset + Buffer.byteLength(line) > options.maxFileBytes)
            return fail('EXPERIENCE_AUDIT_CAPACITY');
        options.capacity(Buffer.byteLength(line));
        const locator = { identity: journalFileIdentity(path), offset };
        check();
        options.validate?.();
        // Pair capacity and the exact request slot become durable in the same FULL
        // transaction. Aborted requests retain their reservation and replay identity.
        database(path, true, db => sqliteTransaction(db, () => {
            if (phase === 'request')
                db.prepare('INSERT INTO experience_audit_pairs VALUES(?,?,?,NULL)').run(payload.operationId, payload.requestHash, key);
            else
                db.prepare('UPDATE experience_audit_pairs SET completion_key=? WHERE operation_id=? AND completion_key IS NULL').run(key, payload.operationId);
            db.prepare("INSERT INTO experience_audit VALUES(?,?,'planned',?,?,NULL,?)").run(key, hash, line, stableJson(locator), prefix);
        }));
        return settle(path, { key, hash, state: 'planned', line, locator, prefix }, check);
    });
}
export function relocateExperienceAudit(path, locate) {
    if (assertOptionalRegularFile(`${path}${suffix}`) === null) {
        if (assertOptionalRegularFile(journalWitnessPath(`${path}${suffix}`), 'temp_file') !== null)
            return fail();
        return;
    }
    database(path, true, db => {
        const rows = db.prepare('SELECT * FROM experience_audit LIMIT ?').all(MAX_ROWS).map(projection);
        const moves = rows.map(saved => {
            const next = locate(saved.line);
            if (!next)
                return fail();
            let previous = saved.locator;
            const original = locationPath(path, previous);
            if ((assertOptionalRegularFile(original) === null || journalFileIdentity(original) !== previous.identity) && saved.previous)
                previous = saved.previous;
            return { saved, next, previous };
        });
        // Publish all locator moves before the archive rename, in one FULL commit.
        sqliteTransaction(db, () => {
            const update = db.prepare('UPDATE experience_audit SET locator=?, previous=? WHERE key=?');
            for (const { saved, next, previous } of moves)
                update.run(stableJson(next), stableJson(previous), saved.key);
        });
    });
}
export function experienceAuditKey(phase, namespace, operationId) {
    return `experience-${phase}-${journalDigest({ namespace, operationId })}`;
}