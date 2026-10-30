import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertOptionalRegularFile, captureRegularAssetFileIdentity, createBufferDurableExclusive, readUtf8Regular, replaceUtf8Durable } from '../assetstore/assetStoreStorage.js';
import { openSqliteDatabase } from './sqlite.js';
const MAX_BYTES = 32 * 1024 * 1024;
const retained = new Map();
export function stableJson(value) {
    const data = JSON.parse(JSON.stringify(value));
    const encode = (v, depth) => {
        if (depth > 32)
            throw new Error('journal_metadata_depth');
        if (v === null || typeof v !== 'object')
            return JSON.stringify(v);
        if (Array.isArray(v))
            return `[${v.map(x => encode(x, depth + 1)).join(',')}]`;
        return `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${encode(x, depth + 1)}`).join(',')}}`;
    };
    return encode(data, 0);
}
export const journalDigest = (value) => createHash('sha256').update(stableJson(value)).digest('hex');
export const bytesDigest = (value) => createHash('sha256').update(value).digest('hex');
export function journalFileIdentity(path) {
    const stat = assertOptionalRegularFile(path);
    if (!stat || stat.nlink !== 1)
        throw new Error('journal_file_untrusted');
    const identity = captureRegularAssetFileIdentity(path);
    return `${identity.dev}:${identity.ino}:${identity.birthtimeNs}`;
}
const physicalName = (path) => process.platform === 'win32' ? realpathSync.native(path) : realpathSync(path);
export function journalParentIdentity(path) {
    const parent = dirname(path), before = lstatSync(parent, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory())
        throw new Error('journal_parent_untrusted');
    const fd = openSync(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
        const opened = fstatSync(fd, { bigint: true }), after = lstatSync(parent, { bigint: true });
        // Node Windows pathname stats can omit the volume while Bun reports it. Use the actual directory descriptor for both.
        if (!opened.isDirectory() || after.isSymbolicLink() || !after.isDirectory()
            || before.ino !== opened.ino || after.ino !== opened.ino || before.birthtimeNs !== opened.birthtimeNs || after.birthtimeNs !== opened.birthtimeNs
            || (process.platform !== 'win32' || before.dev !== 0n) && before.dev !== opened.dev
            || (process.platform !== 'win32' || after.dev !== 0n) && after.dev !== opened.dev)
            throw new Error('journal_parent_untrusted');
        return `${physicalName(parent)}:${opened.dev}:${opened.ino}:${opened.birthtimeNs}`;
    }
    finally {
        closeSync(fd);
    }
}
export function sqliteTransaction(db, run) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const value = run();
        db.exec('COMMIT');
        return value;
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch { /* Retain the original transaction failure. */ }
        throw error;
    }
}
export const journalWitnessPath = (path) => `${path}.namespace.json`;
function witnessBytes(value) {
    const bytes = Buffer.from(`${stableJson(value)}\n`);
    if (bytes.length > 4096)
        throw new Error('journal_witness_capacity');
    return bytes;
}
function witness(path) {
    const stat = assertOptionalRegularFile(path, 'temp_file');
    if (!stat)
        return undefined;
    if (stat.nlink !== 1 || process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
        throw new Error('journal_witness_untrusted');
    const value = JSON.parse(readUtf8Regular(path, 4096));
    if (value?.schema !== 1 || typeof value.kind !== 'string' || typeof value.parent !== 'string'
        || typeof value.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(value.nonce)
        || !['initializing', 'ready'].includes(value.phase) || value.identity !== null && typeof value.identity !== 'string'
        || value.phase === 'ready' && !value.identity)
        throw new Error('journal_witness_untrusted');
    return value;
}
export const journalInitializationPending = (path) => witness(journalWitnessPath(path))?.phase === 'initializing';
function closeJournal(path, owner, failure) {
    try {
        owner.db.close();
    }
    catch (error) {
        retained.set(path, owner.db);
        if (failure)
            throw new AggregateError([failure.error, error], 'durable journal operation and close failed', { cause: failure.error });
        throw error;
    }
    if (failure)
        throw failure.error;
}
function openJournal(path, kind, write, options) {
    const previous = retained.get(path);
    if (previous) {
        previous.close();
        retained.delete(path);
    }
    if (retained.size >= 64) {
        for (const [name, owner] of retained) {
            try {
                owner.close();
                retained.delete(name);
            }
            catch { /* Retain the actual unresolved owner. */ }
            if (retained.size < 64)
                break;
        }
        if (retained.size >= 64)
            throw new Error('journal_cleanup_capacity');
    }
    const pointer = journalWitnessPath(path);
    let binding = witness(pointer), before = assertOptionalRegularFile(path);
    if (options.existingOnly && !before)
        throw new Error('journal_namespace_changed');
    if (!write && binding?.phase === 'initializing')
        throw new Error('journal_initialization_pending');
    if (!before && !binding && !write)
        return undefined;
    const parent = journalParentIdentity(path);
    if (binding && (binding.kind !== kind || binding.parent !== parent))
        throw new Error('journal_namespace_changed');
    if (!before && binding?.identity)
        throw new Error('journal_namespace_changed');
    if (!binding && !before && write) {
        binding = { schema: 1, kind, parent, nonce: randomUUID(), phase: 'initializing', identity: null };
        createBufferDurableExclusive(pointer, witnessBytes(binding));
    }
    if (!before) {
        if (!write)
            return undefined;
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        before = assertOptionalRegularFile(path);
    }
    if (before && before.size > MAX_BYTES)
        throw new Error('journal_file_untrusted');
    const identity = journalFileIdentity(path), canonical = physicalName(path);
    if (binding?.identity && binding.identity !== identity)
        throw new Error('journal_namespace_changed');
    for (const suffix of ['-journal', '-wal', '-shm']) {
        const stat = assertOptionalRegularFile(`${path}${suffix}`, 'temp_file');
        if (stat && stat.nlink !== 1)
            throw new Error('journal_sidecar_untrusted');
    }
    const db = openSqliteDatabase(path, { create: false, ...(!write ? { readOnly: true } : {}) });
    const owner = { db, check: () => {
            if (journalFileIdentity(path) !== identity || journalParentIdentity(path) !== parent)
                throw new Error('journal_namespace_changed');
            const namespace = db.prepare('SELECT kind,path,identity,parent,nonce FROM durable_namespace WHERE id=1').get();
            if (namespace?.['kind'] !== kind || namespace['path'] !== canonical || namespace['identity'] !== identity
                || namespace['parent'] !== parent || namespace['nonce'] !== binding?.nonce)
                throw new Error('journal_namespace_changed');
        } };
    try {
        db.exec('PRAGMA busy_timeout=0;');
        if (journalFileIdentity(path) !== identity || journalParentIdentity(path) !== parent)
            throw new Error('journal_namespace_changed');
        const schema = db.prepare("SELECT type FROM sqlite_schema WHERE name='durable_namespace'").get();
        if (schema && schema['type'] !== 'table')
            throw new Error('journal_schema_invalid');
        if (!schema) {
            if (!write && binding?.phase === 'initializing')
                throw new Error('journal_initialization_pending');
            if (!write || !binding || binding.phase !== 'initializing' || Number(db.prepare('SELECT count(*) AS n FROM sqlite_schema').get()?.['n']) !== 0)
                throw new Error('journal_schema_invalid');
            db.exec('PRAGMA synchronous=FULL; PRAGMA max_page_count=8192;');
            sqliteTransaction(db, () => {
                db.exec('CREATE TABLE durable_namespace (id INTEGER PRIMARY KEY CHECK(id=1), kind TEXT NOT NULL, path TEXT NOT NULL, identity TEXT NOT NULL, parent TEXT NOT NULL, nonce TEXT NOT NULL)');
                db.prepare('INSERT INTO durable_namespace VALUES(1,?,?,?,?,?)').run(kind, canonical, identity, parent, binding.nonce);
            });
        }
        const namespace = db.prepare('SELECT kind,path,identity,parent,nonce FROM durable_namespace WHERE id=1').get();
        if (namespace?.['kind'] !== kind || namespace['path'] !== canonical || namespace['identity'] !== identity
            || namespace['parent'] !== parent || typeof namespace['nonce'] !== 'string')
            throw new Error('journal_namespace_changed');
        // A lost pointer may be repaired only from the same, physically stamped existing database, never an empty replacement.
        if (!binding) {
            binding = { schema: 1, kind, parent, nonce: namespace['nonce'], phase: 'ready', identity };
            if (write)
                createBufferDurableExclusive(pointer, witnessBytes(binding));
        }
        else if (binding.nonce !== namespace['nonce'])
            throw new Error('journal_namespace_changed');
        if (write && binding.phase === 'initializing') {
            binding = { ...binding, phase: 'ready', identity };
            replaceUtf8Durable(pointer, witnessBytes(binding).toString('utf8'));
        }
        if (write)
            db.exec('PRAGMA synchronous=FULL; PRAGMA max_page_count=8192;');
        return owner;
    }
    catch (error) {
        closeJournal(path, owner, { error });
        throw error;
    }
}
/** Existing-only opens, a witnessed physical namespace, FULL durability and retained native cleanup.
 * The caller owns its filesystem lock; no operation data may precede namespace readiness. */
export function withDurableJournal(path, kind, write, run, options = {}) {
    const owner = openJournal(path, kind, write, options);
    if (!owner)
        return undefined;
    let result, failure;
    try {
        result = run(owner.db);
        owner.check();
    }
    catch (error) {
        failure = { error };
    }
    closeJournal(path, owner, failure);
    return result;
}
/** One lock-owned asynchronous session. No SQLite transaction is held across an await. */
export async function withDurableJournalAsync(path, kind, write, run, options = {}) {
    const owner = openJournal(path, kind, write, options);
    if (!owner)
        return undefined;
    let result, failure;
    try {
        result = await run(owner.db, owner.check);
        owner.check();
    }
    catch (error) {
        failure = { error };
    }
    closeJournal(path, owner, failure);
    return result;
}