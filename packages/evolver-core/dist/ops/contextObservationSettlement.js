import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { openSqliteDatabase } from '../util/sqlite.js';
import { canonicalEventPath } from '../util/canonicalEventPath.js';
import { protectedAuditConfigured, protectedAuditRpcSync } from '../events/protectedAuditRpc.js';
import { Ingestor } from '../events/ingest.js';
import { EventWriteNotCommittedError } from '../events/eventStore.js';
// Only the actual built-in writer can enter the product lane. This is an
// admission boundary for accidentally injected adapters, not a JS sandbox.
const builtInDispatches = new WeakSet();
const builtInObservationSink = Ingestor.isBuiltInObservationSink;
const beginBuiltInObservation = Ingestor.prototype.beginContextObservationV1;
export function builtInContextObservationDispatch(ingestor, raw, expectedPath) {
    if (!builtInObservationSink(ingestor))
        throw new Error('unsupported_unsupervised_context_observation_sink_v1');
    const path = canonicalEventPath(expectedPath);
    if (canonicalEventPath(ingestor.path) !== path)
        throw new Error('unsupported_unsupervised_context_observation_sink_v1');
    const dispatch = Object.freeze({ version: 1,
        begin: (attempt) => {
            try {
                if (!builtInObservationSink(ingestor)
                    || canonicalEventPath(ingestor.path) !== path || canonicalEventPath(expectedPath) !== path) {
                    throw new Error('context_observation_sink_mismatch');
                }
            }
            catch (cause) {
                throw new EventWriteNotCommittedError(attempt.operationId, cause);
            }
            return beginBuiltInObservation.call(ingestor, raw, { ...attempt, expectedPath: path, expectedAlias: expectedPath });
        },
    });
    builtInDispatches.add(dispatch);
    return dispatch;
}
export class ContextObservationNotCommittedError extends Error {
    operationId;
    constructor(operationId) {
        super('context_observation_not_committed');
        this.operationId = operationId;
    }
}
const retainedDatabases = new Map();
// Lost RPC acknowledgements retain capacity across facades, never an unbounded
// collection of tokens or permission to evict an unknown remote reservation.
const protectedReservations = new Set();
const namespaces = new WeakMap();
// Only the built-in journal can attest that a verified obsolete epoch makes a
// retry impossible. Structural adapters cannot discharge ownership with 'pending'.
const terminalPending = new WeakMap();
function consumeTerminalPending(store, key) {
    const proof = terminalPending.get(store);
    if (proof?.settle !== store.settle || proof.key !== key)
        return false;
    proof.key = undefined;
    return true;
}
const active = new Map();
const MAX_ACTIVE = 64;
const MAX_INTENTS = 100000;
const digest = (text) => createHash('sha256').update(text).digest('hex');
class ObservationSettlementBusyError extends Error {
}
// Every queued receipt retains its existing active slot. At most MAX_ACTIVE
// capabilities can exist; reaching that bound rejects new sink dispatch.
const acknowledged = new Map();
function recoverAcknowledged(lane) {
    for (const [slot, receipt] of acknowledged) {
        // A custom store is synchronous user code. Never let its failed or stalled
        // recovery run on the built-in writer's admission path.
        if (active.get(slot)?.lane !== lane)
            continue;
        try {
            if (receipt.store.settle(receipt.key, receipt.outcome) === 'pending'
                && !consumeTerminalPending(receipt.store, receipt.key))
                continue;
        }
        catch {
            continue;
        } // Keep the exact generation/capability; never replay a sink.
        acknowledged.delete(slot);
        active.delete(slot);
    }
}
async function settleAcknowledged(slot, store, key, outcome) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            if (store.settle(key, outcome) !== 'pending')
                return true;
            if (!consumeTerminalPending(store, key))
                acknowledged.set(slot, { store, key, outcome });
            return false;
        }
        catch (error) {
            if (!(error instanceof ObservationSettlementBusyError)) {
                // A changed/missing journal cannot erase an already completed sink. Keep
                // this bounded capability until its original authority can be recovered.
                acknowledged.set(slot, { store, key, outcome });
                throw error;
            }
            if (attempt < 4)
                await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
        }
    }
    // The caller's deadline remains unchanged. Longer contention keeps a bounded
    // recovery capability; the next observation retries only this known outcome.
    acknowledged.set(slot, { store, key, outcome });
    return false;
}
function journalIdentity(path) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error('unsafe_observation_journal');
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}
function journal(path, run, expectedIdentity, readOnly = false) {
    const retry = (key) => {
        const db = retainedDatabases.get(key);
        if (db) {
            db.close();
            retainedDatabases.delete(key);
        }
    };
    retry(path);
    if (retainedDatabases.size >= MAX_ACTIVE) {
        for (const key of retainedDatabases.keys()) {
            try {
                retry(key);
            }
            catch { /* Retain the cleanup capability, never replay a sink. */ }
            if (retainedDatabases.size < MAX_ACTIVE)
                break;
        }
        if (retainedDatabases.size >= MAX_ACTIVE)
            throw new Error('context_observation_cleanup_capacity');
    }
    let before;
    try {
        before = journalIdentity(path);
    }
    catch (error) {
        if (expectedIdentity || readOnly || error.code !== 'ENOENT')
            throw error;
        mkdirSync(dirname(path), { recursive: true });
        // Bind the fresh container before SQLite can open it. An empty database
        // moved after open can accept its first commit without reporting DBMOVED.
        try {
            writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
        }
        catch (createError) {
            if (createError.code !== 'EEXIST')
                throw createError;
        }
        before = journalIdentity(path);
    }
    if (expectedIdentity && before !== expectedIdentity)
        throw new Error('observation_journal_changed');
    const db = openSqliteDatabase(path, { create: false, ...(readOnly ? { readOnly: true } : {}) });
    retainedDatabases.set(path, db);
    let failed = false, failure, result;
    try {
        db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;');
        if (journalIdentity(path) !== before)
            throw new Error('observation_journal_changed');
        result = run(db, before);
    }
    catch (error) {
        failed = true;
        failure = error;
    }
    try {
        retry(path);
    }
    catch (error) {
        if (failed)
            throw new AggregateError([failure, error], 'context_observation_journal_and_cleanup_failed');
        // run() already completed its transaction. Losing that result can strand a
        // new reservation before its sink is dispatched. Retain the failed cleanup
        // capability, but preserve the committed result; retry(path) must confirm
        // close before ANY subsequent journal I/O, including sink settlement.
        return result;
    }
    if (failed)
        throw failure;
    return result;
}
function reservationTransaction(db, reserve) {
    // Serializing only the INSERT/CAS permits a rewind between the epoch read and
    // that mutation. Acquire write ownership before either read, without waiting.
    db.exec('BEGIN IMMEDIATE');
    try {
        const result = reserve();
        db.exec('COMMIT');
        return result;
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'context_observation_reservation_and_rollback_failed');
        }
        throw error;
    }
}
function journalInstance(db, initialize) {
    if (initialize)
        db.exec(`CREATE TABLE IF NOT EXISTS observation_journal_instance
    (id INTEGER PRIMARY KEY CHECK(id=1), instance TEXT NOT NULL CHECK(length(instance)=64));`);
    let instance;
    try {
        instance = db.prepare('SELECT instance FROM observation_journal_instance WHERE id=1').get()?.['instance'];
    }
    catch (cause) {
        throw new Error('observation_journal_changed', { cause });
    }
    if (instance === undefined && initialize) {
        instance = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO observation_journal_instance VALUES (1, ?)').run(instance);
    }
    if (typeof instance !== 'string' || !/^[a-f0-9]{64}$/.test(instance))
        throw new Error('observation_journal_changed');
    return instance;
}
function initializeObservationSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS observation_intents (identity TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('pending','committed')), epoch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS observation_epoch (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL);
    INSERT OR IGNORE INTO observation_epoch VALUES (1, 0);`);
    return journalInstance(db, true);
}
function observationJournalPath(eventsPath) {
    const path = `${eventsPath}.context-observation-intents.sqlite`;
    // Resolve directory aliases for exclusive creation, not the journal leaf:
    // journalIdentity must still reject a symbolic or multiply-linked file.
    return join(canonicalEventPath(dirname(path)), basename(path));
}
/** Recovery state, separate from the disposable index. Never delete it when rebuilding that index. */
export function durableObservationIntents(eventsPath) {
    if (protectedAuditConfigured()) {
        const reservations = new Map();
        const proof = { settle: () => undefined };
        const store = {
            lookup: key => protectedAuditRpcSync('observation_lookup', eventsPath, key, { deadlineAt: Date.now() + 30_000 }),
            reserve: key => {
                const prior = reservations.get(key);
                if (!prior && protectedReservations.size >= MAX_ACTIVE)
                    throw new Error('context_observation_reservation_capacity');
                const owner = prior ?? { token: randomUUID(), confirmed: false };
                if (!prior) {
                    reservations.set(key, owner);
                    protectedReservations.add(owner);
                }
                const deadlineAt = Date.now() + 30_000;
                const release = () => { reservations.delete(key); protectedReservations.delete(owner); };
                const reserve = () => {
                    const state = protectedAuditRpcSync('observation_reserve', eventsPath, { key, token: owner.token }, { deadlineAt });
                    if (!['new', 'pending', 'committed'].includes(state))
                        throw new Error('invalid_observation_reservation_receipt');
                    return state;
                };
                const settleUndispatched = () => {
                    owner.settling = 'not_committed';
                    const result = protectedAuditRpcSync('observation_settle', eventsPath, { key, token: owner.token, outcome: 'not_committed' }, { deadlineAt });
                    // Expired/restarted/foreign ownership and lost settlement replies cannot
                    // authorize a new sink. Preserve the original token for reconciliation.
                    if (result !== 'settled')
                        throw new Error('observation_reservation_recovery_pending');
                    delete owner.settling;
                };
                // A lost no-dispatch settlement reply must be joined before re-reserve.
                // At most three RPCs share this call's one absolute deadline.
                let reconciled = false;
                if (!owner.confirmed && owner.settling) {
                    settleUndispatched();
                    reconciled = true;
                }
                let state = reserve();
                if (state === 'pending' && prior && !owner.confirmed && !reconciled) {
                    // This facade never returned `new`, hence no caller received dispatch
                    // permission. Only the same token's authoritative no-commit receipt
                    // permits clearing its pending row; never cancel a confirmed owner.
                    settleUndispatched();
                    state = reserve();
                }
                if (state === 'new') {
                    if (owner.confirmed)
                        throw new Error('observation_reservation_owner_changed');
                    owner.confirmed = true;
                }
                else if (state === 'committed' || !owner.confirmed)
                    release();
                return state;
            },
            settle: (key, outcome) => {
                proof.key = undefined;
                const owner = reservations.get(key);
                if (!owner)
                    throw new Error('observation_intent_not_reserved');
                if (!owner.confirmed)
                    throw new Error('observation_intent_unconfirmed');
                if (owner.settling && owner.settling !== outcome)
                    throw new Error('observation_settlement_outcome_changed');
                owner.settling = outcome;
                const result = protectedAuditRpcSync('observation_settle', eventsPath, { key, token: owner.token, outcome }, { deadlineAt: Date.now() + 30_000 });
                if (!['pending', 'settled'].includes(result))
                    throw new Error('invalid_observation_settlement_receipt');
                reservations.delete(key);
                protectedReservations.delete(owner);
                if (result === 'pending') {
                    proof.key = key;
                    return 'pending';
                }
            },
        };
        proof.settle = store.settle;
        terminalPending.set(store, proof);
        namespaces.set(store, canonicalEventPath(`${eventsPath}.context-observation-intents.sqlite`));
        return store;
    }
    const path = observationJournalPath(eventsPath);
    const reservations = new Map();
    const store = {
        lookup: key => {
            let identity;
            try {
                const stat = lstatSync(path);
                identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    return undefined;
                throw error;
            }
            return journal(path, db => {
                journalInstance(db, false);
                // Read state and epoch together. A rewind invalidates committed rows but
                // never turns an ambiguous pending append into an admissible operation.
                const row = db.prepare(`SELECT state FROM observation_intents WHERE identity=?
          AND (state='pending' OR epoch=(SELECT epoch FROM observation_epoch WHERE id=1))`).get(key);
                return row?.['state'];
            }, identity, true);
        },
        reserve: key => journal(path, (db, identity) => {
            let reservation;
            const state = reservationTransaction(db, () => {
                // First-use schema and reservation are one durable publication. Separate
                // autocommit DDL causes multiple FULL syncs before the sink's 250ms gate
                // and can strand half-initialized state when initialization fails.
                // A reset can also initialize a proved-empty journal left by a rolled
                // back first admission. Late settlement must never initialize one.
                const instance = initializeObservationSchema(db);
                // The token belongs to the actual SQLite connection. A pathname stat can
                // describe a replacement inode while that connection still owns the old DB.
                const epoch = Number(db.prepare('SELECT epoch FROM observation_epoch WHERE id=1').get()?.['epoch']);
                const row = db.prepare('SELECT state, epoch FROM observation_intents WHERE identity=?').get(key);
                if (row) {
                    if (row['state'] === 'pending' || Number(row['epoch']) === epoch)
                        return row['state'];
                    const changed = db.prepare("UPDATE observation_intents SET state='pending', epoch=? WHERE identity=? AND state='committed' AND epoch=?")
                        .run(epoch, key, Number(row['epoch']));
                    if (Number(changed.changes) !== 1)
                        return 'pending';
                    reservation = { identity, instance, epoch };
                    return 'new';
                }
                const result = db.prepare("INSERT OR IGNORE INTO observation_intents VALUES (?, 'pending', ?)").run(key, epoch);
                if (Number(result.changes) === 1)
                    reservation = { identity, instance, epoch };
                return Number(result.changes) === 1 ? 'new' : 'pending';
            });
            // A failed commit owns no callable sink reservation; rollback/close retains
            // the database capability if native cleanup still needs to be retried.
            if (reservation)
                reservations.set(key, reservation);
            return state;
        }),
        settle: (key, outcome) => {
            const proof = terminalPending.get(store);
            proof.key = undefined;
            const reservation = reservations.get(key);
            if (!reservation)
                throw new Error('observation_intent_not_reserved');
            const { identity, instance, epoch } = reservation;
            let result;
            try {
                result = journal(path, db => {
                    return reservationTransaction(db, () => {
                        if (journalInstance(db, false) !== instance)
                            throw new Error('observation_journal_changed');
                        if (outcome === 'not_committed')
                            db.prepare('DELETE FROM observation_intents WHERE identity=? AND state=? AND epoch=?').run(key, 'pending', epoch);
                        // A rewind may race the sink's durable write. Its late acknowledgement cannot
                        // prove which history contains that write; keep the old intent pending rather
                        // than turn it into a stale committed row that reserve() would replay.
                        else {
                            const changed = db.prepare("UPDATE observation_intents SET state='committed' WHERE identity=? AND state='pending' AND epoch=? AND epoch=(SELECT epoch FROM observation_epoch WHERE id=1)").run(key, epoch);
                            if (Number(changed.changes) !== 1) {
                                const row = db.prepare('SELECT state, epoch FROM observation_intents WHERE identity=?').get(key);
                                const currentEpoch = Number(db.prepare('SELECT epoch FROM observation_epoch WHERE id=1').get()?.['epoch']);
                                if (row?.['state'] !== 'pending' || Number(row['epoch']) !== epoch
                                    || !Number.isSafeInteger(currentEpoch) || currentEpoch <= epoch)
                                    throw new Error('observation_intent_changed');
                                // The sink finished, but this exact old intent still prohibits replay.
                                // Do not claim acknowledgement or retain an impossible old-epoch retry.
                                return 'pending';
                            }
                        }
                        return undefined;
                    });
                }, identity);
            }
            catch (error) {
                const failure = error;
                // Node uses numeric SQLite codes, Bun uses the SQLite symbolic name.
                // Cleanup/rollback aggregates or changed generations are not lock retries.
                if (failure?.code === 'SQLITE_BUSY' || failure?.code === 'SQLITE_LOCKED'
                    || (failure?.code === 'ERR_SQLITE_ERROR' && typeof failure.errcode === 'number'
                        && [5, 6].includes(failure.errcode & 0xff))) {
                    throw new ObservationSettlementBusyError('observation_settlement_busy', { cause: error });
                }
                throw error;
            }
            reservations.delete(key);
            if (result === 'pending')
                proof.key = key;
            return result;
        },
    };
    terminalPending.set(store, { settle: store.settle });
    namespaces.set(store, canonicalEventPath(path));
    return store;
}
/** A proved history rewind invalidates settled acknowledgements, never unknown in-flight intents. */
export function resetObservationAcknowledgements(eventsPath) {
    if (protectedAuditConfigured()) {
        // A rewind is justified only by the indexer's own history-generation proof.
        // Protected clients have no such authority; the service's indexer performs
        // the local reset inside its guarded rebuild transaction.
        throw new Error('observation_reset_requires_index_authority');
    }
    const path = observationJournalPath(eventsPath);
    let identity;
    try {
        const stat = lstatSync(path);
        identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    journal(path, db => reservationTransaction(db, () => {
        // In particular, do not initialize an empty replacement placed after the
        // pre-open pathname check. A rewind belongs to the inode we inspected.
        const opened = lstatSync(path);
        if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1
            || `${opened.dev}:${opened.ino}:${opened.birthtimeMs}` !== identity)
            throw new Error('observation_journal_changed');
        const objects = db.prepare('SELECT type, name, sql FROM sqlite_schema').all();
        if (objects.length === 0) {
            // A failed first reservation can leave a real, empty SQLite container.
            // Publish its schema, journal identity and first rewind atomically; no
            // intent existed, so there is no operation to replay or acknowledge.
            if (db.prepare('PRAGMA integrity_check').get()?.['integrity_check'] !== 'ok'
                || Number(db.prepare('PRAGMA user_version').get()?.['user_version']) !== 0
                || Number(db.prepare('PRAGMA application_id').get()?.['application_id']) !== 0) {
                throw new Error('observation_journal_changed');
            }
            initializeObservationSchema(db);
        }
        else {
            const tables = objects.filter(row => row['type'] === 'table');
            const instance = tables.some(row => row['name'] === 'observation_journal_instance');
            const expected = new Set(['observation_intents', 'observation_epoch',
                ...(instance ? ['observation_journal_instance'] : [])]);
            if (tables.length !== expected.size || tables.some(row => !expected.has(String(row['name'])))
                || objects.some(row => row['type'] !== 'table'
                    && !(row['type'] === 'index' && String(row['name']).startsWith('sqlite_autoindex_observation_intents_')))) {
                throw new Error('observation_journal_changed');
            }
            if (instance)
                journalInstance(db, false);
            else if (/CHECK\s*\(\s*state\s+IN\s*\(/i
                .test(String(tables.find(row => row['name'] === 'observation_intents')?.['sql'] ?? ''))) {
                // A modern journal whose instance was removed is not a legacy journal.
                throw new Error('observation_journal_changed');
            }
        }
        const rows = db.prepare('SELECT id, epoch FROM observation_epoch').all();
        if (rows.length !== 1 || Number(rows[0]?.['id']) !== 1
            || !Number.isSafeInteger(rows[0]?.['epoch']) || Number(rows[0]?.['epoch']) < 0
            || Number(rows[0]?.['epoch']) >= Number.MAX_SAFE_INTEGER)
            throw new Error('observation_journal_changed');
        const changed = db.prepare('UPDATE observation_epoch SET epoch=epoch+1 WHERE id=1 AND epoch=?')
            .run(rows[0]?.['epoch']);
        if (Number(changed.changes) !== 1)
            throw new Error('observation_journal_changed');
    }), identity);
}
const memory = new WeakMap();
/** Pathless adapters have no invented durable path; their owner must provide cross-process persistence. */
export function memoryObservationIntents(owner) {
    let rows = memory.get(owner);
    if (!rows) {
        rows = new Map();
        memory.set(owner, rows);
    }
    const intents = rows;
    // Sharing an owner's state never shares its settlement capabilities. Each new
    // row is a distinct reservation, including a retry after proved no-commit.
    const reservations = new Map();
    const store = {
        lookup: key => intents.get(key)?.state,
        reserve: key => {
            const existing = intents.get(key);
            if (existing)
                return existing.state;
            if (intents.size >= MAX_INTENTS)
                throw new Error('context_observation_intent_capacity');
            const reservation = { state: 'pending' };
            intents.set(key, reservation);
            reservations.set(key, reservation);
            return 'new';
        },
        settle: (key, outcome) => {
            const reservation = reservations.get(key);
            if (!reservation)
                throw new Error('observation_intent_not_reserved');
            if (intents.get(key) !== reservation)
                throw new Error('observation_intent_changed');
            if (outcome === 'not_committed')
                intents.delete(key);
            else
                reservation.state = 'committed';
            reservations.delete(key);
        },
    };
    namespaces.set(store, intents);
    return store;
}
/** Deadline ends waiting, not ownership of an unknown append. Its durable intent prevents replay. */
export async function settleContextObservation(store, identity, dispatch, options = {}, 
/** Internal batch budget: starts after the first durable reservation, then caps every row together. */
sharedWait) {
    // A legacy callback can run forever after the bounded caller has returned.
    // Refuse it before reservation and, more importantly, before dispatch.
    if (!dispatch || dispatch.version !== 1 || typeof dispatch.begin !== 'function')
        throw new Error('unsupported_context_observation_dispatch_v1');
    if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt))
        throw new Error('invalid_observation_deadline');
    if (options.signal?.aborted || Date.now() >= Math.min(options.deadlineAt ?? Infinity, sharedWait?.deadlineAt ?? Infinity))
        throw new Error('context_observation_aborted');
    const operationId = `sha256:${digest(identity)}`;
    const lane = builtInDispatches.has(dispatch) ? 'builtin' : 'external';
    recoverAcknowledged(lane);
    if (options.signal?.aborted || Date.now() >= Math.min(options.deadlineAt ?? Infinity, sharedWait?.deadlineAt ?? Infinity))
        throw new Error('context_observation_aborted');
    // Built-in facades share their logical namespace through journal replacement.
    // Unknown legacy adapters retain facade identity; no cross-facade authority is inferred.
    const namespace = namespaces.get(store) ?? store;
    for (const owner of active.values()) {
        if (owner.namespace === namespace && owner.key === operationId)
            return 'pending';
    }
    if ([...active.values()].filter(owner => owner.lane === lane).length >= MAX_ACTIVE) {
        // A rejected new reservation would still need an owned recovery slot if its
        // no-commit settlement hit contention. Read existing state without creating
        // a 65th capability; legacy mutating-only adapters must fail closed here.
        const state = store.lookup?.(operationId);
        if (state !== undefined)
            return state === 'committed' ? 'already_committed' : 'pending';
        throw new Error('context_observation_capacity');
    }
    const slot = Symbol();
    active.set(slot, { namespace, key: operationId, lane });
    let state;
    try {
        state = store.reserve(operationId);
    }
    catch (error) {
        active.delete(slot);
        throw error;
    }
    if (state !== 'new') {
        active.delete(slot);
        return state === 'committed' ? 'already_committed' : 'pending';
    }
    // The default bounds sink waiting, not synchronous SQLite preparation. An
    // explicit absolute deadline still covers the whole operation, including reserve().
    const deadlineAt = Math.min(options.deadlineAt ?? Infinity, sharedWait?.deadlineAt ?? Infinity, Date.now() + 250);
    if (sharedWait && sharedWait.deadlineAt === undefined)
        sharedWait.deadlineAt = deadlineAt;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted)
        abort();
    const timer = setTimeout(abort, Math.max(0, deadlineAt - Date.now()));
    let rejectAbort;
    let dispatched = false;
    let terminalVerified = false;
    let terminalNoCommit = false;
    // No callback into the disposable index is captured by this continuation.
    const work = Promise.resolve().then(async () => {
        try {
            if (controller.signal.aborted || Date.now() >= deadlineAt) {
                // No sink ran. Keep the admitted slot until this exact known outcome
                // settles, including cancellation during reservation and SQLite busy.
                if (!await settleAcknowledged(slot, store, operationId, 'not_committed'))
                    return 'pending';
                throw new Error('context_observation_aborted');
            }
            // begin() is synchronous so its owner exists before async I/O. Even a
            // throwing adapter might have dispatched work; do not reclaim that slot.
            dispatched = true;
            const operation = dispatch.begin(Object.freeze({ operationId, signal: controller.signal, deadlineAt }));
            if (operation?.version !== 1 || typeof operation.cancelAndSettle !== 'function'
                || !operation.result || typeof operation.result.then !== 'function')
                throw new Error('invalid_context_observation_operation_v1');
            // Synchronous admission can consume the remaining time before a timer
            // runs. Cancel the actual owner, but never invent rollback of a commit.
            if (Date.now() >= deadlineAt)
                controller.abort();
            // Whichever terminal proof arrives first owns settlement. A cancelled
            // operation may report no-commit even when its ordinary result never resolves.
            let finished = false;
            let cancelStarted = false;
            let cancellationOwner;
            const cancelAndSettle = () => {
                // Result rejection and deadline cancellation can race. Both must join
                // the same actual worker, never call an arbitrary adapter twice.
                cancellationOwner ??= Promise.resolve().then(() => operation.cancelAndSettle());
                return cancellationOwner;
            };
            const cancellation = new Promise((resolve, reject) => {
                const cancel = () => {
                    if (finished || cancelStarted)
                        return;
                    cancelStarted = true;
                    cancelAndSettle().then(resolve, reject);
                };
                controller.signal.addEventListener('abort', cancel, { once: true });
                if (controller.signal.aborted)
                    cancel();
            });
            const ordinary = operation.result.catch(async (error) => {
                // A rejected result is not terminal proof by itself. Join the owned
                // cancellation. Only its matching receipt determines commit status;
                // the original error name is not evidence that the worker has stopped.
                const proof = await cancelAndSettle();
                if (proof?.operationId !== operationId || !['committed', 'not_committed', 'unknown'].includes(proof.outcome))
                    throw new Error('invalid_observation_receipt');
                if (proof.outcome === 'unknown') {
                    // Preserve the original failure for callers, while retaining the
                    // durable pending identity and releasing only the terminal owner.
                    terminalVerified = true;
                    throw error;
                }
                return proof;
            });
            const receipt = await Promise.race([ordinary, cancellation]);
            finished = true;
            if (receipt?.operationId !== operationId || !['committed', 'not_committed', 'unknown'].includes(receipt.outcome)) {
                // The result is malformed, but a separate cancellation receipt may
                // still prove its outcome. Settle a matching known outcome through the
                // same durable recovery path before releasing its process capacity.
                let proof;
                try {
                    proof = await cancelAndSettle();
                }
                catch { /* No terminal proof: retain the owner. */ }
                if (proof?.operationId === operationId && ['committed', 'not_committed', 'unknown'].includes(proof.outcome)) {
                    terminalVerified = true;
                    if (proof.outcome !== 'unknown'
                        && !await settleAcknowledged(slot, store, operationId, proof.outcome))
                        return 'pending';
                }
                throw new Error('invalid_observation_receipt');
            }
            // Terminal unknown means the operation ended but its commit outcome is
            // ambiguous. Release process capacity; the durable pending intent still
            // forbids replay of this exact identity until owner reconciliation.
            terminalVerified = true;
            if (receipt.outcome === 'unknown')
                throw new Error('observation_not_acknowledged');
            if (receipt.outcome === 'not_committed') {
                terminalNoCommit = true;
                throw new ContextObservationNotCommittedError(operationId);
            }
            if (!await settleAcknowledged(slot, store, operationId, 'committed'))
                return 'pending';
            return 'committed';
        }
        catch (error) {
            if (terminalNoCommit && error instanceof ContextObservationNotCommittedError
                && error.operationId === operationId) {
                if (!await settleAcknowledged(slot, store, operationId, 'not_committed'))
                    return 'pending';
            }
            throw error;
        }
        finally {
            // Missing/malformed/unknown terminal proof retains the exact slot. A
            // failed cancel must not make room for a 65th side-effecting callback.
            if (!acknowledged.has(slot) && (!dispatched || terminalVerified))
                active.delete(slot);
        }
    });
    try {
        return await Promise.race([work, new Promise(resolve => {
                rejectAbort = () => resolve('pending');
                controller.signal.addEventListener('abort', rejectAbort, { once: true });
                if (controller.signal.aborted)
                    rejectAbort();
            })]);
    }
    finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (rejectAbort)
            controller.signal.removeEventListener('abort', rejectAbort);
        // A late acknowledgement settles its independent journal, never the old tick/index.
        controller.abort();
    }
}