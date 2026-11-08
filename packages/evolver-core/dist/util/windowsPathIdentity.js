import { win32 } from 'node:path';
import { loadReferenceFfi, loadReferenceSystemLibrary } from '../benchmark/referenceNativeRuntime.js';
let api;
function windowsApi() {
    if (process.platform !== 'win32')
        throw new Error('Windows path identity is unavailable on this platform');
    if (!api) {
        loadReferenceFfi();
        const library = loadReferenceSystemLibrary('kernel32.dll');
        api = {
            open: library.func('__stdcall', 'CreateFileW', 'intptr_t', ['str16', 'uint32_t', 'uint32_t', 'void *', 'uint32_t', 'uint32_t', 'intptr_t']),
            info: library.func('__stdcall', 'GetFileInformationByHandle', 'int', ['intptr_t', 'void *']),
            close: library.func('__stdcall', 'CloseHandle', 'int', ['intptr_t']),
            driveType: library.func('__stdcall', 'GetDriveTypeW', 'uint32_t', ['str16']),
        };
    }
    return api;
}
function extended(path) {
    if (!win32.isAbsolute(path) || path.includes('\0'))
        throw new Error('Windows path identity requires an absolute path');
    if (path.startsWith('\\\\?\\'))
        return path;
    return path.startsWith('\\\\') ? `\\\\?\\UNC\\${path.slice(2)}` : `\\\\?\\${path}`;
}
export function assertWindowsFixedDrive(path) {
    const root = win32.parse(win32.resolve(path)).root;
    if (!/^[A-Za-z]:\\$/.test(root) || windowsApi().driveType(root) !== 3) {
        throw new Error('Credential parent must be on a fixed local drive');
    }
}
/** A no-follow native identity; the retained read handle denies deletion of the named object. */
export function pinWindowsPathIdentity(path, directory = false, denyWrite = false) {
    const native = windowsApi();
    const handle = native.open(extended(path), 0x80000000, denyWrite ? 1 : 3, null, 3, 0x02200000, 0);
    if (handle === -1 || handle === -1n)
        throw new Error('Unable to pin Windows path identity');
    let closed = false;
    const close = () => {
        if (closed)
            return;
        if (!native.close(handle))
            throw new Error('Unable to release Windows path identity');
        closed = true;
    };
    try {
        const info = Buffer.alloc(52);
        if (!native.info(handle, info))
            throw new Error('Unable to read Windows path identity');
        const attributes = info.readUInt32LE(0);
        if (attributes & 0x400 || Boolean(attributes & 0x10) !== directory)
            throw new Error('Windows path is redirected or has an unexpected type');
        return { dev: BigInt(info.readUInt32LE(28)), ino: BigInt(info.readUInt32LE(44)) << 32n | BigInt(info.readUInt32LE(48)), close };
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
}
let descriptorApi;
const descriptorLibraries = new Map();
function descriptorLibrary(path) {
    let library = descriptorLibraries.get(path);
    if (!library) {
        library = loadReferenceFfi().load(path);
        descriptorLibraries.set(path, library);
    }
    return library;
}
/** Borrow the runtime's descriptor HANDLE without closing a capability owned by Node/Bun. */
export function readWindowsDescriptorIdentity(fd) {
    if (!Number.isInteger(fd) || fd < 0)
        throw new Error('Invalid Windows file descriptor');
    const native = windowsApi();
    if (!descriptorApi) {
        try {
            const library = descriptorLibrary(process.execPath);
            descriptorApi = { library, handle: library.func('intptr_t uv_get_osfhandle(int fd)') };
        }
        catch {
            const library = descriptorLibrary('ucrtbase.dll');
            descriptorApi = { library, handle: library.func('intptr_t _get_osfhandle(int fd)') };
        }
    }
    const info = Buffer.alloc(52);
    if (!native.info(descriptorApi.handle(fd), info) || info.readUInt32LE(0) & 0x410)
        throw new Error('Invalid Windows descriptor identity');
    return { dev: BigInt(info.readUInt32LE(28)), ino: BigInt(info.readUInt32LE(44)) << 32n | BigInt(info.readUInt32LE(48)) };
}
/** Named stat's dev=0 is not permission to ignore the volume of the opened file. */
export function sameWindowsOpenedPathIdentity(path, opened, fd) {
    let expected = opened;
    if (fd !== undefined) {
        const actual = readWindowsDescriptorIdentity(fd);
        if (actual.ino !== opened.ino || opened.dev !== 0n && actual.dev !== opened.dev)
            return false;
        expected = actual;
    }
    const named = pinWindowsPathIdentity(path);
    try {
        return expected.dev === named.dev && expected.ino > 0n && expected.ino === named.ino;
    }
    finally {
        named.close();
    }
}