import { join } from 'node:path';
import { canonicalEventPath } from '../util/canonicalEventPath.js';
import { bytesDigest, journalInitializationPending, journalWitnessPath, sqliteTransaction, stableJson, withDurableJournal, withDurableJournalAsync } from '../util/durableJournal.js';
import { assertAssetStoreDirectoryIdentity, assertOptionalRegularFile } from './assetStoreStorage.js';
const FILE = 'experience-activity-returns.sqlite';
const KIND = 'experience-activity-returns-v1';
const MAX_INTENT = 64 * 1024;
export class ActivityReturnError extends Error {
    reason;
    code = 'ACTIVITY_RETURN_INVALID';
    constructor(reason) {
        super(`activity return ${reason}`);
        this.reason = reason;
    }
}
const invalid = (reason) => { throw new ActivityReturnError(reason); };
function initialize(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS activity_returns (
    operation_id TEXT PRIMARY KEY, intent TEXT NOT NULL, intent_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('awaiting_return','acknowledged')));
    CREATE INDEX IF NOT EXISTS activity_returns_pending ON activity_returns(state);`);
}
/** Immutable return receipts, not another experience-content store. Mutations hold the activity lock. */
export class ExperienceActivityReturns {
    baseDir;
    validate;
    path;
    owner;
    constructor(baseDir, validate) {
        this.baseDir = baseDir;
        this.validate = validate;
        this.path = join(canonicalEventPath(baseDir), FILE);
    }
    decode(row, budget) {
        budget?.check();
        const raw = row['intent'];
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_INTENT || bytesDigest(raw) !== row['intent_hash']
            || !['awaiting_return', 'acknowledged'].includes(String(row['state'])))
            return invalid('record_changed');
        const intent = this.validate(raw);
        if (intent.operationId !== row['operation_id'])
            return invalid('identity_changed');
        return { intent, state: row['state'] };
    }
    use(write, run, directory, existingOnly = false) {
        if (directory)
            assertAssetStoreDirectoryIdentity(this.baseDir, directory);
        const operation = (db) => {
            if (write && !existingOnly)
                initialize(db);
            else if (!db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='activity_returns'").get()) {
                if (existingOnly)
                    return invalid('receipt_changed');
                return undefined;
            }
            return run(db);
        };
        let result;
        if (this.owner) {
            // An owned-handle read grants no I/O authority until its completed snapshot is fenced.
            if (write)
                this.owner.check();
            result = operation(this.owner.db);
            this.owner.check();
        }
        else
            result = withDurableJournal(this.path, KIND, write, operation, { existingOnly });
        if (directory)
            assertAssetStoreDirectoryIdentity(this.baseDir, directory);
        return result;
    }
    async withSession(directory, run) {
        assertAssetStoreDirectoryIdentity(this.baseDir, directory);
        // Keep first-use initialization after the actual root receipt, not ahead of input validation.
        if (assertOptionalRegularFile(this.path) === null && assertOptionalRegularFile(journalWitnessPath(this.path), 'temp_file') === null)
            return run(this);
        return (await withDurableJournalAsync(this.path, KIND, true, async (db, check) => {
            initialize(db);
            const scoped = new ExperienceActivityReturns(this.baseDir, this.validate);
            scoped.owner = { db, check };
            try {
                return await run(scoped);
            }
            finally {
                scoped.owner = undefined;
            }
        }));
    }
    rollbackPending(directory) {
        assertAssetStoreDirectoryIdentity(this.baseDir, directory);
        if (journalInitializationPending(this.path))
            return true;
        const journal = assertOptionalRegularFile(`${this.path}-journal`, 'temp_file');
        if (!journal || journal.size === 0)
            return false;
        if (journal.nlink !== 1 || assertOptionalRegularFile(this.path) === null)
            return invalid('rollback_authority_missing');
        return true;
    }
    awaiting(budget, directory) {
        budget?.check();
        return this.use(false, db => db.prepare("SELECT * FROM activity_returns WHERE state='awaiting_return' ORDER BY rowid")
            .all().map(row => this.decode(row, budget).intent), directory) ?? [];
    }
    lookup(operationId, directory) {
        return this.use(false, db => {
            const row = db.prepare('SELECT * FROM activity_returns WHERE operation_id=?').get(operationId);
            return row ? this.decode(row) : undefined;
        }, directory);
    }
    save(intent, directory) {
        const raw = JSON.stringify(intent);
        if (Buffer.byteLength(raw) > MAX_INTENT)
            return invalid('capacity');
        const validated = this.validate(raw);
        if (validated.operationId !== intent.operationId)
            return invalid('identity_changed');
        return this.use(true, db => sqliteTransaction(db, () => {
            const previous = db.prepare('SELECT * FROM activity_returns WHERE operation_id=?').get(intent.operationId);
            if (previous) {
                const record = this.decode(previous);
                if (stableJson(record.intent) !== stableJson(intent))
                    return invalid('receipt_changed');
                return record;
            }
            db.prepare("INSERT INTO activity_returns VALUES(?,?,?,'awaiting_return')").run(intent.operationId, raw, bytesDigest(raw));
            return { intent: validated, state: 'awaiting_return' };
        }), directory);
    }
    acknowledge(intent, directory) {
        // Missing authority cannot be replaced by a new empty journal to claim a return.
        if (assertOptionalRegularFile(this.path) === null)
            return invalid('namespace_missing');
        this.use(true, db => sqliteTransaction(db, () => {
            const row = db.prepare('SELECT * FROM activity_returns WHERE operation_id=?').get(intent.operationId);
            if (!row || stableJson(this.decode(row).intent) !== stableJson(intent))
                return invalid('receipt_changed');
            db.prepare("UPDATE activity_returns SET state='acknowledged' WHERE operation_id=?").run(intent.operationId);
        }), directory, true);
    }
}