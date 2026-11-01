import { constants } from 'node:fs';
import { open, opendir, mkdir, lstat, link, unlink, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { asyncFileLockOwners as retainedAuditOwners, asyncFileLockOwned, asyncFileLockKey } from '../util/asyncFileLockOwners.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { openWindowsAuditFile, withWindowsAuditLock } from './boundedAuditWindows.js';
import { AuditCleanupError, auditCleanupSequence, withAuditCleanup } from './auditCleanup.js';
export class AuditWriteSkipped extends Error {
    reason;
    constructor(reason) {
        super(`audit skipped: ${reason}`);
        this.reason = reason;
    }
}
export class WindowsAuditNameBusyError extends AuditWriteSkipped {
    status;
    code = 'EBUSY';
    constructor(status) {
        super('windows_io_failed');
        this.status = status;
    }
}
/** Shared only by durable context preparation and its stdout admission callers. */
export const DEFAULT_CONTEXT_PREPARATION_BUDGET_MS = 750;
export class AuditBudget {
    options;
    deadline;
    constructor(options = {}, phase = 'audit') {
        this.options = options;
        // Experience business recovery/outbox has its own coordinator window, not
        // a Root admission budget. Root append/recovery must use the audit phase.
        // Shorter callers always win; ordinary audit retains 250ms default / 500ms cap.
        const cap = phase === 'context_preparation' ? DEFAULT_CONTEXT_PREPARATION_BUDGET_MS : phase === 'experience' ? 30_000 : 500;
        const requested = options.deadlineAt ?? Date.now() + (phase === 'audit' ? 250 : cap);
        const remaining = Number.isFinite(requested) ? requested - Date.now() : 0;
        this.deadline = performance.now() + Math.max(0, Math.min(cap, remaining));
    }
    check() {
        if (this.options.signal?.aborted || performance.now() >= this.deadline)
            throw new AuditWriteSkipped('cancelled_or_expired');
    }
    async pause() {
        this.check();
        await new Promise((resolve) => {
            const finish = () => { clearTimeout(timer); this.options.signal?.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, Math.min(10, Math.max(0, this.deadline - performance.now())));
            this.options.signal?.addEventListener('abort', finish, { once: true });
        });
        this.check();
    }
}
function flags() {
    // Platforms without safe no-follow/nonblocking opens fail closed, not back to stat-then-open.
    if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK)
        throw new AuditWriteSkipped('safe_open_unavailable');
    return constants.O_NOFOLLOW | constants.O_NONBLOCK;
}
export function regularAuditFile(stat, maxBytes) {
    if (!stat.isFile() || stat.nlink !== 1)
        throw new AuditWriteSkipped('not_private_regular_file');
    if (stat.size > maxBytes)
        throw new AuditWriteSkipped('file_too_large');
}
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const isMissing = (error) => error?.code === 'ENOENT';
async function statIfPresent(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
}
/** Open first, validate the actual descriptor, and continue using that descriptor. No unsafe reopen by name. */
export async function openAuditFile(path, maxBytes, budget, existingOnly = false) {
    budget.check();
    if (process.platform === 'win32')
        return openWindowsAuditFile(path, maxBytes, budget, undefined, existingOnly);
    if (!existingOnly)
        await mkdir(dirname(path), { recursive: true });
    budget.check();
    const handle = await open(path, constants.O_RDWR | constants.O_APPEND | (existingOnly ? 0 : constants.O_CREAT) | flags(), 0o600);
    try {
        budget.check();
        const stat = await handle.stat();
        regularAuditFile(stat, maxBytes);
        const named = await lstat(path);
        if (!sameInode(stat, named) || named.isSymbolicLink())
            throw new AuditWriteSkipped('path_changed');
        budget.check();
        return handle;
    }
    catch (error) {
        // Validation has not handed the descriptor to a caller. Preserve its exact
        // acquisition and the validation error if closing it also fails.
        return withAuditCleanup(async () => { throw error; }, auditCleanupSequence([{ run: () => handle.close(), retryFailedOperation: true }]));
    }
}
/** One bounded write, no appendFile retry loop and no Promise.race leaving a late writer behind. */
export async function commitAuditLine(handle, line, maxFileBytes, budget, rollbackShortWrite = true, boundary) {
    const bytes = Buffer.from(line, 'utf8');
    if (bytes.length > 4096)
        throw new AuditWriteSkipped('line_too_large');
    const stat = await handle.stat();
    regularAuditFile(stat, maxFileBytes - bytes.length);
    budget.check(); // cancellation's commit boundary: no write is submitted after cancellation
    boundary?.dispatched(); // Conservatively includes native queue/preflight; never claims no dispatch after this point.
    const result = await handle.write(bytes, 0, bytes.length, null);
    if (result.bytesWritten !== bytes.length) {
        // Only the root-event protocol excludes every other writer. A shared advisory log
        // must never truncate bytes that an older non-cooperating appender may have added.
        if (rollbackShortWrite) {
            await handle.truncate(stat.size);
            await handle.sync();
            boundary?.rolledBack();
        }
        throw new AuditWriteSkipped('short_write');
    }
    await handle.sync(); // success means fsync confirmed; failures never become a claimed receipt
}
async function readOwner(path, budget) {
    budget?.check();
    let fd;
    try {
        fd = await open(path, constants.O_RDONLY | flags());
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
    return withAuditCleanup(async () => {
        const stat = await fd.stat();
        // A normal writer can unlink its owner/guard after this read acquired the
        // descriptor. An unlinked inode grants no authority over the current name.
        if (stat.isFile() && stat.nlink === 0)
            return undefined;
        // Two links are only eligible for publication recovery after proving a dead owner
        // and finding its exact staging inode. They never qualify as a normal lock snapshot.
        const publishing = Boolean(budget && stat.isFile() && stat.nlink === 2 && stat.size <= 4096);
        if (!publishing)
            regularAuditFile(stat, 4096);
        const buffer = Buffer.alloc(4097);
        const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 4096)
            throw new AuditWriteSkipped('lock_too_large');
        const named = await statIfPresent(path);
        // Release and successor publication may happen during stat/read. Keep the
        // snapshot unavailable; the acquisition loop must inspect the new owner and
        // must never reclaim it using the old descriptor's PID/token. Cleanup is still
        // awaited, and non-ENOENT I/O errors and unsafe names continue to fail closed.
        if (!named || (named.isFile() && !sameInode(stat, named)))
            return undefined;
        if (named.isSymbolicLink() || !named.isFile() || stat.size !== named.size)
            throw new AuditWriteSkipped('lock_changed');
        let pid;
        let token;
        try {
            const owner = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
            if (Number.isSafeInteger(owner.pid) && owner.pid > 0)
                pid = owner.pid;
            if (typeof owner.token === 'string')
                token = owner.token;
        }
        catch { /* malformed owners are busy, never stolen on the prompt path */ }
        budget?.check();
        if (publishing && (!token || !dead(pid)))
            return undefined;
        return { stat, ...(pid ? { pid } : {}), ...(token ? { token } : {}) };
    }, auditCleanupSequence([{ run: () => fd.close(), retryFailedOperation: true }]));
}
function dead(pid) {
    if (!pid)
        return false;
    try {
        process.kill(pid, 0);
        return false;
    }
    catch (error) {
        return error.code === 'ESRCH';
    }
}
/**
 * Async participant in util/fileLock's existing protocol: the same .lock/.mutation/.guardian names,
 * POSIX publishes v1 PID/token owners and conservatively preserves live PIDs without shelling out
 * for identity. Windows uses its fixed native process-start reader and v2 owners, so proven PID
 * reuse is recoverable. Neither backend reclaims malformed/unverifiable owners or transfers ownership.
 */
const MAX_RETAINED_AUDIT_OWNERS = 64;
/** Synchronous writers must not wait on a same-loop async owner's cleanup. */
export const auditLockOwned = asyncFileLockOwned;
/** Retain cleanup even when a best-effort caller discards its error/receipt. */
export async function withAuditLock(path, budget, run) {
    budget.check();
    const key = asyncFileLockKey(path);
    const owner = {};
    for (;;) {
        budget.check();
        for (const [name, prior] of retainedAuditOwners) {
            if (prior.failure?.cleanupComplete)
                retainedAuditOwners.delete(name);
        }
        const prior = retainedAuditOwners.get(key);
        if (!prior) {
            // Reserve before allocating resources; never evict a failed cleanup capability.
            if (retainedAuditOwners.size >= MAX_RETAINED_AUDIT_OWNERS) {
                // Old paths may never be used again. Reclaim only confirmed inactive cleanup,
                // never an active operation, and never replay the owner's business callback.
                for (const [name, pending] of [...retainedAuditOwners]) {
                    budget.check();
                    if (!pending.failure)
                        continue;
                    try {
                        await pending.failure.retryCleanup();
                    }
                    catch {
                        continue;
                    }
                    if (retainedAuditOwners.get(name) === pending)
                        retainedAuditOwners.delete(name);
                    if (retainedAuditOwners.size < MAX_RETAINED_AUDIT_OWNERS)
                        break;
                }
                if (retainedAuditOwners.size >= MAX_RETAINED_AUDIT_OWNERS)
                    throw new AuditWriteSkipped('cleanup_capacity');
                continue; // Recheck admission after await: another caller may now own this key.
            }
            retainedAuditOwners.set(key, owner);
            break;
        }
        if (prior.failure) {
            await prior.failure.retryCleanup();
            if (retainedAuditOwners.get(key) === prior)
                retainedAuditOwners.delete(key);
        }
        else
            await budget.pause();
    }
    try {
        return await withAuditLockOwned(path, budget, run);
    }
    catch (error) {
        if (error instanceof AuditCleanupError)
            owner.failure = error;
        throw owner.failure ?? error;
    }
    finally {
        if (!owner.failure && retainedAuditOwners.get(key) === owner)
            retainedAuditOwners.delete(key);
    }
}
async function withAuditLockOwned(path, budget, run) {
    budget.check();
    if (process.platform === 'win32')
        return withWindowsAuditLock(path, budget, run);
    await mkdir(dirname(path), { recursive: true });
    const guardPath = join(dirname(path), `.${basename(path)}.mutation`);
    const guardianPath = join(dirname(path), `.${basename(path)}.guardian`);
    const token = randomUUID();
    const owner = `${JSON.stringify({ v: 1, pid: process.pid, token })}\n`;
    const publishedNames = new Set();
    const releasedNames = new Map();
    const retainedOwnerReads = new Set();
    async function readLockOwner(target, readBudget) {
        try {
            const owner = await readOwner(target, readBudget);
            if (owner?.stat.nlink !== 2)
                return owner;
            if (!readBudget || !await recoverPublication(target, owner, readBudget))
                return undefined;
            const recovered = await readOwner(target, readBudget);
            return recovered?.stat.nlink === 2 ? undefined : recovered;
        }
        catch (error) {
            // An owner read may itself run inside outer lock cleanup. Its capability
            // must remain reachable even when nested in an aggregate cleanup error.
            if (error instanceof AuditCleanupError)
                retainedOwnerReads.add(error);
            throw error;
        }
    }
    async function recoverPublication(target, snapshot, readBudget) {
        // A crash can leave either the original staging name or our recovery tombstone.
        // Bound directory work by the shared deadline, and never guess at arbitrary
        // external hardlink names. Restarting at a fixed first-64 prefix on every retry
        // permanently strands a valid recovery name behind unrelated directory entries.
        const prefixes = ['publishing', 'publishing-recovery'].map(kind => `.${basename(target)}.${kind}.${snapshot.pid}.`);
        const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
        const matches = (stat) => Boolean(stat && !stat.isSymbolicLink() && stat.isFile()
            && sameInode(stat, snapshot.stat) && stat.nlink === 2 && stat.size === snapshot.stat.size && stat.mtimeMs === snapshot.stat.mtimeMs);
        // New publications encode their immutable owner token in the staging name so
        // recovery does not depend on directory size/order. Scan only for legacy names.
        const direct = snapshot.token && uuid.test(snapshot.token) ? join(dirname(target), `${prefixes[0]}${snapshot.token}`) : undefined;
        let candidate = direct && matches(await statIfPresent(direct)) ? direct : undefined;
        if (!candidate) {
            const directory = await opendir(dirname(target), { bufferSize: 32 });
            candidate = await withAuditCleanup(async () => {
                for (;;) {
                    readBudget.check();
                    const entry = await directory.read();
                    if (!entry)
                        break;
                    const prefix = prefixes.find(prefix => entry.name.startsWith(prefix));
                    if (!prefix || !uuid.test(entry.name.slice(prefix.length)))
                        continue;
                    const path = join(dirname(target), entry.name), stat = await statIfPresent(path);
                    if (matches(stat))
                        return path;
                }
                return undefined;
            }, auditCleanupSequence([{ run: () => directory.close(), retryFailedOperation: true }]));
        }
        if (!candidate)
            return false;
        readBudget.check();
        if (!dead(snapshot.pid))
            return false;
        const original = candidate;
        const moved = join(dirname(target), `.${basename(target)}.publishing-recovery.${snapshot.pid}.${randomUUID()}`);
        try {
            await rename(candidate, moved);
        }
        catch (error) {
            if (isMissing(error))
                return false;
            throw error;
        }
        let restored;
        return withAuditCleanup(async () => true, auditCleanupSequence([{ run: async () => {
                    const captured = await statIfPresent(moved);
                    if (!captured)
                        return;
                    if (restored) {
                        const named = await statIfPresent(original);
                        if (!named || captured.isSymbolicLink() || named.isSymbolicLink()
                            || !sameInode(captured, restored) || !sameInode(named, restored)
                            || !captured.isFile() || !named.isFile() || captured.nlink !== restored.nlink + 1
                            || named.nlink !== restored.nlink + 1 || captured.size !== restored.size || captured.mtimeMs !== restored.mtimeMs) {
                            throw new AuditWriteSkipped('publication_changed');
                        }
                        // Restoration already succeeded. Retry only removal of the same owned
                        // tombstone, never the link or a replacement at either pathname.
                        await unlink(moved);
                        throw new AuditWriteSkipped('publication_changed');
                    }
                    if (captured.isSymbolicLink() || !sameInode(captured, snapshot.stat) || !captured.isFile()
                        || captured.nlink !== 2 || captured.size !== snapshot.stat.size || captured.mtimeMs !== snapshot.stat.mtimeMs) {
                        // Preserve an exchanged name; link never overwrites a successor. Keep the
                        // exact tombstone/continuation reachable if restoration itself cannot finish.
                        await link(moved, original);
                        restored = captured;
                        await unlink(moved);
                        throw new AuditWriteSkipped('publication_changed');
                    }
                    await unlink(moved);
                }, retryFailedOperation: true }]));
    }
    // Publish after writing and syncing: no other writer can observe an empty lock owned by this process.
    async function publish(target) {
        budget.check();
        const temporary = join(dirname(target), `.${basename(target)}.publishing.${process.pid}.${token}`);
        const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | flags(), 0o600);
        let acquiredStat;
        let closed = false;
        return withAuditCleanup(async () => {
            acquiredStat = await fd.stat();
            const result = await fd.write(owner);
            if (result.bytesWritten !== Buffer.byteLength(owner))
                throw new AuditWriteSkipped('short_lock_write');
            await fd.sync();
            budget.check();
            try {
                await link(temporary, target);
                publishedNames.add(target);
                return true;
            }
            catch (error) {
                if (error.code === 'EEXIST')
                    return false;
                throw error;
            }
        }, auditCleanupSequence([{ run: async () => {
                    // Keep the descriptor if identity could not be read; a later cleanup can retry it.
                    acquiredStat ??= await fd.stat();
                    if (!closed) {
                        await fd.close();
                        closed = true;
                    }
                    const named = await statIfPresent(temporary);
                    if (!named)
                        return;
                    if (named.isSymbolicLink() || !sameInode(acquiredStat, named) || !named.isFile()
                        || named.nlink < 1 || named.nlink > 2)
                        throw new AuditWriteSkipped('lock_changed');
                    await unlink(temporary);
                }, retryFailedOperation: true }]));
    }
    // Mutation guards exclude normal writers' reclamation/release. Verify the moved inode before deleting it.
    async function removeSnapshot(target, snapshot) {
        const moved = `${target}.released.${process.pid}.${randomUUID()}`;
        try {
            await rename(target, moved);
        }
        catch (error) {
            if (isMissing(error))
                return;
            throw error;
        }
        // Ownership transfers with rename, before even the first metadata read can fail.
        releasedNames.set(moved, snapshot);
        const stat = await lstat(moved);
        if (!sameInode(stat, snapshot.stat) || stat.size !== snapshot.stat.size || stat.mtimeMs !== snapshot.stat.mtimeMs) {
            // Never overwrite a replacement owner. Preserve the moved inode if restoration races.
            await link(moved, target);
            await unlink(moved);
            releasedNames.delete(moved);
            throw new AuditWriteSkipped('lock_changed');
        }
        await removeReleased(moved, snapshot);
    }
    async function removeReleased(path, snapshot) {
        const stat = await statIfPresent(path);
        if (!stat) {
            releasedNames.delete(path);
            return;
        }
        if (stat.isSymbolicLink() || !sameInode(stat, snapshot.stat) || stat.size !== snapshot.stat.size
            || stat.mtimeMs !== snapshot.stat.mtimeMs || stat.nlink !== 1)
            throw new AuditWriteSkipped('lock_changed');
        await unlink(path);
        releasedNames.delete(path);
    }
    async function removeOwned(target) {
        if (!publishedNames.has(target))
            return;
        const current = await readLockOwner(target);
        if (current?.token === token && current.pid === process.pid)
            await removeSnapshot(target, current);
        publishedNames.delete(target);
    }
    async function cleanupOwned() {
        // Finish a failed read acquisition before reopening any owner name. Each
        // capability closes only its original descriptor and never repeats the read.
        const reads = await Promise.allSettled([...retainedOwnerReads].map(async (failure) => {
            await failure.retryCleanup();
            retainedOwnerReads.delete(failure);
        }));
        const readFailures = reads.filter((result) => result.status === 'rejected');
        if (readFailures.length)
            throw new AggregateError(readFailures.map(result => result.reason), 'audit owner read cleanup failed');
        // Snapshot existing tombstones first: a newly failed unlink is returned to the caller,
        // not silently retried in the same cleanup attempt. Retain exact inode ownership.
        const released = [...releasedNames];
        const cleanup = await Promise.allSettled([
            ...[...publishedNames].map(removeOwned),
            ...released.map(([path, snapshot]) => removeReleased(path, snapshot)),
        ]);
        const failures = cleanup.filter((result) => result.status === 'rejected');
        if (failures.length)
            throw new AggregateError(failures.map(result => result.reason), 'audit lock cleanup failed');
    }
    return withAuditCleanup(async () => {
        for (;;) {
            budget.check();
            if (await statIfPresent(guardianPath)) {
                await budget.pause();
                continue;
            }
            if (await statIfPresent(guardPath)) {
                const guard = await readLockOwner(guardPath, budget);
                if (guard && dead(guard.pid))
                    await removeSnapshot(guardPath, guard);
                else {
                    await budget.pause();
                    continue;
                }
            }
            if (await publish(path)) {
                // A stale-reclaimer may have acquired the guard between the first check and publication.
                if (await statIfPresent(guardPath) || await statIfPresent(guardianPath)) {
                    // No callback has run. Withdraw only this owner's exact publication,
                    // then retry acquisition within the same monotonic budget.
                    await removeOwned(path);
                    await budget.pause();
                    continue;
                }
                budget.check();
                return await run();
            }
            const current = await readLockOwner(path, budget);
            if (current && dead(current.pid) && await publish(guardPath)) {
                await withAuditCleanup(async () => {
                    const fresh = await readLockOwner(path, budget);
                    if (!(await statIfPresent(guardianPath)) && fresh && dead(fresh.pid))
                        await removeSnapshot(path, fresh);
                }, auditCleanupSequence([{ run: () => removeOwned(guardPath), retryFailedOperation: true }]));
            }
            else
                await budget.pause();
        }
    }, auditCleanupSequence([{ run: async () => {
                // Cleanup is awaited even after cancellation; failures retain explicit cleanup ownership in the registry.
                // A live owner cannot be reclaimed by normal writers, so removing our exact inode needs no new lock wait.
                await cleanupOwned();
            }, retryFailedOperation: true }]));
}