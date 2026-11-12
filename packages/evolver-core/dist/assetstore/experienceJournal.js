import { AuditBudget, withAuditLock } from '../events/boundedAudit.js';
import { assertNoExperienceTransaction } from './assetStoreStorage.js';
import { randomUUID, createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, ftruncateSync, openSync, readSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bytesDigest, journalDigest, journalFileIdentity, journalParentIdentity, journalWitnessPath, stableJson, sqliteTransaction, withDurableJournal } from '../util/durableJournal.js';
import { appendUtf8Durable, assertAssetStoreDirectory, assertOpenedRegularAssetFile, assertOptionalRegularFile, createBufferDurableExclusive, ensureAssetStoreDirectory, EXPERIENCE_BUNDLE_SCHEMA, fsyncDirectoryBestEffort, readRegularBuffer, readUtf8Regular, replaceUtf8Durable, withAssetStoreLock } from './assetStoreStorage.js';
const FILE = 'experience-operations.sqlite';
const MAX_OPERATIONS = 4096;
const MAX_METADATA = 256 * 1024;
const limits = { 'genes.jsonl': 16 * 1024 * 1024, 'review.jsonl': 16 * 1024 * 1024, 'experience-sources.jsonl': 32 * 1024 * 1024,
    'experience-evidence.jsonl': 32 * 1024 * 1024, 'anti-genes.jsonl': 16 * 1024 * 1024 };
const MAX_MUTATIONS = Object.keys(limits).length;
/** One participant per file: each participant is verified as exactly one append, so rows for the same file share it. */
function rowsByFile(mutations) {
    const grouped = new Map();
    for (const { file, row } of mutations)
        grouped.set(file, [...(grouped.get(file) ?? []), row]);
    return [...grouped];
}
export class ExperienceJournalError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const error = (code) => { throw new ExperienceJournalError(code); };
function initialize(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS experience_operations (operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
    state TEXT NOT NULL, prepared TEXT NOT NULL, receipt TEXT, receipt_hash TEXT, completion TEXT NOT NULL DEFAULT 'pending', audit_receipt TEXT);
    CREATE TABLE IF NOT EXISTS experience_sequence (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
    INSERT OR IGNORE INTO experience_sequence VALUES(1,0);`);
}
function boundedJson(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_METADATA)
        return error('EXPERIENCE_JOURNAL_INVALID');
    return JSON.parse(raw);
}
function operation(row) {
    const state = row['state'];
    if (!['reserved', 'prepared', 'committed', 'aborted', 'recovery_unknown'].includes(String(state)))
        return error('EXPERIENCE_JOURNAL_INVALID');
    const commit = row['receipt'] === null ? undefined : boundedJson(row['receipt']);
    if (!/^[a-f0-9-]{36}$/.test(String(row['operation_id'])) || !/^[a-f0-9]{64}$/.test(String(row['request_hash']))
        || !['pending', 'acknowledged'].includes(String(row['completion'])))
        return error('EXPERIENCE_JOURNAL_INVALID');
    if ((state === 'committed') !== !!commit || commit && journalDigest(commit) !== row['receipt_hash'])
        return error('EXPERIENCE_JOURNAL_INVALID');
    if (commit && (commit.operationId !== row['operation_id'] || commit.requestHash !== row['request_hash']
        || !/^[a-f0-9]{64}$/.test(commit.namespace) || !/^[a-f0-9-]{36}$/.test(commit.commitId)
        || !Number.isSafeInteger(commit.commitSequence) || commit.commitSequence < 1))
        return error('EXPERIENCE_JOURNAL_INVALID');
    return { operationId: String(row['operation_id']), requestHash: String(row['request_hash']), state: state,
        completion: row['completion'] === 'acknowledged' ? 'acknowledged' : 'pending', ...(commit ? { commit } : {}) };
}
/** Business commit authority. JSONL mirrors are fenced until the immutable receipt + outbox commit. */
export class ExperienceJournal {
    baseDir;
    path;
    marker;
    constructor(baseDir) { this.baseDir = resolve(baseDir); this.path = join(this.baseDir, FILE); this.marker = join(this.baseDir, '.assetstore-bundle.json'); }
    use(write, run) {
        return withDurableJournal(this.path, 'experience-operations-v1', write, db => {
            if (write)
                initialize(db);
            else if (!db.prepare("SELECT name FROM sqlite_schema WHERE name='experience_operations'").get())
                return undefined;
            return run(db);
        });
    }
    lookup(id, hash) {
        return this.use(false, db => {
            const row = db.prepare('SELECT * FROM experience_operations WHERE operation_id=?').get(id);
            if (!row)
                return undefined;
            if (hash !== undefined && hash !== row['request_hash'])
                return error('OPERATION_REUSED');
            return operation(row);
        });
    }
    status(limit = 50, after = 0) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(after) || after < 0)
            return error('INPUT_INVALID');
        return this.use(false, db => db.prepare('SELECT * FROM experience_operations ORDER BY rowid LIMIT ? OFFSET ?').all(limit, after).map(operation)) ?? [];
    }
    async outbox(deadlineAt, run) {
        const budget = new AuditBudget({ deadlineAt }, 'experience');
        budget.check();
        if (assertOptionalRegularFile(this.path) === null) {
            if (assertOptionalRegularFile(journalWitnessPath(this.path), 'temp_file') !== null)
                return error('EXPERIENCE_RECOVERY_UNKNOWN');
            return undefined;
        }
        return withAuditLock(join(this.baseDir, '.assetstore.lock'), budget, async () => {
            budget.check();
            assertNoExperienceTransaction(this.baseDir);
            // Writable, existing-only admission also settles any interrupted ack.
            return this.use(true, db => { budget.check(); return run(db, budget); });
        });
    }
    async recoveryStatus(limit = 100, deadlineAt = Date.now() + 30_000) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            return error('INPUT_INVALID');
        return await this.outbox(deadlineAt, db => db.prepare('SELECT * FROM experience_operations ORDER BY rowid LIMIT ?').all(limit).map(operation)) ?? [];
    }
    hasCommitForAsset(assetId) {
        return this.use(false, db => !!db.prepare("SELECT operation_id FROM experience_operations WHERE state='committed' AND json_extract(receipt,'$.assetId')=? AND json_extract(receipt,'$.action')!='recover-source' LIMIT 1").get(assetId)) ?? false;
    }
    async pending(limit = 32, deadlineAt = Date.now() + 30_000) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            return error('INPUT_INVALID');
        return await this.outbox(deadlineAt, db => db.prepare("SELECT * FROM experience_operations WHERE state='committed' AND completion='pending' ORDER BY json_extract(receipt,'$.commitSequence') LIMIT ?")
            .all(limit).map(row => operation(row).commit)) ?? [];
    }
    async backlog(operationId, deadlineAt = Date.now() + 30_000) {
        return await this.outbox(deadlineAt, db => {
            const totalPending = Number(db.prepare("SELECT count(*) AS n FROM experience_operations WHERE state='committed' AND completion='pending'").get()?.['n']);
            const next = db.prepare("SELECT operation_id FROM experience_operations WHERE state='committed' AND completion='pending' ORDER BY json_extract(receipt,'$.commitSequence') LIMIT 1").get();
            const row = operationId ? db.prepare('SELECT * FROM experience_operations WHERE operation_id=?').get(operationId) : undefined;
            const remaining = operationId ? Number(!!row && operation(row).state === 'committed' && row['completion'] === 'pending') : totalPending;
            return { remaining, totalPending, ...(next ? { nextOperationId: String(next['operation_id']) } : {}) };
        }) ?? { remaining: 0, totalPending: 0 };
    }
    async acknowledge(commit, receipt, deadlineAt = Date.now() + 30_000) {
        if (assertOptionalRegularFile(this.path) === null)
            return error('EXPERIENCE_RECOVERY_UNKNOWN');
        await this.outbox(deadlineAt, (db, budget) => sqliteTransaction(db, () => {
            const row = db.prepare('SELECT * FROM experience_operations WHERE operation_id=?').get(commit.operationId);
            if (!row || stableJson(operation(row).commit) !== stableJson(commit))
                return error('EXPERIENCE_COMMIT_CHANGED');
            budget.check();
            db.prepare("UPDATE experience_operations SET completion='acknowledged', audit_receipt=? WHERE operation_id=?").run(stableJson(receipt), commit.operationId);
        }));
    }
    namespace() { return journalDigest({ parent: journalParentIdentity(this.path), journal: journalFileIdentity(this.path) }); }
    manifest() {
        const raw = readUtf8Regular(this.marker, 4 * 1024 * 1024);
        if (raw === null)
            return undefined;
        const value = JSON.parse(raw);
        if (value.schema !== EXPERIENCE_BUNDLE_SCHEMA)
            return error('ASSET_BUNDLE_RECOVERY_REQUIRED');
        if (!Array.isArray(value.mutations) || value.mutations.length > MAX_MUTATIONS || value.namespace !== this.namespace())
            return error('EXPERIENCE_RECOVERY_UNKNOWN');
        for (const m of value.mutations) {
            if (!Object.hasOwn(limits, m.file) || typeof m.append !== 'string' || Buffer.byteLength(m.append) > MAX_METADATA
                || !Number.isSafeInteger(m.beforeBytes) || m.beforeBytes < 0 || m.beforeBytes > limits[m.file]
                || typeof m.identity !== 'string' || !/^[a-f0-9]{64}$/.test(m.beforeHash))
                return error('EXPERIENCE_RECOVERY_UNKNOWN');
        }
        const row = this.use(false, db => db.prepare('SELECT prepared FROM experience_operations WHERE operation_id=? AND request_hash=?').get(value.operationId, value.requestHash));
        if (!row || stableJson(boundedJson(row['prepared'])) !== stableJson(value))
            return error('EXPERIENCE_RECOVERY_UNKNOWN');
        return value;
    }
    verifyMutation(m, complete) {
        const path = join(this.baseDir, m.file);
        if (journalFileIdentity(path) !== m.identity)
            return error('EXPERIENCE_RECOVERY_UNKNOWN');
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            assertOpenedRegularAssetFile(fd, path);
            const stat = fstatSync(fd, { bigint: true }), size = Number(stat.size), suffix = Buffer.from(m.append);
            if (`${stat.dev}:${stat.ino}:${stat.birthtimeNs}` !== m.identity || size < m.beforeBytes || size > limits[m.file]
                || size > m.beforeBytes + suffix.length || complete && size !== m.beforeBytes + suffix.length)
                return error('EXPERIENCE_RECOVERY_UNKNOWN');
            const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
            let offset = 0;
            while (offset < size) {
                const wanted = Math.min(buffer.length, size - offset);
                const read = readSync(fd, buffer, 0, wanted, offset);
                if (!read)
                    return error('EXPERIENCE_RECOVERY_UNKNOWN');
                const prefix = Math.max(0, Math.min(read, m.beforeBytes - offset));
                if (prefix)
                    hash.update(buffer.subarray(0, prefix));
                if (prefix < read && !buffer.subarray(prefix, read).equals(suffix.subarray(offset + prefix - m.beforeBytes, offset + read - m.beforeBytes)))
                    return error('EXPERIENCE_RECOVERY_UNKNOWN');
                offset += read;
            }
            assertOpenedRegularAssetFile(fd, path);
            if (hash.digest('hex') !== m.beforeHash || fstatSync(fd).size !== size || journalFileIdentity(path) !== m.identity)
                return error('EXPERIENCE_RECOVERY_UNKNOWN');
        }
        finally {
            closeSync(fd);
        }
    }
    cleanup(manifest) {
        if (stableJson(this.manifest()) !== stableJson(manifest))
            return error('EXPERIENCE_RECOVERY_UNKNOWN');
        unlinkSync(this.marker);
        fsyncDirectoryBestEffort(this.baseDir);
    }
    recoverUnderLock() {
        // A readonly SELECT cannot settle a hot rollback journal. Validate and open
        // the existing authority writable before reading any prepared/receipt data.
        if (assertOptionalRegularFile(this.path) !== null)
            this.use(true, () => undefined);
        const manifest = this.manifest();
        if (!manifest)
            return 'none';
        const saved = this.lookup(manifest.operationId, manifest.requestHash);
        if (saved.state === 'committed') {
            for (const m of manifest.mutations)
                this.verifyMutation(m, true);
            this.cleanup(manifest);
            return 'committed';
        }
        if (!['reserved', 'prepared', 'aborted'].includes(saved.state))
            return error('EXPERIENCE_RECOVERY_UNKNOWN');
        try {
            // Check every participant before rolling back any; partial rollback remains idempotent.
            for (const m of manifest.mutations)
                this.verifyMutation(m, false);
            for (const m of [...manifest.mutations].reverse()) {
                const path = join(this.baseDir, m.file);
                this.verifyMutation(m, false);
                const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
                try {
                    assertOpenedRegularAssetFile(fd, path);
                    if (journalFileIdentity(path) !== m.identity)
                        return error('EXPERIENCE_RECOVERY_UNKNOWN');
                    ftruncateSync(fd, m.beforeBytes);
                    fsyncSync(fd);
                }
                finally {
                    closeSync(fd);
                }
            }
            this.use(true, db => db.prepare("UPDATE experience_operations SET state='aborted' WHERE operation_id=? AND state IN ('reserved','prepared','aborted')").run(manifest.operationId));
            this.cleanup(manifest);
            return 'aborted';
        }
        catch (cause) {
            if (cause instanceof ExperienceJournalError && cause.code === 'EXPERIENCE_RECOVERY_UNKNOWN')
                this.use(true, db => db.prepare("UPDATE experience_operations SET state='recovery_unknown' WHERE operation_id=? AND state!='committed'").run(manifest.operationId));
            throw cause;
        }
    }
    async recoverBusiness(deadlineAt = Date.now() + 30_000) {
        const budget = new AuditBudget({ deadlineAt }, 'experience');
        budget.check();
        const marker = assertOptionalRegularFile(this.marker, 'temp_file');
        if (marker === null && assertOptionalRegularFile(this.path) === null) {
            const hasWitness = assertOptionalRegularFile(journalWitnessPath(this.path), 'temp_file') !== null;
            // Refusal only, never a commit inference: versioned sidecar identities cannot be adopted into a new empty authority.
            for (const [file, maximum] of [['review.jsonl', 16 * 1024 * 1024], ['experience-sources.jsonl', 32 * 1024 * 1024], ['experience-evidence.jsonl', 32 * 1024 * 1024]]) {
                budget.check();
                const raw = readRegularBuffer(join(this.baseDir, file), maximum, () => budget.check())?.toString('utf8');
                if (raw && /"operationId"\s*:\s*"[a-f0-9-]{36}"/.test(raw))
                    return error('EXPERIENCE_RECOVERY_UNKNOWN');
            }
            if (hasWitness) {
                try {
                    await withAuditLock(join(this.baseDir, '.assetstore.lock'), budget, async () => { budget.check(); this.use(true, () => undefined); });
                }
                catch {
                    return error('EXPERIENCE_RECOVERY_UNKNOWN');
                }
            }
            return 'none';
        }
        assertAssetStoreDirectory(this.baseDir);
        return withAuditLock(join(this.baseDir, '.assetstore.lock'), budget, async () => {
            budget.check();
            if (assertOptionalRegularFile(this.marker, 'temp_file') !== null)
                return this.recoverUnderLock();
            this.use(true, db => {
                if (db.prepare("SELECT operation_id FROM experience_operations WHERE state='prepared' LIMIT 1").get())
                    return error('EXPERIENCE_RECOVERY_UNKNOWN');
                db.prepare("UPDATE experience_operations SET state='aborted' WHERE state='reserved'").run();
            });
            return 'none';
        });
    }
    commit(id, hash, prepare, now, checkpoint) {
        ensureAssetStoreDirectory(this.baseDir);
        const referenceDir = join(this.baseDir, 'references');
        ensureAssetStoreDirectory(referenceDir);
        // Match legacy bundle recovery's asset -> reference lock order; normalization uses the frozen read scope.
        return withAssetStoreLock(join(this.baseDir, '.assetstore.lock'), () => withAssetStoreLock(join(referenceDir, '.reference.lock'), () => {
            this.recoverUnderLock();
            const known = this.lookup(id, hash);
            if (known?.commit)
                return known.commit;
            if (known)
                return error(known.state === 'aborted' ? 'OPERATION_ABORTED' : 'EXPERIENCE_RECOVERY_UNKNOWN');
            const prepared = prepare();
            this.use(true, db => { if (Number(db.prepare('SELECT count(*) AS n FROM experience_operations').get()?.['n']) >= MAX_OPERATIONS)
                return error('EXPERIENCE_JOURNAL_CAPACITY'); });
            const mutations = rowsByFile(prepared.mutations).map(([file, rows]) => {
                if (!Object.hasOwn(limits, file))
                    return error('EXPERIENCE_JOURNAL_INVALID');
                const path = join(this.baseDir, file);
                const raw = readRegularBuffer(path, limits[file]) ?? Buffer.alloc(0);
                const append = `${raw.length && raw.at(-1) !== 10 ? '\n' : ''}${rows.map((row) => `${JSON.stringify(row)}\n`).join('')}`;
                if (raw.length + Buffer.byteLength(append) > limits[file])
                    return error('EXPERIENCE_WRITE_CAPACITY');
                if (assertOptionalRegularFile(path) === null)
                    createBufferDurableExclusive(path, Buffer.alloc(0));
                return { file, identity: journalFileIdentity(path), beforeBytes: raw.length, beforeHash: bytesDigest(raw), append };
            });
            const manifest = { schema: EXPERIENCE_BUNDLE_SCHEMA, operationId: id, requestHash: hash, namespace: this.namespace(), mutations };
            const body = stableJson(manifest);
            if (Buffer.byteLength(body) > MAX_METADATA || mutations.some((m) => Buffer.byteLength(m.append) > MAX_METADATA))
                return error('EXPERIENCE_JOURNAL_CAPACITY');
            this.use(true, db => sqliteTransaction(db, () => db.prepare("INSERT INTO experience_operations(operation_id,request_hash,state,prepared) VALUES(?,?,'reserved',?)").run(id, hash, body)));
            try {
                replaceUtf8Durable(this.marker, `${body}\n`);
                this.use(true, db => db.prepare("UPDATE experience_operations SET state='prepared' WHERE operation_id=? AND state='reserved'").run(id));
                checkpoint?.('prepared');
                for (const m of mutations) {
                    this.verifyMutation(m, false);
                    appendUtf8Durable(join(this.baseDir, m.file), m.append.startsWith('\n') ? m.append.slice(1) : m.append);
                    this.verifyMutation(m, true);
                    checkpoint?.(`written:${m.file}`);
                }
                checkpoint?.('before_commit');
                const receipt = this.use(true, db => sqliteTransaction(db, () => {
                    const currentSequence = Number(db.prepare('SELECT value FROM experience_sequence WHERE id=1').get()?.['value']);
                    const maximum = Number(db.prepare("SELECT coalesce(max(json_extract(receipt,'$.commitSequence')),0) AS n FROM experience_operations WHERE state='committed'").get()?.['n']);
                    if (currentSequence !== maximum)
                        return error('EXPERIENCE_JOURNAL_INVALID');
                    const sequence = currentSequence + 1;
                    if (!Number.isSafeInteger(sequence))
                        return error('EXPERIENCE_JOURNAL_CAPACITY');
                    const commit = { ...prepared.result, operationId: id, requestHash: hash, namespace: manifest.namespace,
                        commitId: randomUUID(), commitSequence: sequence, committedAt: new Date(now()).toISOString() };
                    db.prepare('UPDATE experience_sequence SET value=? WHERE id=1').run(sequence);
                    db.prepare("UPDATE experience_operations SET state='committed', receipt=?, receipt_hash=? WHERE operation_id=? AND state='prepared'").run(stableJson(commit), journalDigest(commit), id);
                    checkpoint?.('mid_commit');
                    return commit;
                }));
                checkpoint?.('committed');
                this.cleanup(manifest);
                return receipt;
            }
            catch (cause) {
                // A COMMIT/close error may follow an actual commit. Existing journal identity decides, never the throw.
                const saved = this.lookup(id, hash);
                if (saved?.commit)
                    throw new ExperienceJournalError('EXPERIENCE_CLEANUP_PENDING');
                try {
                    this.recoverUnderLock();
                }
                catch {
                    throw new ExperienceJournalError('EXPERIENCE_RECOVERY_UNKNOWN');
                }
                throw cause;
            }
        }), { experienceRecovery: true });
    }
}