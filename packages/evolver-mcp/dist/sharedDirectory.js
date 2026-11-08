import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { util } from '@evomap/evolver-core';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { getSystemErrorName } from 'node:util';
import { assertInstallerSyncScopeActive } from './installerSync.js';
let posixApi;
function posix() {
    if (!posixApi) {
        const ffi = util.loadNativeFfi();
        const library = ffi.load(null);
        posixApi = {
            library,
            openAt: library.func('int openat(int parent, const char *name, int flags, ...)'),
            linkAt: library.func('int linkat(int fromParent, const char *fromName, int toParent, const char *toName, int flags)'),
            renameAt: library.func('int renameat(int fromParent, const char *fromName, int toParent, const char *toName)'),
            unlinkAt: library.func('int unlinkat(int parent, const char *name, int flags)'),
            errno: () => ffi.errno(),
        };
    }
    return posixApi;
}
function nativeFailure(path) {
    const number = posix().errno();
    const code = number > 0 ? getSystemErrorName(-number) : 'EIO';
    return Object.assign(new Error(`Shared directory operation failed: ${path}`), { code });
}
let windowsApi;
function windowsPath(path) {
    if (path.startsWith('\\\\?\\'))
        return path;
    return path.startsWith('\\\\') ? `\\\\?\\UNC\\${path.slice(2)}` : `\\\\?\\${path}`;
}
function windows() {
    if (!windowsApi) {
        const ffi = util.loadNativeFfi();
        const library = ffi.load('kernel32.dll');
        let runtimeLibrary;
        let adopt;
        let releaseDescriptor;
        try {
            runtimeLibrary = ffi.load(process.execPath);
            const openHandle = runtimeLibrary.func('int uv_open_osfhandle(intptr_t handle)');
            adopt = handle => Number(openHandle(handle));
            releaseDescriptor = closeSync;
        }
        catch {
            runtimeLibrary = ffi.load('ucrtbase.dll');
            const openHandle = runtimeLibrary.func('int _open_osfhandle(intptr_t handle, int flags)');
            const closeDescriptor = runtimeLibrary.func('int _close(int fd)');
            adopt = (handle, flags) => Number(openHandle(handle, flags));
            releaseDescriptor = fd => { if (closeDescriptor(fd) !== 0)
                throw new Error('Shared file descriptor cleanup failed'); };
        }
        windowsApi = {
            library, runtimeLibrary, adopt, releaseDescriptor,
            open: library.func('__stdcall', 'CreateFileW', 'intptr_t', ['str16', 'uint32_t', 'uint32_t', 'void *', 'uint32_t', 'uint32_t', 'intptr_t']),
            info: library.func('__stdcall', 'GetFileInformationByHandle', 'int', ['intptr_t', 'void *']),
            close: library.func('__stdcall', 'CloseHandle', 'int', ['intptr_t']),
            error: library.func('__stdcall', 'GetLastError', 'uint32_t', []),
        };
    }
    return windowsApi;
}
function windowsFileFailure(path, error) {
    const code = error === 2 || error === 3 ? 'ENOENT' : error === 80 || error === 183 ? 'EEXIST'
        : error === 5 ? 'EACCES' : error === 32 || error === 33 ? 'EBUSY' : 'EIO';
    return Object.assign(new Error(`Shared file open failed: ${path}`), { code });
}
function openWindowsFile(path, flags) {
    if (flags & constants.O_TRUNC || flags & constants.O_APPEND || flags & constants.O_CREAT && !(flags & constants.O_EXCL)) {
        throw new Error('Shared file open must not truncate or non-exclusively create a file');
    }
    const api = windows();
    const access = flags & constants.O_RDWR ? 0xc0000000 : flags & constants.O_WRONLY ? 0x40000000 : 0x80000000;
    const handle = api.open(windowsPath(path), access, 3, null, flags & constants.O_CREAT ? 1 : 3, 0x00200080, 0);
    if (handle === -1 || handle === -1n)
        throw windowsFileFailure(path, Number(api.error()));
    let fd;
    try {
        const info = Buffer.alloc(52);
        if (!api.info(handle, info))
            throw windowsFileFailure(path, Number(api.error()));
        if (info.readUInt32LE(0) & 0x400)
            throw Object.assign(new Error('Shared config leaf is a reparse point'), { code: 'ELOOP' });
        if (info.readUInt32LE(0) & 0x10)
            throw new Error('Shared config leaf is not a regular file');
        const descriptor = api.adopt(handle, (flags & (constants.O_WRONLY | constants.O_RDWR)) | 0x8080);
        if (descriptor < 0)
            throw new Error('Unable to adopt shared file handle');
        fd = descriptor;
        // Runtime-specific descriptor tables must refer to the exact no-follow handle, never an unrelated fd.
        const stat = fstatSync(fd, { bigint: true });
        const inode = BigInt(info.readUInt32LE(44)) << 32n | BigInt(info.readUInt32LE(48));
        if (!stat.isFile() || stat.ino !== inode || stat.dev !== 0n && stat.dev !== BigInt(info.readUInt32LE(28))) {
            throw new Error('Shared file descriptor does not match its no-follow handle');
        }
        return fd;
    }
    catch (error) {
        try {
            if (fd === undefined)
                api.close(handle);
            else
                api.releaseDescriptor(fd);
        }
        catch (cleanupError) {
            if (error instanceof Error)
                error.cleanupError = cleanupError;
        }
        throw error;
    }
}
/** The operation completed on the pinned inode, but its pathname is no longer trusted.
 * This is not a durable-success receipt; callers must retain evidence rather than blindly retry. */
export class SharedDirectoryPostconditionError extends Error {
    operation;
    code = 'SHARED_DIRECTORY_POSTCONDITION';
    operationCompleted = true;
    retryable = false;
    constructor(operation, cause) {
        super(`Shared config parent changed or could not be revalidated after ${operation} completed`, { cause });
        this.operation = operation;
        this.name = 'SharedDirectoryPostconditionError';
    }
}
let operationHookForTest;
export function _setSharedDirectoryOperationHookForTest(hook) { operationHookForTest = hook; }
function nameIn(directory, path) {
    const name = basename(path);
    if (resolve(dirname(path)) !== directory || name === '.' || name === '..')
        throw new Error('Shared operation left its pinned directory');
    return name;
}
/** Pin directory components before using a leaf. POSIX writes use *at calls; Windows handles deny parent
 * deletion/rename for the whole operation. O_NOFOLLOW on the leaf alone is not a parent fence. */
export function pinSharedDirectory(path) {
    const directory = resolve(path);
    const root = parse(directory).root;
    const components = directory.slice(root.length).split(process.platform === 'win32' ? /[\\/]/ : /\//).filter(Boolean);
    const handles = [];
    let fd;
    let missing = false;
    let expected;
    let current = root;
    let closed = false;
    const close = () => {
        if (closed)
            return;
        closed = true;
        const errors = [];
        for (const handle of handles.splice(0).reverse()) {
            try {
                if (process.platform === 'win32') {
                    if (!windows().close(handle))
                        throw new Error('Unable to release shared directory handle');
                }
                else
                    closeSync(Number(handle));
            }
            catch (error) {
                errors.push(error);
            }
        }
        if (errors.length)
            throw new AggregateError(errors, 'Shared directory handle cleanup failed');
    };
    try {
        if (process.platform !== 'win32') {
            if (!constants.O_DIRECTORY || !constants.O_NOFOLLOW)
                throw new Error('Safe shared-directory open is unavailable');
            const closeExec = process.platform === 'darwin' ? 0x1000000 : 0x80000;
            const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeExec;
            fd = openSync(root, flags);
            handles.push(fd);
            for (const component of components) {
                current = join(current, component);
                const next = Number(posix().openAt(fd, component, flags));
                if (next < 0) {
                    const error = nativeFailure(current);
                    if (error.code === 'ENOENT') {
                        missing = true;
                        break;
                    }
                    throw error;
                }
                handles.push(next);
                if (!fstatSync(next).isDirectory())
                    throw new Error('Shared config parent is not a directory');
                fd = next;
            }
            if (!missing)
                expected = fstatSync(fd, { bigint: true });
        }
        else {
            for (const component of [root, ...components]) {
                current = component === root ? root : join(current, component);
                let stat;
                try {
                    stat = lstatSync(current, { bigint: true });
                }
                catch (error) {
                    if (error.code === 'ENOENT') {
                        missing = true;
                        break;
                    }
                    throw error;
                }
                if (stat.isSymbolicLink() || !stat.isDirectory())
                    throw new Error('Shared config parent is not a real directory');
                const handle = windows().open(windowsPath(current), 0x80000000, 3, null, 3, 0x02200000, 0);
                if (handle === -1 || handle === -1n)
                    throw new Error('Unable to pin shared config parent');
                handles.push(handle);
                const info = Buffer.alloc(52);
                if (!windows().info(handle, info) || (info.readUInt32LE(0) & 0x400) !== 0 || (info.readUInt32LE(0) & 0x10) === 0) {
                    throw new Error('Shared config parent became a reparse point');
                }
                const volume = BigInt(info.readUInt32LE(28)), inode = BigInt(info.readUInt32LE(44)) << 32n | BigInt(info.readUInt32LE(48));
                if (stat.ino <= 0n || volume <= 0n || inode !== stat.ino || stat.dev !== 0n && stat.dev !== volume) {
                    throw new Error('Shared config parent changed while being pinned');
                }
            }
            if (!missing)
                expected = lstatSync(directory, { bigint: true });
        }
    }
    catch (error) {
        try {
            close();
        }
        catch (cleanupError) {
            if (error instanceof Error)
                error.cleanupError = cleanupError;
        }
        throw error;
    }
    const assertCurrent = () => {
        if (closed)
            throw new Error('Shared directory handle is closed');
        if (missing)
            throw Object.assign(new Error('Shared config directory is missing'), { code: 'ENOENT' });
        const named = lstatSync(directory, { bigint: true });
        if (named.isSymbolicLink() || !named.isDirectory() || named.dev !== expected?.dev || named.ino !== expected?.ino) {
            throw new Error('Shared config parent changed after it was pinned');
        }
    };
    const assertAfterOperation = (operation) => {
        try {
            assertCurrent();
        }
        catch (cause) {
            throw new SharedDirectoryPostconditionError(operation, cause);
        }
    };
    return {
        path: directory, missing, assertCurrent,
        open(path, flags, mode = 0o600) {
            if (flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND))
                assertInstallerSyncScopeActive();
            const name = nameIn(directory, path);
            assertCurrent();
            operationHookForTest?.('open', directory);
            const result = process.platform === 'win32' ? openWindowsFile(path, flags)
                : Number(posix().openAt(fd, name, flags | constants.O_NOFOLLOW, 'unsigned int', mode));
            if (result < 0)
                throw nativeFailure(path);
            try {
                assertAfterOperation('open');
                return result;
            }
            catch (error) {
                try {
                    if (process.platform === 'win32')
                        windows().releaseDescriptor(result);
                    else
                        closeSync(result);
                }
                catch (cleanupError) {
                    if (error instanceof Error)
                        error.cleanupError = cleanupError;
                }
                throw error;
            }
        },
        link(from, to) {
            assertInstallerSyncScopeActive();
            const a = nameIn(directory, from), b = nameIn(directory, to);
            assertCurrent();
            if (process.platform === 'win32')
                throw new Error('Windows shared link must use its pinned path operation');
            operationHookForTest?.('link', directory);
            if (posix().linkAt(fd, a, fd, b, 0) !== 0)
                throw nativeFailure(to);
            assertAfterOperation('link');
        },
        rename(from, to) {
            assertInstallerSyncScopeActive();
            const a = nameIn(directory, from), b = nameIn(directory, to);
            assertCurrent();
            if (process.platform === 'win32')
                throw new Error('Windows shared rename must use its pinned path operation');
            operationHookForTest?.('rename', directory);
            if (posix().renameAt(fd, a, fd, b) !== 0)
                throw nativeFailure(to);
            assertAfterOperation('rename');
        },
        unlink(path) {
            assertInstallerSyncScopeActive();
            const name = nameIn(directory, path);
            assertCurrent();
            if (process.platform === 'win32')
                throw new Error('Windows shared unlink must use its pinned path operation');
            operationHookForTest?.('unlink', directory);
            if (posix().unlinkAt(fd, name, 0) !== 0)
                throw nativeFailure(path);
            assertAfterOperation('unlink');
        },
        sync() {
            assertInstallerSyncScopeActive();
            assertCurrent();
            operationHookForTest?.('sync', directory);
            // Windows does not expose directory fsync through this read capability; file descriptors are flushed.
            if (process.platform !== 'win32') {
                try {
                    fsyncSync(fd);
                }
                catch (error) {
                    if (error?.code !== 'EINVAL')
                        throw error;
                    assertCurrent();
                    return;
                }
                assertAfterOperation('sync');
            }
            else
                assertCurrent();
        },
        close,
    };
}