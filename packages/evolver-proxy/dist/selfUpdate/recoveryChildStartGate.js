import { randomUUID } from 'node:crypto';
import { closeSync, createReadStream } from 'node:fs';
import { Socket } from 'node:net';
import { util } from '@evomap/evolver-core';
export const RECOVERY_CHILD_START_GATE_ENV = 'EVOLVER_INTERNAL_RECOVERY_CHILD_START_GATE';
const RECOVERY_CHILD_START_GATE_DESCRIPTOR = 4;
export const DEFAULT_RECOVERY_CHILD_START_GATE_TIMEOUT_MS = 120_000;
const MAX_RECOVERY_CHILD_START_GATE_CAPABILITY_BYTES = 1024;
const MAX_RECOVERY_CHILD_START_GATE_SIGNAL_BYTES = 128;
const BUN_READER_CANCEL_TIMEOUT_MS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Bind a one-shot child start gate to this exact parent PID generation.
 * The token travels in both the environment capability and a private fd4 pipe;
 * neither input is sufficient on its own.
 */
export function prepareRecoveryChildStartGate(env, role, expectedParent) {
    if (expectedParent?.pid !== undefined && expectedParent.pid !== process.pid) {
        throw new Error('self_update_recovery_child_start_gate_parent_invalid');
    }
    const processStartIdentity = util.readFileLockProcessStartIdentity(process.pid);
    if (!processStartIdentity
        || (expectedParent
            && !util.sameFileLockProcessStartIdentity(expectedParent.processStartIdentity, processStartIdentity))) {
        throw new Error('self_update_recovery_child_start_gate_parent_invalid');
    }
    const startupGateToken = randomUUID();
    const capability = {
        v: 1,
        role,
        pid: process.pid,
        processStartIdentity,
        token: startupGateToken,
    };
    return {
        env: {
            ...env,
            [RECOVERY_CHILD_START_GATE_ENV]: JSON.stringify(capability),
        },
        startupGateToken,
    };
}
function clearRecoveryChildStartGate(env) {
    delete env[RECOVERY_CHILD_START_GATE_ENV];
}
/**
 * Consume the gate before controller/worker dispatch or durable recovery.
 * Invalid capability, wrong role/parent generation, EOF, malformed input and
 * timeout all fail closed. The inherited capability is scrubbed on every path.
 */
export async function consumeRecoveryChildStartGate(env, expectedRole, options = {}) {
    const raw = env[RECOVERY_CHILD_START_GATE_ENV];
    if (raw === undefined)
        return false;
    const descriptor = options.descriptor ?? RECOVERY_CHILD_START_GATE_DESCRIPTOR;
    try {
        const capability = parseRecoveryChildStartGateCapability(raw, expectedRole, options.parentPid ?? process.ppid, options.inspectParentProcess ?? util.inspectFileLockOwnerProcess);
        if (!capability) {
            await closeDescriptorBestEffort(descriptor);
            throw new Error('self_update_recovery_child_start_gate_invalid');
        }
        const accepted = await readExactGateToken(descriptor, capability.token, positiveTimeout(options.timeoutMs));
        if (!accepted) {
            throw new Error('self_update_recovery_child_start_gate_rejected');
        }
        return true;
    }
    finally {
        clearRecoveryChildStartGate(env);
    }
}
/** Deliver fd4 only after the caller establishes its owned guardian or delegated authority. */
export function deliverRecoveryChildStartGate(child, token, timeoutMs = DEFAULT_RECOVERY_CHILD_START_GATE_TIMEOUT_MS) {
    if (!UUID_PATTERN.test(token))
        return Promise.resolve(false);
    const stream = child.stdio[RECOVERY_CHILD_START_GATE_DESCRIPTOR];
    const writable = stream;
    if (!writable
        || typeof writable.on !== 'function'
        || typeof writable.once !== 'function'
        || typeof writable.off !== 'function'
        || typeof writable.end !== 'function'
        || typeof writable.destroy !== 'function') {
        return Promise.resolve(false);
    }
    const gate = writable;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (accepted) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            gate.off('finish', onFinish);
            gate.off('error', onError);
            gate.off('close', onClose);
            resolve(accepted);
        };
        const onFinish = () => { finish(true); };
        const onError = () => { finish(false); };
        const onClose = () => { finish(false); };
        const timer = setTimeout(() => {
            try {
                gate.destroy();
            }
            catch {
                // The bounded false result remains authoritative.
            }
            finish(false);
        }, positiveTimeout(timeoutMs));
        gate.once('finish', onFinish);
        gate.once('error', onError);
        gate.once('close', onClose);
        gate.end(`${token}\n`);
    });
}
function parseRecoveryChildStartGateCapability(raw, expectedRole, parentPid, inspectParentProcess) {
    if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_RECOVERY_CHILD_START_GATE_CAPABILITY_BYTES) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const record = parsed;
        const keys = Object.keys(record).sort();
        if (keys.length !== 5
            || keys[0] !== 'pid'
            || keys[1] !== 'processStartIdentity'
            || keys[2] !== 'role'
            || keys[3] !== 'token'
            || keys[4] !== 'v'
            || record['v'] !== 1
            || (record['role'] !== 'proxy-target' && record['role'] !== 'windows-updater')
            || record['role'] !== expectedRole
            || !Number.isSafeInteger(record['pid'])
            || record['pid'] !== parentPid
            || typeof record['token'] !== 'string'
            || !UUID_PATTERN.test(record['token'])) {
            return undefined;
        }
        const processStartIdentity = util.parseFileLockProcessStartIdentity(record['processStartIdentity']);
        if (!processStartIdentity)
            return undefined;
        const capability = {
            v: 1,
            role: record['role'],
            pid: record['pid'],
            processStartIdentity,
            token: record['token'],
        };
        if (inspectParentProcess(capability) !== 'current')
            return undefined;
        return capability;
    }
    catch {
        return undefined;
    }
}
function readExactGateToken(descriptor, token, timeoutMs) {
    if (typeof process.versions['bun'] === 'string') {
        const bun = activeBunFileRuntime();
        if (!bun)
            return Promise.resolve(false);
        return readExactGateTokenFromBunFile(bun, descriptor, token, timeoutMs);
    }
    const expected = Buffer.from(`${token}\n`, 'utf8');
    return new Promise((resolve) => {
        let raw = Buffer.alloc(0);
        let settled = false;
        let stream;
        try {
            // Node's libuv pipe socket can cancel an outstanding silent read on
            // destroy; fs.ReadStream leaves that read live on Windows after timeout.
            stream = new Socket({ fd: descriptor, readable: true, writable: false });
        }
        catch {
            // Regular-file descriptors are useful for deterministic parser tests;
            // Node production fd4 is always the cancellable pipe path above.
            stream = createReadStream('', { fd: descriptor, autoClose: true });
        }
        const finish = (accepted) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            stream.off('data', onData);
            stream.off('end', onEnd);
            stream.off('error', onError);
            stream.off('close', onClose);
            if (!stream.destroyed)
                stream.destroy();
            resolve(accepted);
        };
        const onData = (chunk) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
            if (bytes.byteLength > MAX_RECOVERY_CHILD_START_GATE_SIGNAL_BYTES - raw.byteLength) {
                finish(false);
                return;
            }
            raw = Buffer.concat([raw, bytes], raw.byteLength + bytes.byteLength);
            if (!raw.equals(expected.subarray(0, raw.byteLength))) {
                finish(false);
            }
        };
        const onEnd = () => { finish(raw.equals(expected)); };
        const onError = () => { finish(false); };
        const onClose = () => { finish(false); };
        const timer = setTimeout(() => { finish(false); }, timeoutMs);
        stream.on('data', onData);
        stream.once('end', onEnd);
        stream.once('error', onError);
        stream.once('close', onClose);
    });
}
async function readExactGateTokenFromBunFile(bun, descriptor, token, timeoutMs) {
    const expected = Buffer.from(`${token}\n`, 'utf8');
    let reader;
    try {
        // Bun's net.Socket accepts an inherited Windows pipe descriptor but never
        // observes its data or EOF. Bun.file(fd).stream() owns that pipe correctly
        // and its reader cancellation also releases a silent outstanding read.
        reader = bun.file(descriptor).stream().getReader();
    }
    catch {
        return false;
    }
    const timedOut = Symbol('recovery-child-start-gate-timeout');
    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => { resolve(timedOut); }, timeoutMs);
    });
    let raw = Buffer.alloc(0);
    let completed = false;
    try {
        for (;;) {
            const result = await Promise.race([
                reader.read().catch(() => undefined),
                timeout,
            ]);
            if (result === timedOut || result === undefined)
                return false;
            if (result.done) {
                completed = true;
                return raw.equals(expected);
            }
            const bytes = Buffer.from(result.value);
            if (bytes.byteLength > MAX_RECOVERY_CHILD_START_GATE_SIGNAL_BYTES - raw.byteLength) {
                return false;
            }
            raw = Buffer.concat([raw, bytes], raw.byteLength + bytes.byteLength);
            if (!raw.equals(expected.subarray(0, raw.byteLength)))
                return false;
        }
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        if (!completed) {
            try {
                await cancelBunReaderBestEffort(reader);
            }
            catch {
                // Rejection remains authoritative after cancellation was attempted.
            }
        }
    }
}
function activeBunFileRuntime() {
    const bun = globalThis.Bun;
    return bun && typeof bun.file === 'function'
        ? bun
        : undefined;
}
async function cancelBunReaderBestEffort(reader) {
    await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, BUN_READER_CANCEL_TIMEOUT_MS);
        try {
            void reader.cancel('self_update_recovery_child_start_gate_closed').then(finish, finish);
        }
        catch {
            finish();
        }
    });
}
async function closeDescriptorBestEffort(descriptor) {
    if (typeof process.versions['bun'] === 'string') {
        const bun = activeBunFileRuntime();
        if (!bun)
            return;
        try {
            const reader = bun.file(descriptor).stream().getReader();
            await cancelBunReaderBestEffort(reader);
        }
        catch {
            // The invalid capability remains authoritative.
        }
        return;
    }
    try {
        closeSync(descriptor);
    }
    catch {
        // The capability rejection remains authoritative.
    }
}
function positiveTimeout(value) {
    return Number.isFinite(value) && (value ?? 0) > 0
        ? Math.floor(value)
        : DEFAULT_RECOVERY_CHILD_START_GATE_TIMEOUT_MS;
}