import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonicalEventPath } from '../util/canonicalEventPath.js';
import { openSqliteDatabase } from '../util/sqlite.js';
import { AuditBudget } from '../events/boundedAudit.js';
import { AuditCleanupError } from '../events/auditCleanup.js';
import { readGeneContextDeliveryReceipt } from './geneContextDelivery.js';
import { redactString } from '../hub/sanitize.js';
import { startContextReadStage } from '../assetstore/contextReadDiagnostics.js';
/** Corrupt persisted metadata is distinct from unavailable journal authority. */
export class DeliveryMetadataInvalidError extends Error {
}
const owners = new Set();
const MAX_OWNERS = 64;
// A caller may stop waiting while the actual native/SQLite recovery continues.
// Reserve by the same canonical target used by the journal before dispatching
// any work, so every Ingestor facade in this process sees one recovery owner.
const activeRecoveries = new Map();
const MAX_ROWS = 4096;
const MAX_BYTES = 32 * 1024 * 1024;
const empty = () => ({ confirmedPending: 0, outputUnknown: 0, projectionUnknown: 0, projected: 0, busy: false, reasons: {} });
const missing = (error) => error?.code === 'ENOENT';
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
function privateFile(path) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES)
        throw new Error('unsafe_delivery_journal');
    return identity(stat);
}
function targetPath(path) {
    // Directory aliases are supported, but a final symlink must not be laundered by realpath.
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
            throw new Error('unsafe_delivery_target');
    }
    catch (error) {
        if (!missing(error))
            throw error;
    }
    return canonicalEventPath(path);
}
function finish(owner) {
    if (owner.release && !owner.running && !owner.confirm && !owner.db && !owner.cleanup && !owner.outputPending)
        owners.delete(owner);
}
function reserveOwner(recover = true) {
    for (const owner of owners) {
        if (owner.running)
            continue;
        if (owner.db) {
            try {
                owner.db.close();
                owner.db = undefined;
            }
            catch { /* Keep exact cleanup capability. */ }
        }
        if (recover && owner.confirm && !owner.db) {
            try {
                owner.confirm();
            }
            catch { /* Same capability, no stdout replay. */ }
        }
        finish(owner);
    }
    if (owners.size >= MAX_OWNERS)
        throw new Error('context_delivery_owner_capacity');
    const owner = { running: false, release: false };
    owners.add(owner);
    return owner;
}
function validateNamespace(db, path, allowEmpty) {
    const schema = db.prepare("SELECT type FROM sqlite_schema WHERE name='context_delivery_instance'").get();
    if (!schema) {
        // A failed first transaction may leave an empty SQLite container. No published instance
        // or intent ever existed in an empty schema; every other unknown schema fails closed.
        if (allowEmpty && Number(db.prepare('SELECT count(*) AS n FROM sqlite_schema').get()?.['n']) === 0)
            return;
        throw new Error('delivery_namespace_changed');
    }
    if (schema['type'] !== 'table')
        throw new Error('delivery_namespace_changed');
    const namespace = db.prepare('SELECT target, parent_identity, journal_identity FROM context_delivery_instance WHERE id=1').get();
    const target = path.slice(0, -'.context-deliveries.sqlite'.length);
    if (namespace?.['target'] !== target || namespace?.['parent_identity'] !== identity(lstatSync(dirname(path))))
        throw new Error('delivery_namespace_changed');
    if (namespace['journal_identity'] !== privateFile(path))
        throw new Error('delivery_journal_changed');
}
function database(owner, path, run, binding, readonly = false, initialize = false) {
    const finishOpen = initialize ? startContextReadStage('delivery_journal_open') : undefined;
    try {
        if (owner.db) {
            owner.db.close();
            owner.db = undefined;
        }
        let before;
        try {
            before = privateFile(path);
        }
        catch (error) {
            if (binding || readonly || !missing(error))
                throw error;
        }
        if (binding && before !== binding.identity)
            throw new Error('delivery_journal_changed');
        if (!before && !readonly) {
            mkdirSync(dirname(path), { recursive: true });
            // An empty SQLite file can be moved after open without DBMOVED preventing
            // its first commit. Bind a private, exclusively created container first,
            // then use existing-only open and the same identity checks as older rows.
            try {
                writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
            }
            before = privateFile(path);
        }
        const db = openSqliteDatabase(path, { create: false, ...(readonly ? { readOnly: true } : {}) });
        owner.db = db;
        try {
            db.exec('PRAGMA busy_timeout=0;');
            if (before && privateFile(path) !== before)
                throw new Error('delivery_journal_changed');
            if (before)
                validateNamespace(db, path, initialize);
            if (binding && db.prepare('SELECT instance FROM context_delivery_instance WHERE id=1').get()?.['instance'] !== binding.instance)
                throw new Error('delivery_journal_changed');
            if (!readonly)
                db.exec('PRAGMA synchronous=FULL; PRAGMA max_page_count=8192;');
            finishOpen?.('fulfilled');
            const finishTransaction = initialize ? startContextReadStage('delivery_journal_transaction') : undefined;
            const timing = finishTransaction ? {} : undefined;
            try {
                const result = run(db, timing);
                finishTransaction?.('fulfilled', undefined, timing);
                return result;
            }
            catch (error) {
                finishTransaction?.('rejected', undefined, timing);
                throw error;
            }
        }
        catch (error) {
            finishOpen?.('rejected');
            throw error;
        }
        finally {
            const finishClose = initialize ? startContextReadStage('delivery_journal_close') : undefined;
            // Close failure cannot undo a committed result. The owner retains the actual connection.
            try {
                db.close();
                owner.db = undefined;
                finishClose?.('fulfilled');
            }
            catch {
                finishClose?.('rejected'); /* Admission waits for this exact close. */
            }
        }
    }
    catch (error) {
        finishOpen?.('rejected');
        throw error;
    }
}
function transaction(db, run, timing) {
    // Only the opt-in initial preparation supplies timing. Confirmation/recovery
    // retains the same transaction, with no additional collector stages or I/O.
    const step = (part, action) => {
        if (!timing)
            return action();
        const started = performance.now();
        let outcome = 'fulfilled';
        try {
            return action();
        }
        catch (error) {
            outcome = 'rejected';
            throw error;
        }
        finally {
            try {
                timing[part] = [Math.round(Math.max(0, performance.now() - started) * 100) / 100, outcome];
            }
            catch { /* Timing cannot replace an actual transaction outcome. */ }
        }
    };
    const sql = (part, statement) => {
        const phases = { begin: 'delivery_journal_begin', commit: 'delivery_journal_commit', rollback: 'delivery_journal_rollback' };
        const finish = timing ? startContextReadStage(phases[part]) : undefined;
        try {
            step(part, () => db.exec(statement));
            finish?.('fulfilled');
        }
        catch (error) {
            finish?.('rejected');
            throw error;
        }
    };
    sql('begin', 'BEGIN IMMEDIATE');
    try {
        const result = step('body', run);
        sql('commit', 'COMMIT');
        return result;
    }
    catch (error) {
        try {
            sql('rollback', 'ROLLBACK');
        }
        catch { /* database cleanup remains owned */ }
        throw error;
    }
}
function safeIdentity(value, max) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || !value || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value) || redactString(value) !== value)
        return undefined;
    return value;
}
/** Snapshot a strict metadata whitelist. Arbitrary RawEvent fields can never reach this sidecar. */
export function snapshotContextDelivery(raw, operationId) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId))
        throw new Error('invalid_delivery_attempt');
    const p = raw.payload;
    const entrypoint = p?.['entrypoint'];
    // Detach nested metadata before validation. Regex coercion or a caller-owned toJSON
    // cannot smuggle an object into the persisted receipt or mutate it after preparation.
    const encodedReceipt = JSON.stringify(p?.['receipt']);
    const receipt = typeof encodedReceipt === 'string' && Buffer.byteLength(encodedReceipt) <= 2800
        ? readGeneContextDeliveryReceipt(JSON.parse(encodedReceipt)) : undefined;
    if (raw.type !== 'value.gene_context_delivery' || !receipt || typeof entrypoint !== 'string' || !['prompt_recall', 'session_start'].includes(entrypoint)
        || p?.['transport'] !== 'stdout_written' || p?.['hostReceived'] !== 'unknown')
        throw new Error('invalid_delivery_metadata');
    const sessionId = safeIdentity(p['sessionId'], 256), cycleId = safeIdentity(p['cycleId'], 128);
    return { type: 'value.gene_context_delivery', human: { title: entrypoint === 'session_start' ? 'Session Gene context stdout written' : 'Gene context stdout written' },
        payload: { receipt, entrypoint, transport: 'stdout_written', hostReceived: 'unknown', deliveryAttemptId: operationId,
            ...(sessionId ? { sessionId } : {}), ...(cycleId ? { cycleId } : {}) } };
}
function authority(owner) {
    const binding = owner.binding, id = owner.id;
    const use = (run) => database(owner, binding.journal, run, binding);
    const change = (sql, ...args) => use(db => {
        if (Number(db.prepare(sql).run(...args, id).changes) !== 1)
            throw new Error('delivery_attempt_changed');
    });
    return {
        operationId: id,
        read: () => use(db => {
            const row = db.prepare('SELECT state, raw, plan, target_identity FROM context_deliveries WHERE operation_id=?').get(id);
            if (!row)
                throw new Error('delivery_attempt_changed');
            try {
                if (typeof row['raw'] !== 'string' || Buffer.byteLength(row['raw']) > 4096)
                    throw new Error('raw_bounds');
                const raw = snapshotContextDelivery(JSON.parse(row['raw']), id);
                if (JSON.stringify(raw) !== row['raw'])
                    throw new Error('raw_changed');
                let plan;
                if (row['plan'] !== null) {
                    if (typeof row['plan'] !== 'string' || Buffer.byteLength(row['plan']) > 16384)
                        throw new Error('plan_bounds');
                    const parsed = JSON.parse(row['plan']);
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                        throw new Error('plan_shape');
                    plan = parsed;
                }
                const target = row['target_identity'];
                if (target !== null && (typeof target !== 'string' || target.length > 1024))
                    throw new Error('target_bounds');
                if (typeof target === 'string' && target.startsWith('[')) {
                    const identities = JSON.parse(target);
                    if (!Array.isArray(identities) || identities.length !== 2 || !identities.every(value => typeof value === 'string'))
                        throw new Error('target_shape');
                }
                return { state: String(row['state']), raw, ...(plan ? { plan } : {}), targetIdentity: target };
            }
            catch (cause) {
                throw new DeliveryMetadataInvalidError('delivery_metadata_invalid', { cause });
            }
        }),
        plan: value => change("UPDATE context_deliveries SET state='projecting', plan=?, owner_pid=? WHERE state='confirmed' AND operation_id=?", JSON.stringify(value), process.pid),
        projected: () => change("UPDATE context_deliveries SET state='projected', reason=NULL, owner_pid=? WHERE state IN ('projecting','projection_unknown','projected') AND operation_id=?", process.pid),
        notDispatched: () => change("UPDATE context_deliveries SET state='confirmed', plan=NULL, reason=NULL WHERE state='projecting' AND operation_id=?"),
        unknown: (reason = 'append_unconfirmed') => change("UPDATE context_deliveries SET state='projection_unknown', reason=? WHERE state IN ('confirmed','projecting','projection_unknown') AND operation_id=?", reason),
    };
}
async function projectOwned(owner, project, options) {
    // Cleanup is part of the original attempt. Never replace its capability or
    // re-enter the business callback while it still owns a file/lock resource.
    // A prepared receipt has not confirmed stdout. Do not invoke an external
    // projector until that confirmation is durable, even for a direct caller.
    if (!owners.has(owner) || owner.running || owner.confirm || owner.cleanup || owner.outputPending || owner.outputUnknown)
        return 'pending';
    owner.running = true;
    try {
        return await project(owner.binding.path, authority(owner), options);
    }
    catch (error) {
        if (error instanceof AuditCleanupError)
            owner.cleanup = error;
        return 'pending';
    }
    finally {
        owner.running = false;
        finish(owner);
    }
}
/** Called only after Ingestor validation. No event-log writes happen in the outbox. */
export function prepareContextDelivery(raw, path, project, options = {}) {
    const budget = new AuditBudget(options, 'context_preparation');
    budget.check();
    const owner = reserveOwner();
    try {
        path = targetPath(path);
        if ([...owners].some(other => other !== owner && other.binding?.path === path && other.db))
            throw new Error('delivery_cleanup_pending');
        const journal = `${path}.context-deliveries.sqlite`, id = randomUUID();
        const snapshot = snapshotContextDelivery(raw, id);
        let targetIdentity = null;
        try {
            const stat = lstatSync(path);
            if (stat.isFile() && stat.nlink === 1)
                targetIdentity = identity(stat);
        }
        catch (error) {
            if (!missing(error))
                throw error;
        }
        const binding = database(owner, journal, (db, timing) => {
            budget.check();
            return transaction(db, () => {
                validateNamespace(db, journal, true);
                db.exec(`CREATE TABLE IF NOT EXISTS context_delivery_instance (id INTEGER PRIMARY KEY CHECK(id=1), instance TEXT NOT NULL, target TEXT NOT NULL, parent_identity TEXT NOT NULL, journal_identity TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS context_deliveries (operation_id TEXT PRIMARY KEY, state TEXT NOT NULL, raw TEXT NOT NULL,
          target_identity TEXT, plan TEXT, created INTEGER NOT NULL, turn INTEGER NOT NULL, owner_pid INTEGER NOT NULL, reason TEXT);
        CREATE INDEX IF NOT EXISTS context_delivery_turn ON context_deliveries(turn);`);
                if (!db.prepare('SELECT instance FROM context_delivery_instance WHERE id=1').get())
                    db.prepare('INSERT INTO context_delivery_instance VALUES(1,?,?,?,?)').run(randomUUID(), path, identity(lstatSync(dirname(path))), privateFile(journal));
                // Terminal metadata is compactable; ambiguous rows are never evicted to make output admissible.
                const live = new Set([...owners].map(item => item.id));
                const old = db.prepare("SELECT operation_id, owner_pid FROM context_deliveries WHERE state='projected' ORDER BY turn DESC LIMIT -1 OFFSET 256").all();
                for (const row of old) {
                    if (live.has(String(row['operation_id'])))
                        continue;
                    const pid = Number(row['owner_pid']);
                    if (!Number.isSafeInteger(pid) || pid < 1)
                        continue;
                    if (pid !== process.pid) {
                        // PID reuse/live or unverifiable foreign owners are conservatively retained.
                        // Only a dead process proves its actual OS handles can no longer be active.
                        try {
                            process.kill(pid, 0);
                            continue;
                        }
                        catch (error) {
                            if (error.code !== 'ESRCH')
                                continue;
                        }
                    }
                    db.prepare("DELETE FROM context_deliveries WHERE operation_id=? AND state='projected'").run(row['operation_id']);
                }
                if (Number(db.prepare('SELECT count(*) AS n FROM context_deliveries').get()?.['n']) >= MAX_ROWS)
                    throw new Error('context_delivery_capacity');
                budget.check();
                const turn = Number(db.prepare('SELECT coalesce(max(turn),0)+1 AS n FROM context_deliveries').get()?.['n']);
                db.prepare("INSERT INTO context_deliveries VALUES (?, 'prepared', ?, ?, NULL, ?, ?, ?, 'output_unconfirmed')").run(id, JSON.stringify(snapshot), targetIdentity, Date.now(), turn, process.pid);
                return { path, journal, identity: privateFile(journal), instance: String(db.prepare('SELECT instance FROM context_delivery_instance WHERE id=1').get()?.['instance']) };
            }, timing);
        }, undefined, false, true);
        owner.binding = binding;
        owner.id = id;
        owner.outputPending = true;
        let output = 'pending';
        const transition = (state) => database(owner, journal, db => transaction(db, () => {
            const row = db.prepare('SELECT state FROM context_deliveries WHERE operation_id=?').get(id);
            if (row?.['state'] === state)
                return;
            if (row?.['state'] !== 'prepared')
                throw new Error('delivery_output_capability_used');
            if (Number(db.prepare('UPDATE context_deliveries SET state=?, reason=? WHERE operation_id=? AND state=\'prepared\'').run(state, state === 'confirmed' ? null : 'output_unconfirmed', id).changes) !== 1)
                throw new Error('delivery_output_capability_changed');
        }), binding);
        return Object.freeze({ operationId: id,
            confirmOutput() {
                if (output !== 'pending')
                    return;
                output = 'confirmed';
                owner.outputPending = false;
                owner.confirm = () => { transition('confirmed'); owner.confirm = undefined; finish(owner); };
                owner.confirm();
            },
            outputUnknown() {
                if (output !== 'pending')
                    return;
                output = 'unknown';
                owner.outputPending = false;
                owner.outputUnknown = true;
                owner.confirm = () => { transition('output_unknown'); owner.confirm = undefined; finish(owner); };
                owner.confirm();
            },
            project: (opts = {}) => projectOwned(owner, project, opts),
            release() { owner.release = true; if (output !== 'pending')
                finish(owner); }, });
    }
    catch (error) {
        owner.release = true;
        finish(owner);
        throw error;
    }
}
function withCleanupStatus(path, result) {
    // A committed SQL projection does not release its actual native file/lock
    // owner. Synchronous writers must refuse this root until cleanup settles.
    const retained = [...owners].filter(item => item.binding?.path === path
        && (item.running || item.cleanup || item.db)).length;
    if (retained) {
        result.busy = true;
        result.reasons.cleanup_pending = retained;
    }
    return result;
}
/** Final synchronous append admission; no SQLite read can erase actual ownership. */
export function contextDeliveryRootOwned(path) {
    const target = targetPath(path);
    return activeRecoveries.has(target) || [...owners].some(item => item.binding?.path === target
        && (item.running || item.cleanup || item.db));
}
export function contextDeliveryStatus(path) {
    let owner;
    try {
        path = targetPath(path);
        const journal = `${path}.context-deliveries.sqlite`;
        try {
            privateFile(journal);
        }
        catch (error) {
            if (missing(error))
                return withCleanupStatus(path, empty());
            throw error;
        }
        owner = reserveOwner(false);
        return withCleanupStatus(path, database(owner, journal, db => {
            const result = empty();
            for (const row of db.prepare('SELECT state, count(*) AS n FROM context_deliveries GROUP BY state').all()) {
                const n = Number(row['n']);
                if (row['state'] === 'confirmed')
                    result.confirmedPending += n;
                else if (row['state'] === 'prepared' || row['state'] === 'output_unknown')
                    result.outputUnknown += n;
                else if (row['state'] === 'projecting' || row['state'] === 'projection_unknown')
                    result.projectionUnknown += n;
                else if (row['state'] === 'projected')
                    result.projected += n;
                else
                    result.busy = true;
            }
            const known = new Set(['output_unconfirmed', 'target_changed', 'history_missing', 'metadata_invalid', 'append_unconfirmed']);
            for (const row of db.prepare('SELECT reason, count(*) AS n FROM context_deliveries WHERE reason IS NOT NULL GROUP BY reason').all()) {
                if (known.has(row['reason']))
                    result.reasons[row['reason']] = Number(row['n']);
                else
                    result.busy = true;
            }
            return result;
        }, undefined, true));
    }
    catch {
        return withCleanupStatus(path, { ...empty(), busy: true });
    }
    finally {
        if (owner) {
            owner.release = true;
            finish(owner);
        }
    }
}
export async function recoverContextDeliveries(path, project, options = {}) {
    const budget = new AuditBudget(options);
    let target;
    try {
        budget.check();
        target = targetPath(path);
        budget.check();
    }
    catch {
        if (!target)
            try {
                target = canonicalEventPath(path);
            }
            catch { /* Retain any exact known owner. */ }
        return withCleanupStatus(target ?? path, { ...empty(), busy: true });
    }
    // No second recovery may start while the original Promise still owns this
    // journal. A full registry also refuses new work without evicting owners.
    if (activeRecoveries.has(target)) {
        const status = contextDeliveryStatus(target);
        return { ...status, busy: true, reasons: { ...status.reasons, cleanup_pending: status.reasons.cleanup_pending || 1 } };
    }
    if (activeRecoveries.size >= MAX_OWNERS)
        return withCleanupStatus(target, { ...empty(), busy: true });
    const actual = Promise.resolve().then(() => recoverContextDeliveriesOwned(target, project, options, budget));
    activeRecoveries.set(target, actual);
    const release = () => { if (activeRecoveries.get(target) === actual)
        activeRecoveries.delete(target); };
    void actual.then(release, release);
    return actual;
}
async function recoverContextDeliveriesOwned(path, project, options, budget) {
    let owner;
    let pendingCleanups = 0;
    const targetCleanups = [];
    try {
        let cleanups = 0;
        for (const retained of [...owners]) {
            budget.check();
            if (!retained.cleanup || retained.running)
                continue;
            if (++cleanups > 4)
                break;
            retained.running = true;
            pendingCleanups++;
            const cleanup = retained.cleanup;
            // A different journal must not wait behind this owner's native cleanup.
            // Keep admission on the actual Promise, including after caller timeout.
            const actual = Promise.resolve().then(() => cleanup.retryCleanup()).then(() => {
                if (retained.cleanup === cleanup)
                    retained.cleanup = undefined;
            }, () => { }).finally(() => {
                pendingCleanups--;
                retained.running = false;
                finish(retained);
                if (owners.has(retained)) {
                    owners.delete(retained);
                    owners.add(retained);
                }
            });
            if (retained.binding?.path === path)
                targetCleanups.push(actual);
        }
        // The target may change after the process-local reservation but before this
        // turn starts. Never move the reserved owner to a different journal.
        try {
            if (targetPath(path) !== path)
                return withCleanupStatus(path, { ...empty(), busy: true });
        }
        catch {
            return withCleanupStatus(path, { ...empty(), busy: true });
        }
        const journal = `${path}.context-deliveries.sqlite`;
        privateFile(journal);
        owner = reserveOwner();
        const live = new Set([...owners].filter(item => item.binding?.path === path).map(item => item.id));
        const rows = database(owner, journal, db => transaction(db, () => {
            const binding = { path, journal, identity: privateFile(journal), instance: String(db.prepare('SELECT instance FROM context_delivery_instance WHERE id=1').get()?.['instance']) };
            owner.binding = binding;
            const candidates = db.prepare("SELECT operation_id FROM context_deliveries WHERE state IN ('confirmed','projecting','projection_unknown') ORDER BY turn, created, operation_id LIMIT 68").all();
            const selected = candidates.filter(row => !live.has(String(row['operation_id']))).slice(0, 4);
            let turn = Number(db.prepare('SELECT coalesce(max(turn),0) AS n FROM context_deliveries').get()?.['n']);
            for (const row of selected)
                db.prepare('UPDATE context_deliveries SET turn=? WHERE operation_id=?').run(++turn, row['operation_id']);
            return selected;
        }));
        for (const row of rows) {
            budget.check();
            if (owner.cleanup)
                break; // Keep id bound to the exact retained cleanup.
            owner.id = String(row['operation_id']);
            await projectOwned(owner, project, options);
        }
    }
    catch { /* Busy/corrupt/expired admission leaves original durable state untouched. */ }
    finally {
        if (owner) {
            owner.release = true;
            finish(owner);
        }
        // The admission deadline cannot detach same-root cleanup ahead of a
        // synchronous writer. Foreign roots retain their independent bounded turn.
        await Promise.all(targetCleanups);
        // Preserve completed cleanup/capacity evidence for this call, but only wait
        // within its original budget. The continuation above owns late completion.
        try {
            while (pendingCleanups > 0)
                await budget.pause();
        }
        catch { /* Timeout/abort detaches this wait; it does not release retained owners. */ }
    }
    return contextDeliveryStatus(path);
}
/** Archiver already owns the root writer lock. Publish exact locators before replacing the active log. */
export function relocateContextDeliveryProjections(path, locate, targets) {
    path = targetPath(path);
    const journal = `${path}.context-deliveries.sqlite`;
    try {
        privateFile(journal);
    }
    catch (error) {
        if (missing(error))
            return;
        throw error;
    }
    const owner = reserveOwner(false);
    try {
        database(owner, journal, db => transaction(db, () => {
            const rows = db.prepare("SELECT operation_id, plan FROM context_deliveries WHERE state IN ('projecting','projection_unknown','projected') AND plan IS NOT NULL").all();
            if (rows.length > MAX_ROWS)
                throw new Error('delivery_journal_capacity');
            for (const row of rows) {
                const plan = JSON.parse(String(row['plan']));
                if (plan.archive)
                    continue;
                const found = locate(plan.line);
                const original = plan.identity === targets.before ? plan : plan.previous?.identity === targets.before ? plan.previous : undefined;
                if (found && Number(db.prepare('UPDATE context_deliveries SET plan=? WHERE operation_id=? AND plan=?')
                    .run(JSON.stringify({ line: plan.line, ...found, ...(original ? { previous: { offset: original.offset, identity: original.identity,
                            ...(original.archive ? { archive: original.archive } : {}) } } : {}) }), row['operation_id'], row['plan']).changes) !== 1)
                    throw new Error('delivery_archive_changed');
            }
            // Rename and SQLite cannot commit atomically. Both exact generations remain admissible
            // until the next locked projection observes which publication actually occurred.
            const pending = db.prepare("SELECT operation_id,target_identity FROM context_deliveries WHERE state IN ('prepared','confirmed')").all();
            for (const row of pending) {
                const value = row['target_identity'];
                const identities = typeof value === 'string' && value.startsWith('[') ? JSON.parse(value) : [value];
                if ((value === null || identities.includes(targets.before)) && Number(db.prepare('UPDATE context_deliveries SET target_identity=? WHERE operation_id=?')
                    .run(JSON.stringify([targets.before, targets.after]), row['operation_id']).changes) !== 1)
                    throw new Error('delivery_archive_changed');
            }
        }));
    }
    finally {
        owner.release = true;
        finish(owner);
    }
}