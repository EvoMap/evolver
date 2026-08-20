import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { bootstrap as coreBootstrap, util } from '@evomap/evolver-core';
import { resolveBootstrapStateDir } from './bootstrap.js';
const MAX_READINESS_BYTES = 16 * 1024;
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
function syncDirectory(path) {
    let descriptor;
    try {
        descriptor = openSync(path, constants.O_RDONLY);
        fsyncSync(descriptor);
    }
    catch (error) {
        if (isErrno(error, 'EINVAL'))
            return;
        if (process.platform === 'win32' && (isErrno(error, 'EPERM') || isErrno(error, 'EACCES')))
            return;
        throw error;
    }
    finally {
        if (descriptor !== undefined)
            closeSync(descriptor);
    }
}
function readExistingReadiness(path) {
    try {
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_READINESS_BYTES)
            || before.dev <= 0n || before.ino <= 0n) {
            throw new Error('bootstrap readiness path is not a bounded regular file');
        }
        const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const opened = fstatSync(descriptor, { bigint: true });
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
                throw new Error('bootstrap readiness path changed while opening');
            }
            const bytes = Buffer.alloc(MAX_READINESS_BYTES + 1);
            let offset = 0;
            while (offset < bytes.length) {
                const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
                if (count === 0)
                    break;
                offset += count;
            }
            if (offset > MAX_READINESS_BYTES) {
                throw new Error('bootstrap readiness path is not a bounded regular file');
            }
            const raw = bytes.subarray(0, offset).toString('utf8');
            const after = fstatSync(descriptor, { bigint: true });
            if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
                || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
                throw new Error('bootstrap readiness path changed while reading');
            }
            const parsed = coreBootstrap.parseLifecycleBootstrapReadinessJson(raw);
            if (!parsed)
                throw new Error('bootstrap readiness receipt is corrupt');
            return parsed;
        }
        finally {
            closeSync(descriptor);
        }
    }
    catch (error) {
        if (isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    }
}
export function publishLifecycleBootstrapReadiness(input) {
    const transactionId = input.env[coreBootstrap.LIFECYCLE_BOOTSTRAP_TRANSACTION_ENV]?.trim();
    if (!transactionId)
        return;
    const pid = input.pid ?? process.pid;
    const supervisorPid = input.supervisorPid ?? process.ppid;
    const readProcessStartIdentity = input.readProcessStartIdentity
        ?? util.readFileLockProcessStartIdentity;
    const pidProcessStartIdentity = readProcessStartIdentity(pid);
    const supervisorProcessStartIdentity = readProcessStartIdentity(supervisorPid);
    if (!pidProcessStartIdentity || !supervisorProcessStartIdentity) {
        throw new Error('lifecycle bootstrap readiness process identity is unavailable');
    }
    const readiness = {
        schema: coreBootstrap.LIFECYCLE_BOOTSTRAP_READINESS_SCHEMA,
        transactionId,
        pid,
        pidProcessStartIdentity,
        supervisorPid,
        supervisorProcessStartIdentity,
        startedAt: input.startedAt,
        ipcUrl: input.ipcUrl,
    };
    if (!coreBootstrap.parseLifecycleBootstrapReadiness(readiness)) {
        throw new Error('invalid lifecycle bootstrap readiness receipt');
    }
    const stateDir = resolveBootstrapStateDir(input.env);
    const state = lstatSync(stateDir);
    if (!state.isDirectory() || state.isSymbolicLink()) {
        throw new Error('lifecycle bootstrap state directory is not trusted');
    }
    if (process.platform !== 'win32') {
        const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
        if ((uid !== undefined && state.uid !== uid) || (state.mode & 0o077) !== 0) {
            throw new Error('lifecycle bootstrap state directory is not owner-only');
        }
    }
    const path = join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_READINESS_FILE);
    const lockPath = join(stateDir, coreBootstrap.LIFECYCLE_BOOTSTRAP_READINESS_LOCK_FILE);
    util.acquireLock(lockPath, { maxTries: 500, waitMs: 10 });
    let publicationError;
    let publicationFailed = false;
    try {
        const existing = readExistingReadiness(path);
        if (existing && existing.transactionId !== transactionId) {
            throw new Error('lifecycle bootstrap readiness is owned by another transaction');
        }
        const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
        let descriptor;
        try {
            descriptor = openSync(temporary, 'wx', 0o600);
            writeFileSync(descriptor, `${JSON.stringify(readiness)}\n`, { encoding: 'utf8' });
            fchmodSync(descriptor, 0o600);
            fsyncSync(descriptor);
            closeSync(descriptor);
            descriptor = undefined;
            renameSync(temporary, path);
            syncDirectory(stateDir);
        }
        finally {
            if (descriptor !== undefined)
                closeSync(descriptor);
            rmSync(temporary, { force: true });
        }
    }
    catch (error) {
        publicationError = error;
        publicationFailed = true;
    }
    const released = util.releaseLock(lockPath);
    if (!released.released
        || (released.reason !== 'released' && released.reason !== 'released_with_cleanup_error')) {
        throw new Error(`lifecycle bootstrap readiness lock release failed: ${released.reason}`, {
            cause: publicationFailed
                ? new AggregateError([publicationError, new Error(released.reason)])
                : undefined,
        });
    }
    if (publicationFailed)
        throw publicationError;
}