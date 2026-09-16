import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { util } from '@evomap/evolver-core';
import { AtpHubClient } from '@evomap/evolver-adapter-public';
import { resolveAtpHome } from './atp.js';
export const COMPLETION_LEDGER_FILENAME = 'task-complete-pending.json';
const COMPLETION_RETRY_BASE_MS = 60_000;
const COMPLETION_RETRY_CAP_MS = 60 * 60_000;
const COMPLETION_MAX_ATTEMPTS = 8;
const COMPLETION_RETRIES_PER_TICK = 5;
/** A queue name that never comes free is a name we are not getting; stop owing it. */
const UNQUEUED_MAX_ATTEMPTS = 8;
export function completionLedgerPath(env = process.env) {
    return join(resolveAtpHome(env), 'evolution', COMPLETION_LEDGER_FILENAME);
}
export function readCompletionLedger(path) {
    try {
        if (!existsSync(path))
            return { version: 1, pending: {}, unqueued: {}, owned: {} };
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        return {
            version: 1,
            pending: parsed?.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
            unqueued: parsed?.unqueued && typeof parsed.unqueued === 'object' ? parsed.unqueued : {},
            owned: parsed?.owned && typeof parsed.owned === 'object' ? parsed.owned : {},
        };
    }
    catch {
        return { version: 1, pending: {}, unqueued: {}, owned: {} };
    }
}
/**
 * Hold the ledger for one read-modify-write. Without it two writers read the same version,
 * both replace the file, both are told they succeeded, and one update is simply gone — a
 * unique temp name per write stops them corrupting each other's bytes, not their meaning.
 *
 * The lock is `util.acquireLock`, the one the daemon already uses for its single-instance
 * guard: it reclaims by checking whether the owning pid is alive rather than by guessing
 * from an mtime, and it has been carrying that weight in this codebase for far longer than
 * anything written here would have.
 */
function withLedgerLock(path, held, unavailable) {
    const lock = `${path}.lock`;
    try {
        mkdirSync(dirname(path), { recursive: true });
        util.acquireLock(lock, { maxTries: 60, waitMs: 25 });
    }
    catch {
        return unavailable;
    }
    try {
        return held();
    }
    finally {
        util.releaseLock(lock);
    }
}
/**
 * Read the ledger, change it, and put it back as one step — the only way any of this file
 * mutates it. Returning null from `change` means "nothing to do" and leaves it untouched.
 */
function updateCompletionLedger(path, change) {
    return withLedgerLock(path, () => {
        const next = change(readCompletionLedger(path));
        return next === null ? true : replaceCompletionLedger(path, next);
    }, false);
}
/** False when the ledger could not be persisted — the caller decides what that costs. */
function replaceCompletionLedger(path, ledger) {
    // Unique per write, not per process: a worker thread shares the pid with its parent.
    const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
        renameSync(temporary, path);
        return true;
    }
    catch {
        // A failed rename leaves the temp file behind, and every attempt now picks a new name,
        // so sweeping it up here is what keeps a retry loop from filling the directory.
        rmSync(temporary, { force: true });
        return false;
    }
}
export function rememberUnqueued(path, queueTask, error) {
    updateCompletionLedger(path, (ledger) => ({
        ...ledger,
        unqueued: { ...(ledger.unqueued ?? {}), [queueTask.id]: { taskId: queueTask.id, queueTask, attempts: (ledger.unqueued?.[queueTask.id]?.attempts ?? 0) + 1, lastError: error } },
    }));
}
/**
 * Release a claim — but only the filing named, when one is. A retry round that decided in
 * favour of dropping an old claim shares its queue id with whatever was registered since,
 * and deleting by id alone takes that newer filing's ownership with it.
 */
function forgetOwned(path, queueTaskId, generation) {
    updateCompletionLedger(path, (ledger) => {
        const held = ledger.owned?.[queueTaskId];
        if (!held)
            return null;
        if (generation !== undefined && held.generation !== generation)
            return null;
        const owned = { ...ledger.owned };
        delete owned[queueTaskId];
        return { ...ledger, owned };
    });
}
/** The same claim, not merely the same task id: filing and attempt both have to agree. */
function sameClaim(current, other) {
    if (!current || !other)
        return false;
    return current.queueTask.generation === other.queueTask.generation && current.attempts === other.attempts;
}
/**
 * The same debt, not merely the same task. Asset, attempt and filing all have to agree:
 * two filings can produce the same asset on the same attempt and still be different work.
 */
function sameDebt(current, other) {
    if (!current || !other)
        return false;
    return current.resultAssetId === other.resultAssetId
        && current.attempts === other.attempts
        && current.generation === other.generation;
}
/** A deadline the clock has passed. An absent one is not expired — it is unknown. */
function lapsed(deadline, nowMs) {
    if (!deadline)
        return false;
    const parsed = Date.parse(deadline);
    return Number.isFinite(parsed) && parsed <= nowMs;
}
/** A commitment the Hub has stopped holding for us; it is free to re-dispatch the task. */
function commitmentExpired(claim, nowMs) {
    return lapsed(claim?.commitmentDeadline, nowMs);
}
function retryDelayMs(attempts) {
    return Math.min(COMPLETION_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), COMPLETION_RETRY_CAP_MS);
}
/** Queue ids the receiver writes carry this prefix, so the loop can tell hub work apart. */
export const HUB_QUEUE_PREFIX = 'hub-';
/** A task id becomes a filename, so it may only be what a filename may safely be. */
/** The queue entry already under this id, or null when there is none we can read. */
export function defaultReadQueueTask(dir, id) {
    try {
        const parsed = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
        return typeof parsed?.hubTaskId === 'string' ? parsed : null;
    }
    catch {
        return null;
    }
}
export function defaultWriteQueueTask(dir, task) {
    writeFileSync(join(dir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}
export function defaultRemoveQueueTask(dir, id) {
    rmSync(join(dir, `${id}.json`), { force: true });
}
function alreadyQueued(error) {
    return error?.code === 'EEXIST';
}
/**
 * File a claimed task under its queue id. An `EEXIST` is only "an earlier beat already did
 * this" when the register says that queue id is ours; otherwise the name belongs to a local
 * task, and treating the collision as success would hand its capsule to the Hub.
 */
export function fileClaim(deps, queueDir, claim) {
    // One write-ahead record before the queue file: the claim is already spent at the Hub,
    // so a crash here must leave behind both who owns the task (`owned`, or it can never be
    // delivered) and that it still needs queueing (`unqueued`, or nothing will retry it).
    const recorded = updateCompletionLedger(deps.ledgerPath, (ledger) => ({
        ...ledger,
        owned: { ...(ledger.owned ?? {}), [claim.id]: { queueTaskId: claim.id, hubTaskId: claim.hubTaskId, generation: claim.generation, ...(claim.commitmentDeadline ? { commitmentDeadline: claim.commitmentDeadline } : {}) } },
        unqueued: { ...(ledger.unqueued ?? {}), [claim.id]: { taskId: claim.id, queueTask: claim, attempts: ledger.unqueued?.[claim.id]?.attempts ?? 0, lastError: 'not queued yet' } },
    }));
    if (!recorded)
        return 'unrecorded';
    try {
        deps.write(queueDir, claim);
    }
    catch (error) {
        if (!alreadyQueued(error))
            throw error;
        // The name is taken. Only the file on disk can say by what — a register entry from a
        // previous filing proves nothing about what is sitting there now, and believing it is
        // how a local task's capsule gets reported as this claim's result.
        const existing = (deps.read ?? defaultReadQueueTask)(queueDir, claim.id);
        if (existing?.hubTaskId !== claim.hubTaskId) {
            // Not this claim's queue entry, so not its registration either: leaving it would make
            // `claimFor` answer for a task we never filed. Only this filing's registration goes —
            // the one written moments ago, above. The claim stays owed in `unqueued`.
            forgetOwned(deps.ledgerPath, claim.id, claim.generation);
            return 'name_taken';
        }
        if (existing.generation !== claim.generation) {
            // Same task, earlier filing. The Hub only let us claim it again because that filing
            // is over, so its queue entry is stale work: replace it. Taking its generation
            // instead would let that run's late result walk through the gate as this claim's.
            // Drop then create exclusively, so a file that changed between the read and the
            // write collides again instead of being silently overwritten.
            (deps.remove ?? defaultRemoveQueueTask)(queueDir, claim.id);
            deps.write(queueDir, claim);
        }
    }
    clearUnqueued(deps.ledgerPath, claim.id);
    return 'written';
}
function clearUnqueued(path, queueTaskId) {
    updateCompletionLedger(path, (ledger) => {
        if (!ledger.unqueued?.[queueTaskId])
            return null;
        const unqueued = { ...ledger.unqueued };
        delete unqueued[queueTaskId];
        return { ...ledger, unqueued };
    });
}
/**
 * Write the debt down, unless it is no longer owed. A report that failed while an
 * overlapping one succeeded must not come back as a pending debt: the Hub already has the
 * result, and re-sending it is how a settled task starts failing as `not_claimed`.
 * Returns false when nothing was recorded, so no caller promises a retry that will not come.
 */
function oweCompletion(ledgerPath, taskId, resultAssetId, error, nowMs, settled, generation) {
    if (settled?.())
        return false;
    return updateCompletionLedger(ledgerPath, (ledger) => {
        // A debt belongs to one filing. A later filing's first failure is its first attempt,
        // not the continuation of a budget the previous one spent.
        const prior = ledger.pending[taskId];
        const continues = prior !== undefined && (prior.generation ?? generation) === generation;
        const attempts = (continues ? prior.attempts : 0) + 1;
        return { ...ledger, pending: { ...ledger.pending, [taskId]: { taskId, resultAssetId, attempts, nextAttemptMs: nowMs + retryDelayMs(attempts), lastError: error, ...(generation ? { generation } : {}) } } };
    });
}
/**
 * What a wiring with no Hub client can still do: write the debt down. A task claimed before
 * a restart finishes in a process that may have no identity left, and dropping the report
 * there is the one outcome the Hub cannot recover from — it waits out the whole commitment.
 */
/** A thrown transport error is the same event as a refusal, and must not escape the loop. */
async function hubComplete(client, taskId, assetId) {
    try {
        const result = await client.completeTask(taskId, assetId);
        return result.ok ? { ok: true } : { ok: false, error: result.error ?? `hub ${result.status ?? 0}` };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
const NO_RETRIES = async () => ({ retried: 0, completed: 0, abandoned: 0, pending: 0, unrecorded: 0, abandonedTasks: [] });
const NO_QUEUE_RETRIES = async () => ({ retried: 0, queued: 0, pending: 0, dropped: 0 });
export function unsentCommitments(ledgerPath, now) {
    return {
        claimFor: (queueTaskId) => readCompletionLedger(ledgerPath).owned?.[queueTaskId] ?? null,
        complete: async (taskId, resultAssetId, generation) => {
            // The same gate as the live wiring: a debt is only worth recording for a claim this
            // node actually holds, under the filing that holds it.
            const owned = readCompletionLedger(ledgerPath).owned?.[`${HUB_QUEUE_PREFIX}${taskId}`];
            if (!owned)
                return { taskId, completed: false, error: 'not_claimed' };
            if (owned.generation !== generation)
                return { taskId, completed: false, error: 'stale_generation' };
            // Nothing can send this now, so writing it down is the whole job — and claiming a
            // retry the ledger never recorded would promise a delivery no later run can make.
            const recorded = oweCompletion(ledgerPath, taskId, resultAssetId, 'task_receiver_disabled', now(), undefined, generation);
            return { taskId, completed: false, error: 'task_receiver_disabled', ...(recorded ? { pending: true } : { unrecorded: true }) };
        },
        retryCompletions: NO_RETRIES,
        retryQueueWrites: NO_QUEUE_RETRIES,
    };
}
export function liveCommitments(client, deps) {
    const { ledgerPath, now, queueDir } = deps;
    // Clearing a debt is itself a ledger write, and a write that did not land leaves the
    // record disagreeing with what the caller was told. `unrecorded` says so out loud.
    // Clearing a debt is itself a ledger write, and a write that did not land leaves the
    // record disagreeing with what the caller was told. `unrecorded` says so out loud.
    // The claim only goes with it when it is the claim this debt was made under: a later
    // filing shares the task id and is still held.
    const settle = (taskId, outcome, generation) => {
        const persisted = updateCompletionLedger(ledgerPath, (ledger) => {
            const queueTaskId = `${HUB_QUEUE_PREFIX}${taskId}`;
            const owned = { ...(ledger.owned ?? {}) };
            // The claim goes only when this debt can prove the claim is its own. A debt written
            // before the field existed cannot prove it, and an unknown generation must not read
            // as a wildcard: releasing a claim that a later filing now holds is worse than
            // leaving a dead register entry for the next filing to overwrite.
            if (generation !== undefined && owned[queueTaskId]?.generation === generation)
                delete owned[queueTaskId];
            const pending = { ...ledger.pending };
            // The debt itself is this task's either way: a legacy entry has no filing to belong
            // to, and one naming a later filing is not the entry this settle was called for.
            const debt = pending[taskId];
            if (debt && (debt.generation === undefined || debt.generation === generation))
                delete pending[taskId];
            return { ...ledger, pending, owned };
        });
        return persisted ? outcome : { ...outcome, unrecorded: true };
    };
    // A debt is only this attempt's to settle while the ledger still holds the entry the
    // attempt was made against. A late response must never clear a newer one for another asset.
    const stillOurs = (entry) => {
        const current = readCompletionLedger(ledgerPath).pending[entry.taskId];
        return sameDebt(current, entry);
    };
    // A task the register has let go of has been settled — by this pass or an overlapping
    // one — and its debt is paid. `held` is read before the Hub call, so a claim that was
    // never registered (an old ledger) does not read as "settled" here.
    // Settled, or moved on: either way this filing no longer holds the claim, and a debt
    // recorded for it now would block the filing that does from recording its own.
    const settledSince = (taskId, held, generation) => () => {
        if (!held)
            return false;
        const owned = readCompletionLedger(ledgerPath).owned?.[`${HUB_QUEUE_PREFIX}${taskId}`];
        return owned === undefined || owned.generation !== generation;
    };
    // Two reports for the same task can fail out of order. `before` is what the ledger held
    // when this attempt started; anything else on record now is a later word than this one.
    const supersededSince = (taskId, before) => () => {
        const current = readCompletionLedger(ledgerPath).pending[taskId];
        if (!current)
            return false;
        return !sameDebt(current, before);
    };
    const owe = (taskId, resultAssetId, error, settled, generation) => {
        const recorded = oweCompletion(ledgerPath, taskId, resultAssetId, error, now(), settled, generation);
        // Only a recorded debt is a promised retry; an unwritable ledger has to say so.
        return { taskId, completed: false, error, ...(recorded ? { pending: true } : { unrecorded: true }) };
    };
    const report = async (taskId, resultAssetId, generation) => {
        const opening = readCompletionLedger(ledgerPath);
        const owned = opening.owned?.[`${HUB_QUEUE_PREFIX}${taskId}`];
        const wasHeld = Boolean(owned);
        const before = opening.pending[taskId];
        // Only a claim this node registered may be completed, and only by the filing that
        // holds it. No record, or a record from a later filing, and the result is not ours to
        // hand over — the Hub cannot take a completion back once it has one.
        if (!owned)
            return { taskId, completed: false, error: 'not_claimed' };
        if (owned.generation !== generation)
            return { taskId, completed: false, error: 'stale_generation' };
        // The Hub holds a task for its claimant only until the commitment runs out. Past that
        // it may have re-dispatched the work, and a late report would overwrite whoever now
        // owns it — so stop, and name the orphaned asset loudly enough to be recoverable.
        if (commitmentExpired(owned, now())) {
            // This filing's commitment is over, so this filing's claim goes with it — scoped, so
            // a re-claim that happened in the meantime keeps the claim it made.
            return settle(taskId, { taskId, completed: false, error: 'commitment_expired' }, generation);
        }
        const result = await hubComplete(client, taskId, resultAssetId);
        const stale = settledSince(taskId, wasHeld, generation);
        const superseded = supersededSince(taskId, before);
        // The Hub has this asset. Whatever this filing owed is paid, including a debt another
        // attempt of the SAME filing recorded while we waited — leaving it would re-send a
        // completed task. A later filing's debt is another claim's and stays.
        if (result.ok)
            return settle(taskId, { taskId, completed: true }, generation);
        // The work is done and the Hub does not know it. Owe the report and retry it on
        // later beats — otherwise a transient 429 silently costs us the whole delivery.
        return owe(taskId, resultAssetId, result.error, () => stale() || superseded(), generation);
    };
    return {
        claimFor: (queueTaskId) => readCompletionLedger(ledgerPath).owned?.[queueTaskId] ?? null,
        complete: report,
        retryQueueWrites: async () => {
            const ledger = readCompletionLedger(ledgerPath);
            const owed = Object.values(ledger.unqueued ?? {});
            const out = { retried: 0, queued: 0, pending: owed.length, dropped: 0 };
            if (owed.length === 0 || !queueDir)
                return out;
            // What this pass decided, key by key. Replacing the whole `unqueued` map with a
            // snapshot taken before the work would delete any claim another writer filed while
            // this pass ran — the lock protects the write, not a stale picture carried into it.
            const settled = new Set();
            const requeued = new Map();
            const seen = new Map(owed.map((entry) => [entry.taskId, entry]));
            for (const entry of owed) {
                // A claim whose commitment ran out is not work any more, and neither is one whose
                // queue name is permanently taken: both would otherwise sit here being retried for
                // the life of the process.
                if (lapsed(entry.queueTask.commitmentDeadline, now()) || entry.attempts >= UNQUEUED_MAX_ATTEMPTS) {
                    settled.add(entry.taskId);
                    forgetOwned(ledgerPath, entry.taskId, entry.queueTask.generation);
                    out.dropped += 1;
                    continue;
                }
                out.retried += 1;
                try {
                    const filed = fileClaim(deps, queueDir, entry.queueTask);
                    if (filed === 'name_taken' || filed === 'unrecorded') {
                        requeued.set(entry.taskId, { ...entry, attempts: entry.attempts + 1, lastError: filed === 'name_taken' ? 'queue id taken by another task' : 'ownership could not be recorded' });
                        continue;
                    }
                    settled.add(entry.taskId);
                    out.queued += 1;
                }
                catch (error) {
                    requeued.set(entry.taskId, { ...entry, attempts: entry.attempts + 1, lastError: error instanceof Error ? error.message : String(error) });
                }
            }
            updateCompletionLedger(ledgerPath, (ledger) => {
                const unqueued = { ...(ledger.unqueued ?? {}) };
                // Each key is written back only while it still holds the claim this pass answered
                // for. A filing recorded by another writer meanwhile shares the task id and is not
                // this pass's to delete or to overwrite with an older generation and attempt count.
                for (const taskId of settled) {
                    if (sameClaim(unqueued[taskId], seen.get(taskId)))
                        delete unqueued[taskId];
                }
                for (const [taskId, entry] of requeued) {
                    if (sameClaim(unqueued[taskId], seen.get(taskId)))
                        unqueued[taskId] = entry;
                }
                return { ...ledger, unqueued };
            });
            out.pending = Object.keys(readCompletionLedger(ledgerPath).unqueued ?? {}).length;
            return out;
        },
        retryCompletions: async () => {
            const ledger = readCompletionLedger(ledgerPath);
            // Oldest due first, not insertion order: a fixed slice of an unsorted map lets the
            // same five debts hold every slot forever while the ones behind them expire unsent.
            const due = Object.values(ledger.pending)
                .filter((entry) => entry.nextAttemptMs <= now())
                .sort((left, right) => left.nextAttemptMs - right.nextAttemptMs)
                .slice(0, COMPLETION_RETRIES_PER_TICK);
            const out = { retried: 0, completed: 0, abandoned: 0, pending: Object.keys(ledger.pending).length, unrecorded: 0, abandonedTasks: [] };
            for (const entry of due) {
                out.retried += 1;
                const owned = readCompletionLedger(ledgerPath).owned?.[`${HUB_QUEUE_PREFIX}${entry.taskId}`];
                if (commitmentExpired(owned, now())) {
                    if (!stillOurs(entry))
                        continue;
                    // A debt the ledger still holds has not been let go of, whatever this tick says.
                    if (settle(entry.taskId, { taskId: entry.taskId, completed: false }, entry.generation).unrecorded) {
                        out.unrecorded += 1;
                        continue;
                    }
                    out.abandoned += 1;
                    out.abandonedTasks.push({ taskId: entry.taskId, resultAssetId: entry.resultAssetId, lastError: 'commitment_expired' });
                    continue;
                }
                // The same gate the first report passed: a debt with no claim behind it, or one
                // whose claim moved on to a later filing, is not ours to send. Drop it, and leave
                // any claim that is not this debt's alone — it is still held.
                if (!owned || owned.generation !== entry.generation) {
                    if (stillOurs(entry))
                        settle(entry.taskId, { taskId: entry.taskId, completed: false }, entry.generation);
                    continue;
                }
                const result = await hubComplete(client, entry.taskId, entry.resultAssetId);
                if (result.ok) {
                    // The Hub has the result; the record must go even if a newer debt replaced it.
                    if (settle(entry.taskId, { taskId: entry.taskId, completed: true }, entry.generation).unrecorded)
                        out.unrecorded += 1;
                    out.completed += 1;
                    continue;
                }
                // Both outcomes below rewrite the ledger, so both need the same proof that this
                // attempt's debt is still the one on record — giving up is a deletion, and a stale
                // response must not delete a newer debt any more than it may overwrite one.
                if (!stillOurs(entry))
                    continue;
                const attempts = entry.attempts + 1;
                if (attempts >= COMPLETION_MAX_ATTEMPTS) {
                    if (settle(entry.taskId, { taskId: entry.taskId, completed: false }, entry.generation).unrecorded) {
                        out.unrecorded += 1;
                        continue;
                    }
                    out.abandoned += 1;
                    out.abandonedTasks.push({ taskId: entry.taskId, resultAssetId: entry.resultAssetId, lastError: result.error });
                    continue;
                }
                const written = updateCompletionLedger(ledgerPath, (ledger) => {
                    // Re-checked under the lock, not merely before it: the debt may have been
                    // settled or replaced between the check above and this write.
                    if (!sameDebt(ledger.pending[entry.taskId], entry))
                        return null;
                    return { ...ledger, pending: { ...ledger.pending, [entry.taskId]: { ...entry, attempts, nextAttemptMs: now() + retryDelayMs(attempts), lastError: result.error } } };
                });
                if (!written)
                    out.unrecorded += 1;
            }
            out.pending = Object.keys(readCompletionLedger(ledgerPath).pending).length;
            return out;
        },
    };
}
/** The Hub task id behind an execute-queue id, or null when the task is local. */
export function hubTaskIdOf(queueTaskId) {
    return queueTaskId.startsWith(HUB_QUEUE_PREFIX) ? queueTaskId.slice(HUB_QUEUE_PREFIX.length) : null;
}