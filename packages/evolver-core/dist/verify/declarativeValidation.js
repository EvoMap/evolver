import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { openPosixReferenceRoot, PosixReferenceError } from '../benchmark/referenceNativePosix.js';
import { openWindowsReferenceRoot, WindowsReferenceError } from '../benchmark/referenceNativeWindows.js';
const MAX_FILES = 64;
const MAX_FILE_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function dataObject(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new Error('invalid_declarative_validation_spec');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== keys.length
        || keys.some((key) => !descriptors[key] || !('value' in descriptors[key])))
        throw new Error('invalid_declarative_validation_spec');
    return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
/** Portable relative paths: no platform aliases or private Git/recovery metadata. */
export function declarativeValidationPath(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 240 || /[\\<>:"|?*]/u.test(value)
        || [...value].some((character) => {
            const point = character.codePointAt(0);
            return point < 32 || point === 127 || (point >= 0xd800 && point <= 0xdfff);
        })) {
        throw new Error('invalid_declarative_validation_path');
    }
    const parts = value.split('/');
    if (parts.length > 32 || parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part)
        || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)
        || ['.git', 'node_modules'].includes(part.toLowerCase()) || part.toLowerCase().startsWith('.evolver-llm-recovery-'))) {
        throw new Error('invalid_declarative_validation_path');
    }
    return value;
}
/** Freeze operator acceptance before dispatch; neither model output nor a changed spec can redefine success. */
export function parseDeclarativeValidationSpec(input) {
    const value = dataObject(input, ['version', 'files']);
    if (value['version'] !== 1 || !Array.isArray(value['files']) || value['files'].length < 1 || value['files'].length > MAX_FILES) {
        throw new Error('invalid_declarative_validation_spec');
    }
    const entries = value['files'];
    if (Object.getPrototypeOf(entries) !== Array.prototype || Reflect.ownKeys(entries).length !== entries.length + 1
        || Array.from({ length: entries.length }, (_, index) => Object.getOwnPropertyDescriptor(entries, String(index)))
            .some((descriptor) => !descriptor || !('value' in descriptor)))
        throw new Error('invalid_declarative_validation_spec');
    const seen = new Set();
    const files = Array.from(entries, (entry) => {
        const file = dataObject(entry, ['path', 'sha256']);
        const path = declarativeValidationPath(file['path']);
        // Keep the operator's exact spelling for I/O, but refuse aliases on normalization-
        // insensitive filesystems as well as case-insensitive filesystems before dispatch.
        const portableIdentity = path.normalize('NFC').toLowerCase().normalize('NFC');
        if (typeof file['sha256'] !== 'string' || !SHA256.test(file['sha256']) || seen.has(portableIdentity)) {
            throw new Error('invalid_declarative_validation_spec');
        }
        seen.add(portableIdentity);
        return Object.freeze({ path, sha256: file['sha256'] });
    });
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return Object.freeze({ version: 1, files: Object.freeze(files) });
}
export function declarativeValidationDigest(spec) {
    return `sha256:${digest(JSON.stringify(parseDeclarativeValidationSpec(spec)))}`;
}
const pendingWindowsCleanup = new Set();
let unknownPosixCleanup = false;
function settlePriorCleanup() {
    for (const close of pendingWindowsCleanup) {
        try {
            close();
            pendingWindowsCleanup.delete(close);
        }
        catch { /* Keep the exact HANDLE owner for another recovery attempt. */ }
    }
    if (pendingWindowsCleanup.size || unknownPosixCleanup)
        throw new Error('declarative_validation_cleanup_pending');
}
function openRoot(cwd) {
    const root = realpathSync.native(cwd);
    if (process.platform === 'win32')
        return openWindowsReferenceRoot(root);
    if (process.platform === 'linux' || process.platform === 'darwin')
        return openPosixReferenceRoot(root, process.platform);
    throw new Error('declarative_validation_native_unavailable');
}
function rememberNativeFailure(error) {
    if (error instanceof WindowsReferenceError && error.retryCleanup)
        pendingWindowsCleanup.add(error.retryCleanup);
    if (error instanceof PosixReferenceError && error.code === 'reference_native_cleanup_failed')
        unknownPosixCleanup = true;
}
function closeRoot(root) {
    try {
        root.close();
    }
    catch (error) {
        // Windows retains exact HANDLEs; a POSIX failed close must not retry a reusable numeric fd.
        if (process.platform === 'win32')
            pendingWindowsCleanup.add(() => root.close());
        else
            unknownPosixCleanup = true;
        throw error;
    }
}
/** Check the real native backend and cleanup before claiming input or sending anything to the provider. */
export function assertDeclarativeValidationAvailable(cwd) {
    let root;
    let failed = false;
    try {
        settlePriorCleanup();
        root = openRoot(cwd);
    }
    catch (error) {
        rememberNativeFailure(error);
        failed = true;
    }
    finally {
        if (root) {
            try {
                closeRoot(root);
            }
            catch {
                failed = true;
            }
        }
    }
    if (failed)
        throw new Error('declarative validation unavailable: native reader or cleanup could not be confirmed');
}
/**
 * Independently hash the final bytes. changedPaths MUST come from the trusted host's complete Git
 * enumeration (tracked/staged and all untracked, including ignored files), never from model claims.
 * This executes no repository code and therefore reports no process/OS sandbox or functional-test claim.
 */
export function runDeclarativeValidation(input, cwd, changedPaths, signal) {
    const validator = {
        id: 'declarative-file-sha256', version: 'declarative-file-sha256.v1', status: 'not_run',
        results: [], skipped: [], isolated: false, isolationTier: 'none', passed: false, score: 0.2,
    };
    const result = () => ({ passed: validator.passed === true, score: validator.score ?? 0.2, validator });
    let spec;
    try {
        spec = parseDeclarativeValidationSpec(input);
        validator.plan_digest = declarativeValidationDigest(spec);
        if (!Array.isArray(changedPaths) || changedPaths.length < 1 || changedPaths.length > MAX_FILES)
            throw new Error();
        const accepted = new Set(spec.files.map((file) => file.path));
        const seen = new Set();
        for (const entry of changedPaths) {
            const path = declarativeValidationPath(entry);
            if (!accepted.has(path) || seen.has(path))
                throw new Error();
            seen.add(path);
        }
    }
    catch {
        validator.reason = 'malformed_plan';
        return result();
    }
    if (signal?.aborted)
        return result();
    const results = [];
    validator.results = results;
    let root;
    let failed = false;
    try {
        settlePriorCleanup();
        root = openRoot(cwd);
        validator.status = 'ran';
        for (const file of spec.files) {
            if (signal?.aborted) {
                failed = true;
                break;
            }
            let passed = false;
            let summary;
            try {
                const actual = digest(root.read(file.path.split('/'), MAX_FILE_BYTES));
                passed = actual === file.sha256;
                summary = passed ? 'exact_file_bytes_verified' : 'file_sha256_mismatch';
            }
            catch (error) {
                rememberNativeFailure(error);
                // Native readers reject symlinks/reparse points, hardlinks, non-files, oversized files and races.
                summary = 'file_read_refused';
            }
            results.push({ label: file.path, cmd: `sha256 ${file.path}`, allowed: true, exitCode: null, stdoutSummary: summary, passed });
            if (!passed)
                failed = true;
        }
    }
    catch (error) {
        rememberNativeFailure(error);
        failed = true;
        validator.reason = 'policy_denied';
    }
    finally {
        if (root) {
            try {
                closeRoot(root);
            }
            catch {
                failed = true;
                for (const entry of results) {
                    entry.passed = false;
                    entry.stdoutSummary = 'file_reader_cleanup_failed';
                }
            }
        }
    }
    validator.passed = !failed && !signal?.aborted && results.length === spec.files.length && results.every((entry) => entry.passed);
    validator.score = validator.passed ? 0.95 : 0.2;
    return result();
}