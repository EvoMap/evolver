import { loadReferenceSystemLibrary } from '../benchmark/referenceNativeRuntime.js';
// Windows FILETIME is 100 ns since 1601-01-01; .NET UTC ticks start at 0001-01-01.
const FILETIME_EPOCH_TICKS = 504911232000000000n;
const MAX_DOTNET_TICKS = 3155378975999999999n;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STATUS_INVALID_CID = 0xc000000b;
let api;
let pendingClose;
let closeUnconfirmed = false;
function validHandle(value) {
    return typeof value === 'bigint' && value > 0n
        && value !== 0xffffffffn && value < 0xffffffffffffffffn;
}
function succeeded(value) {
    // BOOL is a signed 32-bit integer, not JS truthiness. Keep bigint results exact too;
    // reject zero, coercible values and anything outside the declared ABI's range.
    if (typeof value === 'bigint')
        return value !== 0n && value >= -0x80000000n && value <= 0x7fffffffn;
    return typeof value === 'number' && Number.isInteger(value) && value !== 0
        && value >= -0x8000_0000 && value <= 0x7fff_ffff;
}
function processApi() {
    if (api)
        return api;
    // NtOpenProcess returns its failure status directly. Unlike a GetLastError
    // follow-up, that status cannot be clobbered across the JS/native boundary.
    const kernel = loadReferenceSystemLibrary('kernel32.dll');
    const nt = loadReferenceSystemLibrary('ntdll.dll');
    const open = nt.func('int32_t __stdcall NtOpenProcess(void *process, uint32_t access, void *attributes, void *clientId)');
    const times = kernel.func('int __stdcall GetProcessTimes(void *handle, _Out_ void *creation, _Out_ void *exit, _Out_ void *kernel, _Out_ void *user)');
    const close = kernel.func('int __stdcall CloseHandle(void *handle)');
    api = { open, times, close };
    return api;
}
function closePending(native) {
    if (pendingClose === undefined)
        return;
    // A native binding may throw after CloseHandle has already released its numeric value.
    // Retrying that value could close an unrelated handle that Windows later reuses.
    if (closeUnconfirmed)
        throw new Error('process_identity_close_unconfirmed');
    try {
        if (!succeeded(native.close(pendingClose)))
            throw new Error('process_identity_close_failed');
    }
    catch (error) {
        closeUnconfirmed = true;
        throw error;
    }
    pendingClose = undefined;
}
function validPid(pid) {
    return Number.isInteger(pid) && pid > 0 && pid <= 0xffff_ffff;
}
function status(value) {
    // Koffi's int32_t binding returns a signed number, but preserve an equivalent
    // uint32 representation if a supported runtime exposes the raw NTSTATUS bits.
    return typeof value === 'number' && Number.isInteger(value) && value >= -0x8000_0000 && value <= 0xffff_ffff
        ? value >>> 0
        : undefined;
}
function nativeOpenBuffers(pid) {
    // x64 and arm64 Windows share the 48-byte OBJECT_ATTRIBUTES and 16-byte
    // CLIENT_ID layouts: ULONG Length at 0, pointer-aligned HANDLE at 8,
    // then pointer/ULONG/pointer/pointer; both CLIENT_ID members are HANDLEs.
    const process = Buffer.alloc(8);
    const attributes = Buffer.alloc(48);
    const clientId = Buffer.alloc(16);
    attributes.writeUInt32LE(48, 0);
    clientId.writeBigUInt64LE(BigInt(pid), 0);
    return { process, attributes, clientId };
}
/** A fresh, read-only native observation. No result is cached: PID values and numeric
 * HANDLE values may both be reused. Close failure poisons later observations rather
 * than retrying an uncertain numeric HANDLE. */
function observeWindowsProcess(pid) {
    if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch) || !validPid(pid)) {
        return { liveness: 'unknown' };
    }
    try {
        const native = processApi();
        // An unconfirmed close withholds this and all later probes. Retrying may close
        // an unrelated object after Windows has reused the numeric HANDLE.
        closePending(native);
        const open = nativeOpenBuffers(pid);
        const openStatus = status(native.open(open.process, PROCESS_QUERY_LIMITED_INFORMATION, open.attributes, open.clientId));
        const handle = open.process.readBigUInt64LE();
        // STATUS_INVALID_CID is definitive only when the out parameter remained
        // NULL. A nonzero out value is contradictory ABI evidence: it is never
        // adopted or closed because there was no successful acquisition contract.
        if (openStatus === STATUS_INVALID_CID)
            return handle === 0n ? { liveness: 'dead' } : { liveness: 'unknown' };
        if (openStatus !== 0)
            return { liveness: 'unknown' };
        if (!validHandle(handle))
            return { liveness: 'unknown' };
        pendingClose = handle;
        try {
            const creation = Buffer.alloc(8);
            const exit = Buffer.alloc(8);
            const kernel = Buffer.alloc(8);
            const user = Buffer.alloc(8);
            if (!succeeded(native.times(handle, creation, exit, kernel, user)))
                return { liveness: 'unknown' };
            // A retained HANDLE preserves a terminated process object. Its nonzero exit
            // FILETIME is affirmative death evidence, independent of creation metadata.
            if (exit.readBigUInt64LE() !== 0n)
                return { liveness: 'dead' };
            // A live result must have a valid, exact creation identity too. Otherwise a
            // malformed ABI observation cannot license lock ownership decisions.
            const fileTime = creation.readBigUInt64LE();
            const ticks = fileTime + FILETIME_EPOCH_TICKS;
            return fileTime > 0n && ticks <= MAX_DOTNET_TICKS
                ? { liveness: 'alive', startTimeTicks: ticks.toString() }
                : { liveness: 'unknown' };
        }
        finally {
            closePending(native);
        }
    }
    catch {
        // Access denied, PID exit races, unavailable ABI and unconfirmed cleanup all fail closed.
        return { liveness: 'unknown' };
    }
}
/** Fresh, read-only liveness for Windows lock ownership. `dead` is returned only
 * for STATUS_INVALID_CID with a NULL out HANDLE or a confirmed nonzero exit FILETIME. */
export function readWindowsProcessLiveness(pid) {
    return observeWindowsProcess(pid).liveness;
}
/** Fresh process-generation metadata. Unknown and dead observations are never cached here. */
export function readWindowsProcessStartTimeTicks(pid) {
    return observeWindowsProcess(pid).startTimeTicks ?? null;
}