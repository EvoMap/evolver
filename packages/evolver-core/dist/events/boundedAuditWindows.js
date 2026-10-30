import { win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileLockProcessLiveness, readFileLockProcessStartIdentity, parseFileLockProcessStartIdentity, sameFileLockProcessStartIdentity } from '../util/fileLock.js';
import { loadReferenceFfi, loadReferenceSystemLibrary } from '../benchmark/referenceNativeRuntime.js';
import { createWindowsReferenceApi } from '../benchmark/referenceNativeWindows.js';
import { referenceFilePath } from '../benchmark/referenceAccess.js';
import { AuditWriteSkipped, WindowsAuditNameBusyError } from './boundedAudit.js';
export { WindowsAuditNameBusyError } from './boundedAudit.js';
import { AuditCleanupError, auditCleanupSequence, withAuditCleanup } from './auditCleanup.js';
const validHandle = (value) => typeof value === 'bigint' && value > 0n
    && value !== 0xffffffffn && value !== 0xffffffffffffffffn;
const codeIs = (error, code) => error?.code === code;
const sameIdentity = (a, b) => a.volume === b.volume && a.index === b.index && a.creation === b.creation;
const sameSnapshot = (a, b) => sameIdentity(a, b) && a.size === b.size && a.write === b.write;
function pathKey(path) {
    try {
        return referenceFilePath(path.startsWith('\\\\?\\') ? path.slice(4) : path);
    }
    catch {
        throw new AuditWriteSkipped('windows_path_blocked');
    }
}
function component(name) {
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || Buffer.byteLength(name, 'utf16le') > 510) {
        throw new AuditWriteSkipped('windows_path_blocked');
    }
    pathKey(`C:\\${name}`);
}
function safeInfo(info, directory, maxBytes) {
    if (!Number.isInteger(info.attributes) || !Number.isInteger(info.volume) || !Number.isInteger(info.links)
        || typeof info.index !== 'bigint' || info.index < 0n || typeof info.size !== 'bigint' || info.size < 0n
        || typeof info.creation !== 'bigint' || typeof info.write !== 'bigint'
        || (info.attributes & 0x400) !== 0 || Boolean(info.attributes & 0x10) !== directory || (!directory && info.links !== 1)) {
        throw new AuditWriteSkipped('not_private_regular_file');
    }
    if (!directory && info.size > BigInt(maxBytes))
        throw new AuditWriteSkipped('file_too_large');
}
function unlinkedRead(info, maxBytes) {
    if (info.links !== 0)
        return false;
    // A release can unlink an opened read-share HANDLE. Validate every other
    // field, then discard it: zero links never certify ownership of a name.
    safeInfo({ ...info, links: 1 }, false, maxBytes);
    return true;
}
function ntError(status) {
    const value = status >>> 0;
    if (value === 0xc0000043 || value === 0xc0000056)
        return new WindowsAuditNameBusyError(value);
    const code = { [0xc0000034]: 'ENOENT', [0xc000003a]: 'ENOENT', [0xc0000035]: 'EEXIST',
        [0xc0000043]: 'EBUSY', [0xc0000056]: 'EBUSY', [0xc0000022]: 'EACCES' }[status >>> 0] ?? 'EIO';
    return Object.assign(new AuditWriteSkipped('windows_io_failed'), { code });
}
let cachedApi;
/** Uses the already packaged Koffi 3.2.1. Read-only reference capabilities stay read-only. */
export function createWindowsAuditApi() {
    if (cachedApi)
        return cachedApi;
    if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch))
        throw new AuditWriteSkipped('safe_open_unavailable');
    const ffi = loadReferenceFfi();
    const reference = createWindowsReferenceApi(); // reuse its fixed handle metadata implementation, not its synchronous reads
    const kernel = loadReferenceSystemLibrary('kernel32.dll'); // fixed Windows KnownDLLs, no caller-selected library or symbols
    const nt = loadReferenceSystemLibrary('ntdll.dll');
    const create = kernel.func('void * __stdcall CreateFileW(str16 path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)');
    const close = kernel.func('int __stdcall CloseHandle(void *handle)');
    const flush = kernel.func('int __stdcall FlushFileBuffers(void *handle)');
    const unicode = ffi.struct({ Length: 'uint16_t', MaximumLength: 'uint16_t', Buffer: 'str16' });
    const attributes = ffi.struct({ Length: 'uint32_t', RootDirectory: 'void *', ObjectName: ffi.pointer(unicode),
        Attributes: 'uint32_t', SecurityDescriptor: 'void *', SecurityQualityOfService: 'void *' });
    if (ffi.sizeof(unicode) !== 16 || ffi.sizeof(attributes) !== 48)
        throw new AuditWriteSkipped('safe_open_unavailable');
    const openChild = nt.func('__stdcall', 'NtCreateFile', 'int32_t', [ffi.out(ffi.pointer('void *')), 'uint32_t',
        ffi.pointer(attributes), ffi.out('void *'), 'void *', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', 'void *', 'uint32_t']);
    const read = nt.func('int32_t __stdcall NtReadFile(void *handle, void *event, void *apc, void *context, _Out_ void *status, _Out_ void *buffer, uint32_t length, void *offset, void *key)');
    const write = nt.func('int32_t __stdcall NtWriteFile(void *handle, void *event, void *apc, void *context, _Out_ void *status, void *buffer, uint32_t length, void *offset, void *key)');
    const setInfo = nt.func('int32_t __stdcall NtSetInformationFile(void *handle, _Out_ void *status, void *info, uint32_t length, uint32_t infoClass)');
    // Koffi runs these on its worker pool. No detached operation, Promise.race, synchronous bulk I/O,
    // or process.exit in the library. The caller awaits completion even when its preparation budget expires.
    const invoke = (fn, ...args) => new Promise((resolve, reject) => {
        fn.async(...args, (error, result) => error ? reject(error) : resolve(result));
    });
    function status(result, io) {
        if (typeof result !== 'number' || result === 0x103)
            throw new AuditWriteSkipped('windows_io_incomplete');
        if (result < 0)
            throw ntError(result);
        if (io.readInt32LE(0) < 0)
            throw ntError(io.readInt32LE(0));
    }
    async function set(handle, kind, data) {
        const io = Buffer.alloc(16);
        status(await invoke(setInfo, handle, io, data, data.length, kind), io);
    }
    async function io(handle, output, position, reading) {
        const result = Buffer.alloc(16);
        const offset = Buffer.alloc(8);
        offset.writeBigInt64LE(position);
        const value = await invoke(reading ? read : write, handle, null, null, null, result, output, output.length, offset, null);
        if (reading && typeof value === 'number' && (value >>> 0) === 0xc0000011)
            return 0; // STATUS_END_OF_FILE
        status(value, result);
        const count = result.readBigUInt64LE(8);
        if (count > BigInt(output.length))
            throw new AuditWriteSkipped('windows_io_invalid_count');
        return Number(count);
    }
    const api = {
        async root(drive) {
            if (!/^[A-Za-z]:\\$/.test(drive))
                throw new AuditWriteSkipped('windows_path_blocked');
            // Only the drive root is opened by absolute name. Every subsequent component is relative to
            // a retained directory handle with no FILE_SHARE_DELETE, including all ancestors of the audit dir.
            const handle = await invoke(create, `\\\\?\\${drive}`, 0x81, 3, null, 3, 0x02200000, null);
            if (!validHandle(handle))
                throw new AuditWriteSkipped('windows_open_failed');
            return handle;
        },
        async child(parent, name, mode) {
            component(name);
            if (!validHandle(parent))
                throw new AuditWriteSkipped('windows_path_blocked');
            const out = Buffer.alloc(8);
            const result = Buffer.alloc(16);
            const length = Buffer.byteLength(name, 'utf16le');
            const directory = mode === 'directory' || mode === 'directory-read';
            const access = directory ? 0x81 : mode === 'read' ? 0x80000000 : mode === 'delete' ? 0x80010000
                : mode === 'create' ? 0xc0010000 : 0xc0000000;
            const value = await invoke(openChild, out, access + 0x100000, { Length: 48, RootDirectory: parent,
                ObjectName: { Length: length, MaximumLength: length + 2, Buffer: name }, Attributes: 0x1040,
                SecurityDescriptor: null, SecurityQualityOfService: null }, result, null, 0, mode === 'read' ? 7 : directory ? 3 : 1, // readers may observe a release; writers pin their exact file, exclude other writers/deleters
            mode === 'create' ? 2 : mode === 'directory' || mode === 'append' ? 3 : 1, // FILE_OPEN for reads/existing recovery; only append/directory may create.
            0x00200000 | 0x20 | (directory ? 1 : 0x40), null, 0);
            const handle = out.readBigUInt64LE(0);
            try {
                status(value, result);
                if (!validHandle(handle))
                    throw new AuditWriteSkipped('windows_open_failed');
            }
            catch (error) {
                if (validHandle(handle)) {
                    let pending = true;
                    const retryCleanup = async () => { if (pending) {
                        await api.close(handle);
                        pending = false;
                    } };
                    try {
                        await retryCleanup();
                    }
                    catch (cleanup) {
                        throw new AuditCleanupError({ status: 'failed', error }, cleanup, auditCleanupSequence([{ run: retryCleanup, retryFailedOperation: true }]), () => !pending);
                    }
                }
                throw error;
            }
            return handle;
        },
        info: handle => reference.info(handle),
        finalPath: handle => reference.finalPath(handle),
        fileType: handle => reference.fileType(handle),
        read: (handle, buffer, position) => io(handle, buffer, BigInt(position), true),
        // FILE_WRITE_TO_END_OF_FILE is interpreted by the kernel in the same write operation. Never
        // emulate O_APPEND with a seek followed by write, and never retry a submitted partial append.
        append: (handle, buffer) => io(handle, buffer, -1n, false),
        async truncate(handle, size) { const data = Buffer.alloc(8); data.writeBigInt64LE(BigInt(size)); await set(handle, 20, data); },
        async sync(handle) { if (!await invoke(flush, handle))
            throw new AuditWriteSkipped('windows_fsync_failed'); },
        async publish(handle, parent, name) {
            component(name);
            const encoded = Buffer.from(name, 'utf16le');
            const data = Buffer.alloc(20 + encoded.length);
            // FILE_RENAME_INFORMATION, ReplaceIfExists=FALSE, RootDirectory retained. Atomic complete owner
            // publication without a transient two-link file and without reopening the temporary by pathname.
            data.writeBigUInt64LE(parent, 8);
            data.writeUInt32LE(encoded.length, 16);
            encoded.copy(data, 20);
            await set(handle, 10, data);
        },
        async remove(handle) { await set(handle, 13, Buffer.from([1])); }, // FILE_DISPOSITION_INFORMATION, exact opened file
        async close(handle) { if (!await invoke(close, handle))
            throw new AuditWriteSkipped('windows_close_failed'); },
    };
    cachedApi = api;
    return api;
}
export function createWindowsSnapshotApi() {
    const api = createWindowsAuditApi();
    return {
        root: drive => api.root(drive),
        child: (parent, name, directory) => api.child(parent, name, directory ? 'directory-read' : 'read'),
        info: handle => api.info(handle), finalPath: handle => api.finalPath(handle), fileType: handle => api.fileType(handle),
        read: (handle, buffer, position) => api.read(handle, buffer, position), close: handle => api.close(handle),
    };
}
export async function openWindowsAuditDirectory(path, budget, injected, existingOnly = false) {
    budget.check();
    // Reject devices/UNC before resolve; relative ordinary local paths keep the existing API contract.
    if (/^(?:\\\\|\/\/)/.test(path))
        throw new AuditWriteSkipped('windows_path_blocked');
    const normalized = win32.resolve(path);
    pathKey(normalized);
    const drive = win32.parse(normalized).root;
    const segments = normalized.slice(drive.length).split('\\').filter(Boolean);
    if (segments.length > 128)
        throw new AuditWriteSkipped('windows_path_blocked');
    segments.forEach(component);
    const api = injected ?? createWindowsAuditApi();
    // Own each acquisition, not the numeric HANDLE: Windows may reuse that number after close.
    const retained = new Set();
    const operations = new Set();
    const nativeCleanups = new Set();
    const publications = new Map();
    let closed = false;
    let closing;
    function own(handle) {
        if (!validHandle(handle))
            throw new AuditWriteSkipped('windows_open_failed');
        const owner = { handle, closing: false, released: false, operations: new Set() };
        retained.add(owner);
        return owner;
    }
    function operation(run, owner) {
        if (closed || owner?.closing || owner?.released)
            return Promise.reject(new AuditWriteSkipped('windows_handle_closed'));
        const task = run();
        operations.add(task);
        owner?.operations.add(task);
        return task.finally(() => { operations.delete(task); owner?.operations.delete(task); });
    }
    function release(owner) {
        if (owner.released)
            return Promise.resolve();
        if (owner.releasePending)
            return owner.releasePending;
        owner.closing = true;
        owner.releasePending = (async () => {
            await Promise.allSettled([...owner.operations]);
            await api.close(owner.handle);
            owner.released = true;
            retained.delete(owner);
        })().finally(() => { delete owner.releasePending; });
        return owner.releasePending;
    }
    function releaseNativeCleanup(owner) {
        if (owner.released)
            return Promise.resolve();
        return owner.pending ??= Promise.resolve().then(async () => {
            await owner.run();
            owner.released = true;
            nativeCleanups.delete(owner);
        }).finally(() => { delete owner.pending; });
    }
    function cleanupPublication(publication) {
        if (publication.complete)
            return Promise.resolve();
        return publication.pending ??= Promise.resolve().then(async () => {
            // Retain the DELETE-capable acquisition until removal succeeds. Closing it
            // first would leave a temporary pathname with no safe deletion capability.
            if (publication.removePending) {
                await api.remove(publication.owner.handle);
                publication.removePending = false;
            }
            await release(publication.owner);
            publication.complete = true;
            publications.delete(publication.owner);
        }).finally(() => { delete publication.pending; });
    }
    async function child(parent, name, mode) {
        try {
            return await api.child(parent, name, mode);
        }
        catch (error) {
            // NtCreateFile can fail after returning a HANDLE whose first CloseHandle also
            // failed. That acquisition is owned even though no successful open returned it.
            if (!(error instanceof AuditCleanupError))
                throw error;
            const owner = { run: () => error.retryCleanup(), released: false };
            nativeCleanups.add(owner);
            throw new AuditCleanupError({ status: 'failed', error }, error, auditCleanupSequence([{ run: () => releaseNativeCleanup(owner), retryFailedOperation: true }]), () => owner.released);
        }
    }
    function closeAll() {
        closed = true;
        if (closing)
            return closing;
        closing = (async () => {
            // Do not close a parent/file while a submitted native call can still use it or return a child.
            await Promise.allSettled([...operations]);
            const errors = [];
            for (const publication of [...publications.values()]) {
                try {
                    await cleanupPublication(publication);
                }
                catch (error) {
                    errors.push(error);
                }
            }
            for (const owner of [...nativeCleanups].reverse()) {
                try {
                    await releaseNativeCleanup(owner);
                }
                catch (error) {
                    errors.push(error);
                }
            }
            for (const owner of [...retained].reverse()) {
                if (publications.has(owner))
                    continue;
                try {
                    await release(owner);
                }
                catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length)
                throw new AggregateError(errors, 'windows audit cleanup failed');
        })().finally(() => { closing = undefined; });
        return closing;
    }
    const directoryCleanupComplete = () => closed && operations.size === 0
        && publications.size === 0 && nativeCleanups.size === 0 && retained.size === 0;
    async function closeOwnedDirectory() {
        try {
            await closeAll();
        }
        catch (error) {
            throw new AuditCleanupError({ status: 'completed', value: undefined }, error, auditCleanupSequence([{ run: closeAll, retryFailedOperation: true }]), directoryCleanupComplete);
        }
    }
    async function retryReleasedHandles() {
        const errors = [];
        for (const publication of [...publications.values()]) {
            try {
                await cleanupPublication(publication);
            }
            catch (error) {
                errors.push(error);
            }
        }
        for (const owner of [...nativeCleanups].reverse()) {
            try {
                await releaseNativeCleanup(owner);
            }
            catch (error) {
                errors.push(error);
            }
        }
        for (const owner of [...retained].reverse()) {
            if (!owner.closing || publications.has(owner))
                continue;
            try {
                await release(owner);
            }
            catch (error) {
                errors.push(error);
            }
        }
        if (errors.length)
            throw new AggregateError(errors, 'windows released handle cleanup failed');
    }
    function checked(owner, expectedPath, directory, maxBytes, reading = false) {
        const { handle } = owner;
        const info = api.info(handle);
        const unlinked = reading && unlinkedRead(info, maxBytes);
        if (!unlinked)
            safeInfo(info, directory, maxBytes);
        const final = api.finalPath(handle);
        const actual = final.startsWith('\\\\?\\') ? final.slice(4) : final;
        // NtCreateFile has already resolved exactly one no-reparse component under our pinned parent.
        // Accept the OS's long-name spelling for 8.3 aliases (notably Windows runner TEMP), but require
        // that the returned handle is still in that parent. Subsequent checks bind this exact path + ID.
        if (api.fileType(handle) !== 1 || (expectedPath === drive ? pathKey(actual) !== pathKey(drive)
            : pathKey(win32.dirname(actual)) !== pathKey(win32.dirname(expectedPath))))
            throw new AuditWriteSkipped('path_changed');
        if (unlinked)
            throw Object.assign(new AuditWriteSkipped('lock_unlinked'), { code: 'ENOENT' });
        return { handle, info, path: actual, owner };
    }
    let parent;
    let boundPath = drive;
    try {
        parent = checked(own(await api.root(drive)), drive, true, 0).handle;
        for (const name of segments) {
            budget.check();
            const next = checked(own(await child(parent, name, existingOnly ? 'directory-read' : 'directory')), win32.join(boundPath, name), true, 0);
            parent = next.handle;
            boundPath = next.path;
        }
        budget.check();
    }
    catch (error) {
        try {
            await closeAll();
        }
        catch (cleanup) {
            throw new AuditCleanupError({ status: 'failed', error }, cleanup, auditCleanupSequence([{ run: closeAll, retryFailedOperation: true }]), directoryCleanupComplete);
        }
        throw error;
    }
    async function opened(name, mode, maxBytes) {
        if (closed)
            throw new AuditWriteSkipped('windows_handle_closed');
        component(name);
        const owner = own(await child(parent, name, mode));
        // FILE_CREATE is exclusive, so this new temporary inode belongs to this
        // acquisition even if its first validation fails before opened() returns.
        const publication = mode === 'create'
            ? { owner, removePending: true, complete: false } : undefined;
        if (publication)
            publications.set(owner, publication);
        try {
            if (closed)
                throw new AuditWriteSkipped('windows_handle_closed');
            return checked(owner, win32.join(boundPath, name), false, maxBytes, mode === 'read');
        }
        catch (error) {
            return withAuditCleanup(async () => { throw error; }, auditCleanupSequence([{ run: () => publication ? cleanupPublication(publication) : release(owner), retryFailedOperation: true }]));
        }
    }
    const directory = {
        async open(name, maxBytes, innerBudget, existingOnly = false) {
            innerBudget.check();
            if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
                throw new AuditWriteSkipped('file_too_large');
            // Recovery needs GENERIC_WRITE for FlushFileBuffers, but FILE_OPEN must
            // never recreate missing evidence. Retain the same pinned HANDLE owner.
            const file = await opened(name, existingOnly ? 'existing' : 'append', maxBytes);
            try {
                innerBudget.check();
            }
            catch (error) {
                return withAuditCleanup(async () => { throw error; }, auditCleanupSequence([{ run: () => release(file.owner), retryFailedOperation: true }]));
            }
            const live = () => { if (closed || file.owner.closing || file.owner.released)
                throw new AuditWriteSkipped('windows_handle_closed'); };
            const stat = () => {
                live();
                const current = api.info(file.handle);
                safeInfo(current, false, maxBytes);
                if (!sameIdentity(file.info, current) || pathKey(api.finalPath(file.handle)) !== pathKey(file.path)) {
                    throw new AuditWriteSkipped('path_changed');
                }
                return { dev: BigInt(current.volume), ino: current.index, nlink: current.links, size: Number(current.size),
                    mtimeMs: Number(current.write - 116444736000000000n) / 10000, isFile: () => true };
            };
            // Two writes on the same retained HANDLE must not both spend the same
            // remaining bytes. Include queued mutations in operation ownership so
            // close waits for submitted I/O and rejects work not yet dispatched.
            let mutationTail = Promise.resolve();
            const mutate = (run) => {
                const previous = mutationTail;
                const task = operation(async () => { await previous; live(); return run(); }, file.owner);
                mutationTail = task.then(() => { }, () => { });
                return task;
            };
            return {
                async stat() { return stat(); },
                read(buffer, offset, length, position) { return operation(async () => ({ bytesRead: await api.read(file.handle, buffer.subarray(offset, offset + length), position) }), file.owner); },
                write(buffer, offset, length) {
                    return mutate(async () => {
                        const bytes = buffer.subarray(offset, offset + length);
                        if (bytes.length > maxBytes - stat().size)
                            throw new AuditWriteSkipped('file_too_large');
                        return { bytesWritten: await api.append(file.handle, bytes) };
                    });
                },
                truncate(size) {
                    return mutate(async () => {
                        stat();
                        if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes)
                            throw new AuditWriteSkipped('file_too_large');
                        await api.truncate(file.handle, size);
                    });
                },
                sync() { return operation(() => api.sync(file.handle), file.owner); },
                close() { return release(file.owner); },
            };
        },
        async snapshot(name, innerBudget) {
            innerBudget?.check();
            let file;
            try {
                file = await opened(name, 'read', 4096);
            }
            catch (error) {
                if (codeIs(error, 'ENOENT') || error instanceof WindowsAuditNameBusyError)
                    return undefined;
                throw error;
            }
            return withAuditCleanup(async () => {
                const buffer = Buffer.alloc(4097);
                const count = await api.read(file.handle, buffer, 0);
                const after = api.info(file.handle);
                if (unlinkedRead(after, 4096))
                    return undefined;
                safeInfo(after, false, 4096);
                if (count > 4096 || BigInt(count) !== after.size || !sameSnapshot(file.info, after))
                    throw new AuditWriteSkipped('lock_changed');
                // Both identities come from real native handles. Never compare libuv lstat.dev with fstat.dev,
                // and never round a 64-bit file index through Number (legitimate reopens have a new HANDLE).
                let named;
                try {
                    named = await opened(name, 'read', 4096);
                }
                catch (error) {
                    if (codeIs(error, 'ENOENT') || error instanceof WindowsAuditNameBusyError)
                        return undefined;
                    throw error;
                }
                await withAuditCleanup(async () => {
                    if (!sameSnapshot(after, named.info))
                        throw new AuditWriteSkipped('lock_changed');
                }, auditCleanupSequence([{ run: () => release(named.owner), retryFailedOperation: true }]));
                innerBudget?.check();
                return { info: after, text: buffer.subarray(0, count).toString('utf8') };
            }, auditCleanupSequence([{ run: () => release(file.owner), retryFailedOperation: true }]));
        },
        async exists(name) {
            let file;
            try {
                file = await opened(name, 'read', 4096);
            }
            catch (error) {
                if (codeIs(error, 'ENOENT'))
                    return false;
                if (error instanceof WindowsAuditNameBusyError)
                    return true; // Delete-pending/sharing contention is busy, never absent authority.
                throw error;
            }
            return withAuditCleanup(async () => true, auditCleanupSequence([{ run: () => release(file.owner), retryFailedOperation: true }]));
        },
        async publish(name, owner, innerBudget, published) {
            innerBudget.check();
            const temporary = `.${name}.publishing.${process.pid}.${randomUUID()}`;
            const file = await opened(temporary, 'create', 4096);
            const publication = publications.get(file.owner);
            return withAuditCleanup(async () => {
                innerBudget.check();
                const bytes = Buffer.from(owner);
                if (bytes.length > 4096)
                    throw new AuditWriteSkipped('lock_too_large');
                if (await api.append(file.handle, bytes) !== bytes.length)
                    throw new AuditWriteSkipped('short_lock_write');
                await api.sync(file.handle);
                innerBudget.check();
                try {
                    await api.publish(file.handle, parent, name);
                    publication.removePending = false;
                    published();
                    return true;
                }
                catch (error) {
                    if (codeIs(error, 'EEXIST') || error instanceof WindowsAuditNameBusyError)
                        return false;
                    throw error;
                }
            }, auditCleanupSequence([{ run: () => cleanupPublication(publication), retryFailedOperation: true }]));
        },
        async remove(name, expected) {
            let file;
            try {
                file = await opened(name, 'delete', 4096);
            }
            catch (error) {
                if (codeIs(error, 'ENOENT'))
                    return;
                throw error;
            }
            return withAuditCleanup(async () => {
                if (!sameSnapshot(file.info, expected.info))
                    throw new AuditWriteSkipped('lock_changed');
                // This DELETE-capable handle denies write/delete sharing. No rename-by-path TOCTOU, and no
                // replacement owner can be removed between comparison and disposition of this exact handle.
                await api.remove(file.handle);
            }, auditCleanupSequence([{ run: () => release(file.owner), retryFailedOperation: true }]));
        },
        retryReleasedHandles,
        close: closeOwnedDirectory,
    };
    return {
        open: (...args) => operation(() => directory.open(...args)),
        snapshot: (...args) => operation(() => directory.snapshot(...args)),
        exists: (...args) => operation(() => directory.exists(...args)),
        publish: (...args) => operation(() => directory.publish(...args)),
        remove: (...args) => operation(() => directory.remove(...args)),
        retryReleasedHandles,
        close: closeOwnedDirectory,
    };
}
export async function openWindowsAuditFile(path, maxBytes, budget, injected, existingOnly = false) {
    const directory = await openWindowsAuditDirectory(win32.dirname(path), budget, injected, existingOnly);
    try {
        const file = await directory.open(win32.basename(path), maxBytes, budget, existingOnly);
        // The directory already owns this file acquisition and closes children before
        // parents. One cleanup pass preserves every close failure without a masking finally.
        return { ...file, close: () => directory.close() };
    }
    catch (error) {
        return withAuditCleanup(async () => { throw error; }, auditCleanupSequence([{ run: () => directory.close(), retryFailedOperation: true }]));
    }
}
/** The v2 process-start/PID/token and .lock/.mutation/.guardian protocol; legacy live PIDs stay conservative. */
export async function withWindowsAuditLock(path, budget, run, injected) {
    budget.check();
    const processStart = readFileLockProcessStartIdentity(process.pid);
    if (!processStart)
        throw new AuditWriteSkipped('process_identity_unavailable');
    const directory = await openWindowsAuditDirectory(win32.dirname(path), budget, injected);
    const name = win32.basename(path);
    const guard = `.${name}.mutation`;
    const guardian = `.${name}.guardian`;
    const token = randomUUID();
    const owner = `${JSON.stringify({ v: 2, pid: process.pid, token, processStart })}\n`;
    const published = new Set();
    function parsed(snapshot) {
        try {
            const value = JSON.parse(snapshot?.text ?? 'null');
            return value && (value.v === undefined || value.v === 1 || value.v === 2)
                && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.token === 'string' && value.token.length > 0
                && (value.v !== 2 || parseFileLockProcessStartIdentity(value.processStart)) ? value : {};
        }
        catch {
            return {};
        }
    }
    function dead(snapshot) {
        const previous = parsed(snapshot);
        const pid = previous.pid;
        if (!pid)
            return false;
        const liveness = readFileLockProcessLiveness(pid);
        if (liveness !== 'alive')
            return liveness === 'dead';
        if (previous.v !== 2)
            return false;
        const claimed = parseFileLockProcessStartIdentity(previous.processStart);
        const current = readFileLockProcessStartIdentity(pid);
        // Missing/incomparable identity is not proof of reuse. No cached PID observation.
        return Boolean(claimed && current && claimed.source === current.source && !sameFileLockProcessStartIdentity(claimed, current));
    }
    const publish = (target) => directory.publish(target, owner, budget, () => published.add(target));
    async function removeOwned(target) {
        if (!published.has(target))
            return;
        const current = await directory.snapshot(target);
        const actual = parsed(current);
        if (current && actual.pid === process.pid && actual.token === token)
            await directory.remove(target, current);
        published.delete(target);
    }
    async function cleanup() {
        // Close a failed delete acquisition before reopening its delete-pending name.
        // Keep usable ancestors until every remaining owner removal is confirmed.
        if (published.size > 0)
            await directory.retryReleasedHandles();
        const errors = [];
        const outcomes = await Promise.allSettled([...published].map(removeOwned));
        for (const outcome of outcomes)
            if (outcome.status === 'rejected')
                errors.push(outcome.reason);
        if (errors.length)
            throw new AggregateError(errors, 'windows audit lock cleanup failed');
        // Removed names are gone from the set. A failed close retries only HANDLEs,
        // never snapshots or removal operations against an already-closed directory.
        await directory.close();
    }
    return withAuditCleanup(async () => {
        for (;;) {
            budget.check();
            if (await directory.exists(guardian)) {
                await budget.pause();
                continue;
            }
            if (await directory.exists(guard)) {
                const current = await directory.snapshot(guard, budget);
                if (current && dead(current))
                    await directory.remove(guard, current);
                else {
                    await budget.pause();
                    continue;
                }
            }
            if (!await directory.exists(name) && await publish(name)) {
                let contended = false;
                while (await directory.exists(guard) || await directory.exists(guardian)) {
                    contended = true;
                    await budget.pause();
                }
                if (contended) {
                    const current = await directory.snapshot(name, budget), actual = parsed(current);
                    if (!current || actual.pid !== process.pid || actual.token !== token)
                        throw new AuditWriteSkipped('lock_changed');
                }
                budget.check();
                return await run();
            }
            const current = await directory.snapshot(name, budget);
            if (current && dead(current) && await publish(guard)) {
                await withAuditCleanup(async () => {
                    const fresh = await directory.snapshot(name, budget);
                    if (!await directory.exists(guardian) && fresh && dead(fresh))
                        await directory.remove(name, fresh);
                }, auditCleanupSequence([{ run: () => removeOwned(guard), retryFailedOperation: true }]));
            }
            else
                await budget.pause();
        }
    }, auditCleanupSequence([{ run: cleanup, retryFailedOperation: true }]));
}