import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NODE_SECRET_RE = /^[a-f0-9]{64}$/i;
const WINDOWS_PROTECTED_VALUE_RE = /^[a-z0-9+/]+={0,2}$/i;
const MAX_PROTECTED_VALUE_LENGTH = 16_384;
export class PrivateNodeCredentialReadError extends Error {
    constructor() {
        super('stored private node credential is unreadable');
        this.name = 'PrivateNodeCredentialReadError';
    }
}
export class PrivateNodeCredentialStore {
    directory;
    path;
    platform;
    windowsProtector;
    constructor(proxyStorePath, options = {}) {
        this.platform = options.platform ?? process.platform;
        this.windowsProtector = this.platform === 'win32'
            ? options.windowsProtector ?? createWindowsDpapiProtector()
            : undefined;
        if (this.windowsProtector)
            verifyWindowsProtector(this.windowsProtector);
        this.directory = join(dirname(resolve(proxyStorePath)), '.private-credentials');
        this.path = join(this.directory, this.platform === 'win32' ? 'node-secret.dpapi' : 'node-secret');
        this.prepareDirectory();
    }
    read() {
        if (!existsSync(this.path))
            return undefined;
        this.assertRegularFile(this.path);
        if (this.platform !== 'win32')
            chmodSync(this.path, FILE_MODE);
        const storedValue = readFileSync(this.path, 'utf8').trim();
        try {
            const value = this.windowsProtector
                ? this.windowsProtector.unprotect(assertWindowsProtectedValue(storedValue))
                : storedValue;
            if (!NODE_SECRET_RE.test(value))
                throw new PrivateNodeCredentialReadError();
            return value;
        }
        catch {
            throw new PrivateNodeCredentialReadError();
        }
    }
    write(nodeSecret) {
        if (!NODE_SECRET_RE.test(nodeSecret))
            throw new Error('private node credential is invalid');
        const storedValue = this.windowsProtector
            ? assertWindowsProtectedValue(this.windowsProtector.protect(nodeSecret))
            : nodeSecret;
        this.prepareDirectory();
        if (existsSync(this.path))
            this.assertRegularFile(this.path);
        const temporaryPath = join(this.directory, `.node-secret.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
        let descriptor;
        try {
            descriptor = openSync(temporaryPath, 'wx', FILE_MODE);
            writeFileSync(descriptor, storedValue, 'utf8');
            fsyncSync(descriptor);
            closeSync(descriptor);
            descriptor = undefined;
            renameSync(temporaryPath, this.path);
            if (this.platform !== 'win32')
                chmodSync(this.path, FILE_MODE);
            if (this.platform !== 'win32')
                syncDirectory(this.directory);
        }
        catch (error) {
            if (descriptor !== undefined)
                closeSync(descriptor);
            if (existsSync(temporaryPath))
                unlinkSync(temporaryPath);
            throw error;
        }
    }
    prepareDirectory() {
        const parent = dirname(this.directory);
        const parentStat = lstatSync(parent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
            throw new Error(`private credential parent must be a real directory: ${parent}`);
        }
        if (this.platform !== 'win32' && (parentStat.mode & 0o022) !== 0) {
            throw new Error(`private credential parent must not be group/world-writable: ${parent}`);
        }
        const directoryExisted = existsSync(this.directory);
        mkdirSync(this.directory, { recursive: true, mode: DIRECTORY_MODE });
        const stat = lstatSync(this.directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error(`private credential path must be a real directory: ${this.directory}`);
        }
        if (this.platform !== 'win32')
            chmodSync(this.directory, DIRECTORY_MODE);
        if (!directoryExisted && this.platform !== 'win32')
            syncDirectory(parent);
    }
    assertRegularFile(path) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error(`private credential must be a regular file: ${path}`);
        }
    }
}
function assertWindowsProtectedValue(value) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_PROTECTED_VALUE_LENGTH || !WINDOWS_PROTECTED_VALUE_RE.test(trimmed)) {
        throw new Error('stored private node credential ciphertext is invalid');
    }
    return trimmed;
}
function createWindowsDpapiProtector() {
    const systemRoot = process.env['SystemRoot']?.trim();
    if (!systemRoot || !isAbsolute(systemRoot)) {
        throw new Error('Windows private credential persistence requires an absolute SystemRoot');
    }
    const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let executableIsSafe = false;
    try {
        const executableStat = lstatSync(executable);
        executableIsSafe = executableStat.isFile() && !executableStat.isSymbolicLink();
    }
    catch {
        // Normalize filesystem errors so local paths are not included in startup logs.
    }
    if (!executableIsSafe) {
        throw new Error('Windows private credential persistence requires Windows PowerShell');
    }
    return {
        preflight: () => {
            const canary = randomBytes(32).toString('hex');
            if (runWindowsPowerShell(executable, WINDOWS_DPAPI_PREFLIGHT_SCRIPT, canary) !== canary) {
                throw new Error('Windows private credential protection preflight failed');
            }
        },
        protect: (secret) => runWindowsPowerShell(executable, WINDOWS_DPAPI_PROTECT_SCRIPT, secret),
        unprotect: (protectedValue) => runWindowsPowerShell(executable, WINDOWS_DPAPI_UNPROTECT_SCRIPT, protectedValue),
    };
}
function verifyWindowsProtector(protector) {
    try {
        if (protector.preflight) {
            protector.preflight();
            return;
        }
        const canary = randomBytes(32).toString('hex');
        const protectedCanary = assertWindowsProtectedValue(protector.protect(canary));
        if (protector.unprotect(protectedCanary) !== canary) {
            throw new Error('round trip mismatch');
        }
    }
    catch {
        throw new Error('Windows private credential protection preflight failed');
    }
}
function runWindowsPowerShell(executable, script, input) {
    try {
        return execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8',
            input,
            maxBuffer: 64 * 1024,
            stdio: ['pipe', 'pipe', 'ignore'],
            timeout: 15_000,
            windowsHide: true,
        }).trim();
    }
    catch {
        throw new Error('Windows private credential protection failed');
    }
}
const WINDOWS_DPAPI_PREFLIGHT_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$plain = [Console]::In.ReadToEnd()',
    '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
    '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
    '$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)',
    '$restored = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, $scope)',
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($restored))',
].join('; ');
const WINDOWS_DPAPI_PROTECT_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$plain = [Console]::In.ReadToEnd()',
    '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
    '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
    '$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)',
    '[Console]::Out.Write([Convert]::ToBase64String($protected))',
].join('; ');
const WINDOWS_DPAPI_UNPROTECT_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$protected = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
    '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
    '$bytes = [Security.Cryptography.ProtectedData]::Unprotect($protected, $null, $scope)',
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))',
].join('; ');
function syncDirectory(path) {
    const descriptor = openSync(path, 'r');
    try {
        fsyncSync(descriptor);
    }
    finally {
        closeSync(descriptor);
    }
}