import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync, writeSync, } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireWorkspaceLease } from './workspaceLease.js';
const JOURNAL_PREFIX = '.evolver-llm-recovery-';
const forbidden = (name) => {
    const normalized = name.toLowerCase();
    return normalized === '.git' || normalized === 'node_modules' || normalized.startsWith(JOURNAL_PREFIX);
};
class RecoveryConflict extends Error {
}
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameVersion(a, b) {
    return sameIdentity(a, b) && a.size === b.size && a.mode === b.mode && a.nlink === b.nlink
        && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function code(error) {
    return error instanceof RecoveryConflict ? error.message : 'filesystem_operation_failed';
}
function isMissing(error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
function replaceBytes(fd, bytes, progress) {
    let offset = 0;
    while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0)
            throw new Error('file write made no progress');
        offset += count;
        progress?.(offset, false);
    }
    ftruncateSync(fd, bytes.length);
    progress?.(offset, true);
    fsyncSync(fd);
}
/** Writes are allowed only in an owner-reserved directory; shared paths remain read-only. */
export function workspaceAt(root, maxFileBytes = 64 * 1024, lease) {
    const base = existsSync(root) ? realpathSync(resolve(root)) : resolve(root);
    const entries = new Map();
    const directories = new Map();
    let owner = lease ? acquireWorkspaceLease(base, lease) : undefined;
    let journal;
    let journalIdentity;
    let sequence = 0;
    let terminal;
    let completed = false;
    const contains = (target) => {
        const rel = relative(base, target);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`))
            throw new Error('path escapes the workspace');
        if (rel.split(sep).some(forbidden))
            throw new Error('path is off limits');
    };
    const inside = (raw) => {
        const target = resolve(base, raw || '.');
        contains(target);
        // Use one portable filename contract. Windows aliases can otherwise bypass .git/node_modules
        // checks through ADS, device names or Win32 trailing-dot/space normalization.
        if (/\p{Cc}|:/u.test(raw) || raw.split(/[\\/]/u).some((part) => part !== '.' && part !== '..'
            && (/[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)))) {
            throw new Error('path is off limits');
        }
        let ancestor = target;
        while (!existsSync(ancestor)) {
            const parent = dirname(ancestor);
            if (parent === ancestor)
                break;
            ancestor = parent;
        }
        contains(realpathSync(ancestor));
        return target;
    };
    const assertOwner = () => {
        if (terminal || completed)
            throw new Error('workspace transaction has finished');
        owner ??= acquireWorkspaceLease(base, lease);
        owner.assert();
    };
    const parentsOf = (path) => {
        const result = [];
        for (let cursor = dirname(path);; cursor = dirname(cursor)) {
            const stat = lstatSync(cursor, { bigint: true });
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new RecoveryConflict('parent_changed');
            result.push({ path: cursor, stat });
            if (cursor === base)
                return result;
            contains(cursor);
        }
    };
    const assertParents = (entry) => {
        for (const parent of entry.parents) {
            let stat;
            try {
                stat = lstatSync(parent.path, { bigint: true });
            }
            catch {
                throw new RecoveryConflict('parent_changed');
            }
            if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, parent.stat))
                throw new RecoveryConflict('parent_changed');
        }
    };
    const openFile = (path) => {
        let stat;
        try {
            stat = lstatSync(path, { bigint: true });
        }
        catch (error) {
            if (isMissing(error))
                throw new RecoveryConflict('file_missing');
            throw error;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
            throw new RecoveryConflict('file_identity_changed');
        if (stat.size > BigInt(maxFileBytes))
            throw new RecoveryConflict('file_size_changed');
        const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        try {
            const current = fstatSync(fd, { bigint: true });
            if (!sameVersion(stat, current))
                throw new RecoveryConflict('file_identity_changed');
            return fd;
        }
        catch (error) {
            closeSync(fd);
            throw error;
        }
    };
    const version = (fd) => {
        const stat = fstatSync(fd, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(maxFileBytes))
            throw new RecoveryConflict('file_identity_changed');
        // Positional reads do not depend on a previous write/read advancing the descriptor offset.
        const bytes = Buffer.alloc(Number(stat.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (count === 0)
                throw new RecoveryConflict('file_changed');
            offset += count;
        }
        if (!sameVersion(stat, fstatSync(fd, { bigint: true })))
            throw new RecoveryConflict('file_changed');
        return { stat, bytes };
    };
    const assertLast = (path, fd, entry) => {
        if (!entry.last)
            throw new RecoveryConflict('write_not_confirmed');
        assertParents(entry);
        const actual = version(fd);
        if (!sameVersion(entry.last.stat, actual.stat) || !entry.last.bytes.equals(actual.bytes)
            || !sameVersion(actual.stat, lstatSync(path, { bigint: true })))
            throw new RecoveryConflict('file_changed');
    };
    const record = (path, entry, phase) => {
        owner.assert();
        if (!journal) {
            journal = mkdtempSync(join(owner.container, JOURNAL_PREFIX));
            journalIdentity = lstatSync(journal, { bigint: true });
        }
        const stat = lstatSync(journal, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, journalIdentity))
            throw new RecoveryConflict('journal_changed');
        const fd = openSync(join(journal, `${sequence++}.json`), 'wx', 0o600);
        try {
            writeFileSync(fd, JSON.stringify({ path: relative(base, path), phase,
                before: entry.before?.toString('base64') ?? null,
                last: entry.last ? { bytes: entry.last.bytes.toString('base64'), dev: String(entry.last.stat.dev), ino: String(entry.last.stat.ino), mtimeNs: String(entry.last.stat.mtimeNs), ctimeNs: String(entry.last.stat.ctimeNs) } : null }));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    };
    const clearJournal = () => {
        if (!journal)
            return;
        owner.assert();
        const stat = lstatSync(journal, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, journalIdentity))
            throw new RecoveryConflict('journal_changed');
        rmSync(journal, { recursive: true });
        journal = undefined;
    };
    const ensureParents = (target) => {
        const missing = [];
        for (let path = dirname(target); !existsSync(path); path = dirname(path))
            missing.push(path);
        for (const path of missing.reverse()) {
            assertOwner();
            const entry = { before: null, parents: parentsOf(path) };
            assertParents(entry);
            record(path, entry, 'mkdir_intent');
            mkdirSync(path);
            directories.set(path, { stat: lstatSync(path, { bigint: true }), parents: entry.parents });
            record(path, entry, 'mkdir_complete');
        }
    };
    return {
        list(dir) {
            const target = inside(dir);
            const targetStat = lstatSync(target, { bigint: true });
            if (!targetStat.isDirectory() || targetStat.isSymbolicLink())
                throw new Error('linked directory is off limits');
            if (target !== base)
                assertParents({ before: null, parents: parentsOf(target) });
            const result = readdirSync(target, { withFileTypes: true }).filter((entry) => !forbidden(entry.name)).slice(0, 200)
                .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name);
            if (!sameIdentity(targetStat, lstatSync(target, { bigint: true })))
                throw new Error('directory changed');
            return result.join('\n') || '(empty)';
        },
        read(path) {
            const target = inside(path);
            const initial = lstatSync(target, { bigint: true });
            if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n)
                throw new Error('linked or non-regular file is off limits');
            if (initial.size > BigInt(maxFileBytes))
                throw new Error(`file is larger than ${maxFileBytes} bytes`);
            const parents = parentsOf(target);
            const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try {
                if (!sameVersion(initial, fstatSync(fd, { bigint: true })))
                    throw new Error('file changed');
                assertParents({ before: null, parents });
                const result = version(fd);
                if (!sameVersion(result.stat, lstatSync(target, { bigint: true })))
                    throw new Error('file changed');
                assertParents({ before: null, parents });
                return result.bytes.toString('utf8');
            }
            finally {
                closeSync(fd);
            }
        },
        write(path, content) {
            const target = inside(path);
            const body = Buffer.from(String(content ?? ''), 'utf8');
            if (body.length > maxFileBytes)
                throw new Error(`refusing to write more than ${maxFileBytes} bytes`);
            assertOwner();
            ensureParents(target);
            const existing = entries.get(target);
            // Reject linked parents even when a link happens to stay inside this workspace.
            const parents = existing?.parents ?? parentsOf(target);
            assertParents({ before: null, parents });
            let entry = existing;
            let fd;
            try {
                fd = openFile(target);
            }
            catch (error) {
                if (!(error instanceof RecoveryConflict && error.message === 'file_missing') || existing)
                    throw error;
                entry = { before: null, parents };
                record(target, entry, 'create_intent');
                fd = openSync(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
                entries.set(target, entry);
            }
            try {
                if (existing)
                    assertLast(target, fd, existing);
                const initial = version(fd);
                if (!entry)
                    entry = { before: initial.bytes, parents };
                entry.last = initial;
                entries.set(target, entry);
                entry.pending = true;
                record(target, entry, 'write_intent');
                let writtenCount = 0;
                let truncated = false;
                try {
                    replaceBytes(fd, body, (count, didTruncate) => { writtenCount = count; truncated = didTruncate; });
                    const written = version(fd);
                    if (!written.bytes.equals(body))
                        throw new RecoveryConflict('write_not_confirmed');
                    entry.last = written;
                    record(target, entry, 'write_complete');
                    entry.pending = false;
                }
                catch (error) {
                    delete entry.last;
                    // Confirm only bytes explained by completed syscalls on this descriptor. An
                    // unobserved mutation or external edit remains a conflict, never rollback permission.
                    try {
                        owner.assert();
                        assertParents(entry);
                        const expected = truncated ? body : Buffer.alloc(Math.max(initial.bytes.length, writtenCount));
                        if (!truncated) {
                            initial.bytes.copy(expected);
                            body.copy(expected, 0, 0, writtenCount);
                        }
                        const partial = version(fd);
                        if (!sameIdentity(initial.stat, partial.stat) || initial.stat.mode !== partial.stat.mode || initial.stat.uid !== partial.stat.uid
                            || !partial.bytes.equals(expected)
                            || !sameVersion(partial.stat, lstatSync(target, { bigint: true })))
                            throw new RecoveryConflict('write_not_confirmed');
                        entry.last = partial;
                        record(target, entry, 'write_interrupted');
                    }
                    catch { /* Keep an unconfirmed partial write and the pre-write journal for recovery. */ }
                    throw error;
                }
            }
            finally {
                closeSync(fd);
            }
            return `wrote ${body.length} bytes`;
        },
        touched: () => [...entries.keys()].map((path) => relative(base, path)),
        undo() {
            if (terminal)
                return structuredClone(terminal);
            if (completed)
                return { status: 'restored', restored: [], conflicts: [], failed: [] };
            const result = { status: 'restored', restored: [], conflicts: [], failed: [] };
            for (const [path, entry] of entries) {
                const name = relative(base, path);
                let fd;
                try {
                    try {
                        owner.assert();
                    }
                    catch {
                        throw new RecoveryConflict('workspace_ownership_lost');
                    }
                    assertParents(entry);
                    fd = openFile(path);
                    assertLast(path, fd, entry);
                    record(path, entry, 'restore_intent');
                    // The descriptor binds the existing inode. Exclusive workspace ownership is required:
                    // this check is NOT an atomic compare-and-swap against non-cooperating writers.
                    assertLast(path, fd, entry);
                    if (entry.before === null)
                        unlinkSync(path);
                    else {
                        replaceBytes(fd, entry.before);
                        if (!version(fd).bytes.equals(entry.before))
                            throw new Error('restore readback failed');
                    }
                    record(path, entry, 'restored');
                    result.restored.push(name);
                }
                catch (error) {
                    if (error instanceof RecoveryConflict)
                        result.conflicts.push({ path: name, reason: code(error) });
                    else
                        result.failed.push({ path: name, reason: code(error) });
                }
                finally {
                    if (fd !== undefined)
                        closeSync(fd);
                }
            }
            for (const [path, directory] of [...directories].reverse()) {
                try {
                    owner.assert();
                    assertParents({ before: null, parents: directory.parents });
                    const actual = lstatSync(path, { bigint: true });
                    if (!actual.isDirectory() || actual.isSymbolicLink() || !sameIdentity(actual, directory.stat))
                        throw new RecoveryConflict('directory_changed');
                    if (readdirSync(path).length)
                        throw new RecoveryConflict('directory_not_empty');
                    // Never recursively remove a directory that an external writer could populate.
                    rmdirSync(path);
                    result.restored.push(relative(base, path));
                }
                catch (error) {
                    const item = { path: relative(base, path), reason: code(error) };
                    if (error instanceof RecoveryConflict)
                        result.conflicts.push(item);
                    else
                        result.failed.push(item);
                }
            }
            if (!result.conflicts.length && !result.failed.length) {
                try {
                    clearJournal();
                }
                catch {
                    result.failed.push({ path: '.', reason: 'journal_cleanup_failed' });
                }
            }
            result.status = result.failed.length ? 'failed' : result.conflicts.length ? 'conflict' : 'restored';
            if (result.status !== 'restored')
                result.workspace = base;
            if (journal)
                result.journal = journal;
            terminal = result;
            owner?.release();
            return structuredClone(result);
        },
        complete() {
            if (completed) {
                if (terminal)
                    throw new Error('workspace commit cleanup failed');
                return;
            }
            assertOwner();
            for (const [path, entry] of entries) {
                if (entry.pending)
                    throw new RecoveryConflict('write_not_confirmed');
                assertParents(entry);
                const fd = openFile(path);
                try {
                    assertLast(path, fd, entry);
                }
                finally {
                    closeSync(fd);
                }
            }
            if (journal)
                record(base, { before: null, parents: [] }, 'transaction_committed');
            completed = true;
            try {
                clearJournal();
            }
            catch {
                terminal = { status: 'failed', restored: [], committed: [...entries.keys()].map((path) => relative(base, path)), conflicts: [],
                    failed: [{ path: '.', reason: 'journal_cleanup_failed' }], workspace: base, ...(journal ? { journal } : {}) };
                throw new Error('workspace commit cleanup failed');
            }
            finally {
                owner?.release();
            }
        },
        close() { owner?.release(); },
    };
}