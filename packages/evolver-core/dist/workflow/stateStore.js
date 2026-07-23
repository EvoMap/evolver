import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { acquireLock, LockTimeoutError, releaseLock } from '../util/fileLock.js';
import { containsWorkflowSensitiveText } from './dsl.js';
export const WORKFLOW_RUN_SCHEMA_VERSION = 4;
export const WORKFLOW_DEFINITION_SCHEMA_VERSION = 1;
const WORKFLOW_CONTROL_SCHEMA_VERSION = 1;
const WORKFLOW_TRANSACTION_SCHEMA_VERSION = 1;
const MAX_OPERATOR_REASON_LENGTH = 500;
export const MAX_WORKFLOW_HISTORY_EVENTS = 4_096;
export const MAX_WORKFLOW_HISTORY_BYTES = 8 * 1024 * 1024;
const WORKFLOW_SAFE_ERROR_CLASSES = new Set([
    'transient', 'permanent', 'safety', 'unknown', 'sensitive_output', 'interrupted_non_idempotent',
    'invalid_control_flow', 'invalid_output', 'approval_rejected', 'resource_limit',
]);
function isWorkflowSafeErrorClass(value) {
    return typeof value === 'string' && WORKFLOW_SAFE_ERROR_CLASSES.has(value);
}
export class WorkflowStateError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'WorkflowStateError';
    }
}
function isStableIdValue(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
function isErrno(error, code) {
    return typeof error === 'object' && error !== null && error.code === code;
}
export function assertStableId(value, label) {
    if (!isStableIdValue(value)) {
        throw new WorkflowStateError(`${label} is not a valid stable identifier`, 'INVALID_ID');
    }
}
function assertNoSymlink(path) {
    try {
        if (lstatSync(path).isSymbolicLink())
            throw new WorkflowStateError(`symlink is not allowed: ${path}`, 'UNSAFE_PATH');
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
    }
}
function assertWithin(root, path) {
    const resolvedRoot = resolve(root);
    const resolvedPath = resolve(path);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
        throw new WorkflowStateError('workflow state path escapes its root', 'UNSAFE_PATH');
    }
}
function ensureOwnerOnlyDirectory(path) {
    assertNoSymlink(path);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    assertNoSymlink(path);
    if (process.platform === 'win32')
        return;
    chmodSync(path, 0o700);
    const stat = statSync(path);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new WorkflowStateError(`workflow state directory is not owned by the current user: ${path}`, 'INSECURE_PERMISSIONS');
    }
    if ((stat.mode & 0o077) !== 0) {
        throw new WorkflowStateError(`workflow state directory is not owner-only: ${path}`, 'INSECURE_PERMISSIONS');
    }
}
function jsonViolation(value, path, ancestors) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return null;
    if (typeof value === 'number')
        return Number.isFinite(value) ? null : path;
    if (typeof value !== 'object')
        return path;
    if (ancestors.has(value))
        return path;
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0)
                return path;
            const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index))
                    return `${path}[${index}]`;
            }
            if (keys.some((key) => typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))
                return path;
            for (let index = 0; index < value.length; index += 1) {
                const violation = jsonViolation(value[index], `${path}[${index}]`, ancestors);
                if (violation)
                    return violation;
            }
            return null;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
            return path;
        if (Object.prototype.hasOwnProperty.call(value, 'toJSON') || Object.getOwnPropertySymbols(value).length > 0)
            return path;
        for (const key of Object.getOwnPropertyNames(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor?.enumerable || descriptor.get || descriptor.set)
                return `${path}.${key}`;
            const violation = jsonViolation(value[key], `${path}.${key}`, ancestors);
            if (violation)
                return violation;
        }
        return null;
    }
    finally {
        ancestors.delete(value);
    }
}
export function findWorkflowJsonViolation(value) {
    return jsonViolation(value, '$', new Set());
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
export function deriveWorkflowDefinitionDigest(spec) {
    const { workflowId: _workflowId, input: _input, ...definition } = spec;
    return createHash('sha256').update(stableJson(definition)).digest('hex');
}
function assertJsonDomain(value, label) {
    const violation = findWorkflowJsonViolation(value);
    if (violation)
        throw new WorkflowStateError(`${label} contains a non-JSON value at ${violation}`, 'CORRUPT_STATE');
}
function sameFileSnapshot(left, right) {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.mode === right.mode
        && left.size === right.size
        && left.mtimeNs === right.mtimeNs
        && left.ctimeNs === right.ctimeNs;
}
function assertOwnerOnlyRegularFile(stat, path) {
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new WorkflowStateError(`workflow state is not a regular file: ${path}`, 'UNSAFE_PATH');
    }
    if (process.platform !== 'win32' && (stat.mode & 63n) !== 0n) {
        throw new WorkflowStateError(`workflow state is not owner-only: ${path}`, 'INSECURE_PERMISSIONS');
    }
}
function assertWithinReadLimit(stat, maxBytes, label) {
    if (maxBytes !== undefined && stat.size > BigInt(maxBytes)) {
        throw new WorkflowStateError(`${label} byte limit exceeded`, 'RESOURCE_LIMIT');
    }
}
function readBoundedFile(fd, maxBytes, expectedBytes, label) {
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, expectedBytes + 1));
    let offset = 0;
    while (offset < buffer.length) {
        const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0)
            break;
        offset += bytesRead;
    }
    if (offset > maxBytes)
        throw new WorkflowStateError(`${label} byte limit exceeded`, 'RESOURCE_LIMIT');
    return buffer.subarray(0, offset).toString('utf8');
}
function readOwnerOnlyFile(path, optional = false, maxBytes, resourceLabel = 'workflow state') {
    let pathBefore;
    try {
        pathBefore = lstatSync(path, { bigint: true });
    }
    catch (error) {
        if (optional && isErrno(error, 'ENOENT'))
            return undefined;
        throw error;
    }
    assertOwnerOnlyRegularFile(pathBefore, path);
    assertWithinReadLimit(pathBefore, maxBytes, resourceLabel);
    const noFollow = constants['O_NOFOLLOW'] ?? 0;
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | noFollow);
    }
    catch (error) {
        if (isErrno(error, 'ENOENT')) {
            throw new WorkflowStateError(`workflow state changed while opening: ${path}`, 'UNSAFE_PATH');
        }
        if (isErrno(error, 'ELOOP') || isErrno(error, 'EMLINK')) {
            throw new WorkflowStateError(`symlink is not allowed: ${path}`, 'UNSAFE_PATH');
        }
        throw error;
    }
    try {
        const openedBefore = fstatSync(fd, { bigint: true });
        assertOwnerOnlyRegularFile(openedBefore, path);
        assertWithinReadLimit(openedBefore, maxBytes, resourceLabel);
        if (!sameFileSnapshot(pathBefore, openedBefore)) {
            throw new WorkflowStateError(`workflow state changed while opening: ${path}`, 'UNSAFE_PATH');
        }
        const raw = maxBytes === undefined
            ? readFileSync(fd, 'utf8')
            : readBoundedFile(fd, maxBytes, Number(openedBefore.size), resourceLabel);
        const openedAfter = fstatSync(fd, { bigint: true });
        let pathAfter;
        try {
            pathAfter = lstatSync(path, { bigint: true });
        }
        catch (error) {
            if (isErrno(error, 'ENOENT')) {
                throw new WorkflowStateError(`workflow state changed while reading: ${path}`, 'UNSAFE_PATH');
            }
            throw error;
        }
        assertOwnerOnlyRegularFile(pathAfter, path);
        if (!sameFileSnapshot(openedBefore, openedAfter) || !sameFileSnapshot(openedAfter, pathAfter)) {
            throw new WorkflowStateError(`workflow state changed while reading: ${path}`, 'UNSAFE_PATH');
        }
        return raw;
    }
    finally {
        closeSync(fd);
    }
}
function parseJsonPayload(raw, path) {
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new WorkflowStateError(`workflow state is corrupt JSON: ${path}`, 'CORRUPT_STATE');
    }
}
function readJsonFile(path) {
    return parseJsonPayload(readOwnerOnlyFile(path), path);
}
function readOptionalJsonFile(path) {
    const raw = readOwnerOnlyFile(path, true);
    return raw === undefined ? undefined : parseJsonPayload(raw, path);
}
function writeJsonAtomic(root, path, value) {
    assertJsonDomain(value, 'workflow state');
    assertNoSymlink(path);
    const temp = join(root, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    assertWithin(root, temp);
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    let fd;
    let pendingError;
    try {
        fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        writeFileSync(fd, payload, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temp, path);
        if (process.platform !== 'win32') {
            chmodSync(path, 0o600);
            const dirFd = openSync(dirname(path), constants.O_RDONLY);
            try {
                fsyncSync(dirFd);
            }
            finally {
                closeSync(dirFd);
            }
        }
    }
    catch (error) {
        pendingError = error;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
        try {
            unlinkSync(temp);
        }
        catch (error) {
            if (!isErrno(error, 'ENOENT') && pendingError === undefined)
                pendingError = error;
        }
    }
    if (pendingError !== undefined)
        throw pendingError;
}
function migrateLegacy(value) {
    const workflowId = value.workflowId ?? `legacy-${value.runId}`;
    const spec = { ...value.spec, workflowId };
    return {
        ...value,
        schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
        workflowSchemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
        workflowId,
        definitionDigest: value.definitionDigest ?? deriveWorkflowDefinitionDigest(spec),
        spec,
    };
}
function parseState(raw, path) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new WorkflowStateError(`workflow state is corrupt JSON: ${path}`, 'CORRUPT_STATE');
    }
    if (typeof parsed !== 'object' || parsed === null) {
        throw new WorkflowStateError(`workflow state is not an object: ${path}`, 'CORRUPT_STATE');
    }
    const version = parsed.schemaVersion;
    if (version !== 1 && version !== 2 && version !== 3 && version !== WORKFLOW_RUN_SCHEMA_VERSION) {
        throw new WorkflowStateError(`unsupported workflow state schema: ${String(version)}`, 'UNSUPPORTED_SCHEMA');
    }
    const state = version === WORKFLOW_RUN_SCHEMA_VERSION
        ? parsed
        : migrateLegacy(parsed);
    assertStableId(state.runId, 'runId');
    assertStableId(state.workflowId, 'workflowId');
    if (state.runId !== basename(path, '.json')) {
        throw new WorkflowStateError(`workflow state runId does not match its file name: ${path}`, 'CORRUPT_STATE');
    }
    if (state.workflowSchemaVersion !== WORKFLOW_DEFINITION_SCHEMA_VERSION
        || typeof state.definitionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(state.definitionDigest)
        || typeof state.workflowName !== 'string'
        || !['queued', 'pending', 'running', 'retry_wait', 'pause_requested', 'paused', 'cancel_requested', 'cancelled', 'waiting_approval', 'succeeded', 'failed', 'unsafe_to_resume'].includes(state.status)
        || (state.lastErrorClass !== undefined && !isWorkflowSafeErrorClass(state.lastErrorClass))
        || !state.spec || typeof state.steps !== 'object' || state.steps === null || !state.context
        || typeof state.context.input !== 'object' || state.context.input === null || Array.isArray(state.context.input)
        || typeof state.context.steps !== 'object' || state.context.steps === null || Array.isArray(state.context.steps)) {
        throw new WorkflowStateError(`workflow state is missing required fields: ${path}`, 'CORRUPT_STATE');
    }
    for (const [executionId, step] of Object.entries(state.steps)) {
        if (!step || step.executionId !== executionId || typeof step.stepId !== 'string'
            || !['script', 'agent', 'approval'].includes(step.kind)
            || !['idempotent', 'non_idempotent'].includes(step.idempotency)
            || !['pending', 'running', 'retry_wait', 'waiting_approval', 'succeeded', 'failed'].includes(step.status)
            || (step.lastErrorClass !== undefined && !isWorkflowSafeErrorClass(step.lastErrorClass))
            || !Number.isInteger(step.attempts) || step.attempts < 0
            || !Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.attempts > step.maxAttempts) {
            throw new WorkflowStateError(`workflow step state is invalid: ${executionId}`, 'CORRUPT_STATE');
        }
    }
    if (state.currentStep !== undefined && !state.steps[state.currentStep]) {
        throw new WorkflowStateError('workflow currentStep does not identify a persisted step', 'CORRUPT_STATE');
    }
    assertJsonDomain(state, 'workflow state');
    return state;
}
function emptyControl() {
    return { schemaVersion: WORKFLOW_CONTROL_SCHEMA_VERSION, approvals: {} };
}
function parseControl(value, path) {
    if (typeof value !== 'object' || value === null) {
        throw new WorkflowStateError(`workflow control is not an object: ${path}`, 'CORRUPT_STATE');
    }
    const control = value;
    if (control.schemaVersion !== WORKFLOW_CONTROL_SCHEMA_VERSION
        || typeof control.approvals !== 'object' || control.approvals === null || Array.isArray(control.approvals)) {
        throw new WorkflowStateError(`workflow control is invalid: ${path}`, 'CORRUPT_STATE');
    }
    assertJsonDomain(control, 'workflow control');
    return control;
}
function validateOperatorOptions(options) {
    assertStableId(options.actor, 'actor');
    if (options.reason === undefined)
        return;
    const hasControlCharacter = [...options.reason].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
    });
    if (options.reason.length > MAX_OPERATOR_REASON_LENGTH || hasControlCharacter || containsWorkflowSensitiveText(options.reason)) {
        throw new WorkflowStateError('operator reason is not safe durable metadata', 'INVALID_TRANSITION');
    }
}
function isTerminal(status) {
    return ['cancelled', 'succeeded', 'failed', 'unsafe_to_resume'].includes(status);
}
function resolveHistoryBound(value, maximum, label) {
    const configured = value ?? maximum;
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > maximum) {
        throw new WorkflowStateError(`${label} must be an integer between 1 and ${maximum}`, 'RESOURCE_LIMIT');
    }
    return configured;
}
function jsonDigest(value) {
    return createHash('sha256').update(transactionStableJson(value)).digest('hex');
}
function transactionStableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(transactionStableJson).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        return `{${Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : (a > b ? 1 : 0)))
            .map(([key, child]) => `${JSON.stringify(key)}:${transactionStableJson(child)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
function deterministicHistoryEventId(input, sequence) {
    return `evt_${jsonDigest({ ...input, sequence })}`;
}
function isDigest(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function isHistoryEventId(value) {
    return typeof value === 'string'
        && /^evt_(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(value);
}
const HISTORY_EVENT_TYPES = new Set([
    'run_created', 'run_queued', 'run_started', 'run_succeeded', 'run_failed',
    'step_started', 'step_retry_scheduled', 'step_succeeded', 'step_failed',
    'pause_requested', 'paused', 'resume_requested', 'cancel_requested', 'cancelled',
    'approval_waiting', 'approval_approved', 'approval_rejected', 'recovery_started', 'unsafe_to_resume',
]);
const RUN_STATUSES = new Set([
    'queued', 'pending', 'running', 'retry_wait', 'pause_requested', 'paused', 'cancel_requested', 'cancelled',
    'waiting_approval', 'succeeded', 'failed', 'unsafe_to_resume',
]);
function validateHistory(value, runId, expectedWorkflowId, maxHistoryEvents, maxHistoryBytes, path) {
    if (!Array.isArray(value))
        throw new WorkflowStateError(`workflow history is invalid: ${path}`, 'CORRUPT_STATE');
    if (value.length > maxHistoryEvents) {
        throw new WorkflowStateError('workflow history event limit exceeded', 'RESOURCE_LIMIT');
    }
    assertJsonDomain(value, 'workflow history');
    const serializedBytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (serializedBytes > maxHistoryBytes) {
        throw new WorkflowStateError('workflow history byte limit exceeded', 'RESOURCE_LIMIT');
    }
    const eventIds = new Set();
    let workflowId = expectedWorkflowId;
    for (let index = 0; index < value.length; index += 1) {
        const candidate = value[index];
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
            throw new WorkflowStateError(`workflow history event is invalid at sequence ${index + 1}`, 'CORRUPT_STATE');
        }
        const event = candidate;
        if (event.sequence !== index + 1 || !Number.isSafeInteger(event.sequence)
            || !isHistoryEventId(event.eventId) || eventIds.has(event.eventId)
            || event.runId !== runId || !HISTORY_EVENT_TYPES.has(event.type) || !RUN_STATUSES.has(event.status)
            || (event.errorClass !== undefined && !isWorkflowSafeErrorClass(event.errorClass))
            || typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at))) {
            throw new WorkflowStateError(`workflow history event is invalid at sequence ${index + 1}`, 'CORRUPT_STATE');
        }
        if (!isStableIdValue(event.runId) || !isStableIdValue(event.workflowId)) {
            throw new WorkflowStateError(`workflow history identity is invalid at sequence ${index + 1}`, 'CORRUPT_STATE');
        }
        workflowId ??= event.workflowId;
        if (event.workflowId !== workflowId) {
            throw new WorkflowStateError('workflow history identity is inconsistent', 'CORRUPT_STATE');
        }
        if (event.executionId !== undefined
            && (typeof event.executionId !== 'string' || !/^[A-Za-z0-9._:/[\]-]{1,4096}$/.test(event.executionId))) {
            throw new WorkflowStateError(`workflow history executionId is invalid at sequence ${index + 1}`, 'CORRUPT_STATE');
        }
        for (const id of [event.stepId, event.gateId, event.actor]) {
            if (id !== undefined && !isStableIdValue(id)) {
                throw new WorkflowStateError(`workflow history metadata is invalid at sequence ${index + 1}`, 'CORRUPT_STATE');
            }
        }
        if (event.at !== new Date(event.at).toISOString()
            || (event.attempt !== undefined && (!Number.isSafeInteger(event.attempt) || event.attempt < 1))
            || (event.reason !== undefined && typeof event.reason !== 'string')) {
            throw new WorkflowStateError(`workflow history event metadata is invalid at sequence ${index + 1}`, 'CORRUPT_STATE');
        }
        if (/^evt_[a-f0-9]{64}$/.test(event.eventId)) {
            const { sequence, eventId: _eventId, ...input } = event;
            if (event.eventId !== deterministicHistoryEventId(input, sequence)) {
                throw new WorkflowStateError(`workflow history event digest is invalid at sequence ${index + 1}`, 'CORRUPT_STATE');
            }
        }
        eventIds.add(event.eventId);
    }
    return value;
}
function unlinkDurable(path) {
    assertNoSymlink(path);
    try {
        unlinkSync(path);
    }
    catch (error) {
        if (!isErrno(error, 'ENOENT'))
            throw error;
        return;
    }
    if (process.platform !== 'win32') {
        const dirFd = openSync(dirname(path), constants.O_RDONLY);
        try {
            fsyncSync(dirFd);
        }
        finally {
            closeSync(dirFd);
        }
    }
}
export class WorkflowStateStore {
    options;
    root;
    maxHistoryEvents;
    maxHistoryBytes;
    constructor(root, options = {}) {
        this.options = options;
        this.root = resolve(root);
        this.maxHistoryEvents = resolveHistoryBound(options.maxHistoryEvents, MAX_WORKFLOW_HISTORY_EVENTS, 'maxHistoryEvents');
        this.maxHistoryBytes = resolveHistoryBound(options.maxHistoryBytes, MAX_WORKFLOW_HISTORY_BYTES, 'maxHistoryBytes');
    }
    ensureConcurrencyLimit(limit) {
        ensureOwnerOnlyDirectory(this.root);
        const configPath = join(this.root, '.concurrency.json');
        const lockPath = join(this.root, '.concurrency-config.lock');
        assertWithin(this.root, configPath);
        assertWithin(this.root, lockPath);
        assertNoSymlink(configPath);
        assertNoSymlink(lockPath);
        acquireLock(lockPath, this.options.lock);
        try {
            if (!existsSync(configPath)) {
                writeJsonAtomic(this.root, configPath, { schemaVersion: 1, maxConcurrentRuns: limit });
                return limit;
            }
            const value = readJsonFile(configPath);
            if (typeof value !== 'object' || value === null
                || value.schemaVersion !== 1
                || !Number.isSafeInteger(value.maxConcurrentRuns)) {
                throw new WorkflowStateError('workflow concurrency configuration is invalid', 'CORRUPT_STATE');
            }
            return value.maxConcurrentRuns;
        }
        finally {
            releaseLock(lockPath);
        }
    }
    tryAcquireConcurrencySlot(limit) {
        ensureOwnerOnlyDirectory(this.root);
        for (let slot = 0; slot < limit; slot += 1) {
            const path = this.concurrencySlotPath(slot);
            assertNoSymlink(path);
            try {
                acquireLock(path, { maxTries: 1, waitMs: 0 });
                assertNoSymlink(path);
                return slot;
            }
            catch (error) {
                if (!(error instanceof LockTimeoutError))
                    throw error;
            }
        }
        return null;
    }
    releaseConcurrencySlot(slot) {
        releaseLock(this.concurrencySlotPath(slot));
    }
    concurrencySlotPath(slot) {
        if (!Number.isSafeInteger(slot) || slot < 0) {
            throw new WorkflowStateError('workflow concurrency slot is invalid', 'CORRUPT_STATE');
        }
        const path = join(this.root, `.concurrency-slot-${slot}.lock`);
        assertWithin(this.root, path);
        return path;
    }
    statePath(runId) {
        assertStableId(runId, 'runId');
        const path = join(this.root, `${runId}.json`);
        assertWithin(this.root, path);
        return path;
    }
    controlPath(runId) {
        assertStableId(runId, 'runId');
        return join(this.root, `${runId}.control.json`);
    }
    historyPath(runId) {
        assertStableId(runId, 'runId');
        return join(this.root, `${runId}.history.json`);
    }
    commitLockPath(runId) {
        assertStableId(runId, 'runId');
        const path = join(this.root, `${runId}.commit.lock`);
        assertWithin(this.root, path);
        return path;
    }
    legacyControlLockPath(runId) {
        assertStableId(runId, 'runId');
        const path = join(this.root, `${runId}.control.lock`);
        assertWithin(this.root, path);
        return path;
    }
    legacyHistoryLockPath(runId) {
        assertStableId(runId, 'runId');
        const path = join(this.root, `${runId}.history.lock`);
        assertWithin(this.root, path);
        return path;
    }
    transactionPath(runId) {
        assertStableId(runId, 'runId');
        const path = join(this.root, `${runId}.transaction.wal`);
        assertWithin(this.root, path);
        return path;
    }
    lockPath(runId) {
        assertStableId(runId, 'runId');
        return join(this.root, `${runId}.lock`);
    }
    withRunLock(runId, fn) {
        this.acquireRunLock(runId);
        try {
            return fn();
        }
        finally {
            this.releaseRunLock(runId);
        }
    }
    acquireRunLock(runId) {
        ensureOwnerOnlyDirectory(this.root);
        const lockPath = this.lockPath(runId);
        assertWithin(this.root, lockPath);
        assertNoSymlink(lockPath);
        acquireLock(lockPath, this.options.lock);
        assertNoSymlink(lockPath);
    }
    releaseRunLock(runId) {
        releaseLock(this.lockPath(runId));
    }
    readStored(runId) {
        ensureOwnerOnlyDirectory(this.root);
        return this.withCommitLock(runId, () => {
            this.replayTransactionUnlocked(runId);
            return this.readStoredUnlocked(runId);
        });
    }
    readStoredUnlocked(runId) {
        const path = this.statePath(runId);
        const raw = readOwnerOnlyFile(path, true);
        if (raw === undefined)
            throw new WorkflowStateError(`workflow run not found: ${runId}`, 'STATE_NOT_FOUND');
        return parseState(raw, path);
    }
    readOptionalStoredUnlocked(runId) {
        const path = this.statePath(runId);
        const raw = readOwnerOnlyFile(path, true);
        return raw === undefined ? undefined : parseState(raw, path);
    }
    read(runId) {
        ensureOwnerOnlyDirectory(this.root);
        return this.withCommitLock(runId, () => {
            this.replayTransactionUnlocked(runId);
            const state = this.readStoredUnlocked(runId);
            if (isTerminal(state.status))
                return state;
            const control = this.readControlUnlocked(runId);
            if (control.cancel)
                return { ...state, status: 'cancel_requested' };
            if (control.pause && state.status !== 'paused' && state.status !== 'waiting_approval') {
                return { ...state, status: 'pause_requested' };
            }
            return state;
        });
    }
    listRunIds() {
        ensureOwnerOnlyDirectory(this.root);
        const names = readdirSync(this.root);
        const pending = names
            .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.transaction\.wal$/.test(name))
            .map((name) => name.slice(0, -'.transaction.wal'.length));
        const stored = names
            .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(name))
            .filter((name) => !name.endsWith('.control.json') && !name.endsWith('.history.json'))
            .map((name) => name.slice(0, -'.json'.length));
        return [...new Set([...stored, ...pending])].sort();
    }
    list() {
        return this.listRunIds().map((runId) => this.read(runId));
    }
    write(state) {
        this.commit(state);
    }
    commit(state, history = [], controlPatch = {}) {
        const changesControl = Object.prototype.hasOwnProperty.call(controlPatch, 'pause')
            || Object.prototype.hasOwnProperty.call(controlPatch, 'cancel');
        return this.transactSelected(state.runId, changesControl, history.length > 0, (snapshot) => ({
            state,
            history,
            ...(changesControl
                ? { control: this.patchControl(snapshot.control, controlPatch) }
                : {}),
        }));
    }
    /** Commit a completion only when no durable cancellation won the commit-lock race. */
    commitUnlessCancelled(state, history = []) {
        let cancellation;
        this.transactSelected(state.runId, true, history.length > 0, (snapshot) => {
            cancellation = snapshot.control.cancel;
            return cancellation ? {} : { state, history };
        });
        return cancellation;
    }
    /** Last-resort state/control projection when bounded or corrupt history prevents a safety transition. */
    commitSafetyState(state, controlPatch = {}) {
        this.transactSelected(state.runId, true, false, (snapshot) => ({
            state,
            control: this.patchControl(snapshot.control, controlPatch),
        }));
    }
    readControl(runId) {
        ensureOwnerOnlyDirectory(this.root);
        return this.withCommitLock(runId, () => {
            this.replayTransactionUnlocked(runId);
            this.readStoredUnlocked(runId);
            return this.readControlUnlocked(runId);
        });
    }
    readControlUnlocked(runId) {
        const path = this.controlPath(runId);
        const value = readOptionalJsonFile(path);
        return value === undefined ? emptyControl() : parseControl(value, path);
    }
    requestPause(runId, options, requestedAt = new Date().toISOString()) {
        validateOperatorOptions(options);
        const request = { ...options, requestedAt };
        this.requestControlOnly(runId, { pause: request }, 'pause_requested');
    }
    requestPauseWithHistory(runId, options, requestedAt = new Date().toISOString()) {
        validateOperatorOptions(options);
        const request = { ...options, requestedAt };
        this.requestControl(runId, { pause: request }, 'pause_requested', options, requestedAt);
    }
    clearPauseRequest(runId) {
        this.transactSelected(runId, true, false, ({ state, control }) => {
            if (!state)
                throw new WorkflowStateError(`workflow run not found: ${runId}`, 'STATE_NOT_FOUND');
            return { control: this.patchControl(control, { pause: null }) };
        });
    }
    requestCancel(runId, options, requestedAt = new Date().toISOString()) {
        validateOperatorOptions(options);
        const request = { ...options, requestedAt };
        this.requestControlOnly(runId, { cancel: request }, 'cancel_requested');
    }
    requestCancelWithHistory(runId, options, requestedAt = new Date().toISOString()) {
        validateOperatorOptions(options);
        const request = { ...options, requestedAt };
        this.requestControl(runId, { cancel: request }, 'cancel_requested', options, requestedAt);
    }
    clearCancelRequest(runId) {
        this.transactSelected(runId, true, false, ({ state, control }) => {
            if (!state)
                throw new WorkflowStateError(`workflow run not found: ${runId}`, 'STATE_NOT_FOUND');
            return { control: this.patchControl(control, { cancel: null }) };
        });
    }
    approve(runId, gateId, options, requestedAt = new Date().toISOString()) {
        this.decideApproval(runId, gateId, 'approved', options, requestedAt);
    }
    reject(runId, gateId, options, requestedAt = new Date().toISOString()) {
        this.decideApproval(runId, gateId, 'rejected', options, requestedAt);
    }
    decideApproval(runId, gateId, decision, options, requestedAt) {
        assertStableId(gateId, 'gateId');
        validateOperatorOptions(options);
        this.transactSelected(runId, true, false, ({ state, control }) => {
            if (!state)
                throw new WorkflowStateError(`workflow run not found: ${runId}`, 'STATE_NOT_FOUND');
            if (state.status !== 'waiting_approval' || state.approval?.gateId !== gateId) {
                throw new WorkflowStateError('workflow run is not waiting at the requested approval gate', 'INVALID_TRANSITION');
            }
            const next = { ...control, approvals: { ...control.approvals } };
            next.approvals[state.approval.executionId] = {
                gateId,
                executionId: state.approval.executionId,
                decision,
                ...options,
                requestedAt,
            };
            return { control: next };
        });
    }
    appendHistory(input) {
        assertStableId(input.runId, 'runId');
        assertStableId(input.workflowId, 'workflowId');
        const [event] = this.transactSelected(input.runId, false, true, () => ({ history: [input] }));
        if (!event)
            throw new WorkflowStateError('workflow history transaction produced no event', 'CORRUPT_STATE');
        return event;
    }
    readHistory(runId) {
        ensureOwnerOnlyDirectory(this.root);
        return this.withCommitLock(runId, () => {
            this.replayTransactionUnlocked(runId);
            const state = this.readStoredUnlocked(runId);
            return this.readHistoryUnlocked(runId, state.workflowId);
        });
    }
    history(runId) {
        return this.readHistory(runId);
    }
    readHistoryUnlocked(runId, workflowId) {
        const path = this.historyPath(runId);
        const raw = readOwnerOnlyFile(path, true, this.maxHistoryBytes, 'workflow history');
        if (raw === undefined)
            return [];
        if (Buffer.byteLength(raw, 'utf8') > this.maxHistoryBytes) {
            throw new WorkflowStateError('workflow history byte limit exceeded', 'RESOURCE_LIMIT');
        }
        return validateHistory(parseJsonPayload(raw, path), runId, workflowId, this.maxHistoryEvents, this.maxHistoryBytes, path);
    }
    transact(runId, prepare) {
        return this.transactSelected(runId, true, true, prepare);
    }
    transactSelected(runId, includeControl, includeHistory, prepare) {
        ensureOwnerOnlyDirectory(this.root);
        assertStableId(runId, 'runId');
        return this.withCommitLock(runId, () => {
            this.replayTransactionUnlocked(runId);
            const state = this.readOptionalStoredUnlocked(runId);
            const control = includeControl ? this.readControlUnlocked(runId) : emptyControl();
            const history = includeHistory ? this.readHistoryUnlocked(runId, state?.workflowId) : [];
            return this.persistTransactionUnlocked(runId, { state, control, history }, prepare({ state, control, history }));
        });
    }
    requestControl(runId, patch, type, options, requestedAt) {
        const prepare = ({ state, control }) => {
            if (!state)
                throw new WorkflowStateError(`workflow run not found: ${runId}`, 'STATE_NOT_FOUND');
            if (isTerminal(state.status)) {
                throw new WorkflowStateError(type === 'pause_requested' ? 'terminal workflow runs cannot be paused' : 'terminal workflow runs cannot be cancelled', 'INVALID_TRANSITION');
            }
            return {
                control: this.patchControl(control, patch),
                history: [{
                        runId, workflowId: state.workflowId, type, status: type, at: requestedAt, ...options,
                    }],
            };
        };
        try {
            this.transact(runId, prepare);
        }
        catch (error) {
            if (!(error instanceof WorkflowStateError)
                || !['RESOURCE_LIMIT', 'CORRUPT_STATE', 'UNSAFE_PATH', 'INSECURE_PERMISSIONS'].includes(error.code))
                throw error;
            this.transactSelected(runId, true, false, ({ state, control }) => {
                const update = prepare({ state, control, history: [] });
                return { control: update.control };
            });
        }
    }
    requestControlOnly(runId, patch, type) {
        this.transactSelected(runId, true, false, ({ state, control }) => {
            if (!state)
                throw new WorkflowStateError(`workflow run not found: ${runId}`, 'STATE_NOT_FOUND');
            if (isTerminal(state.status)) {
                throw new WorkflowStateError(type === 'pause_requested' ? 'terminal workflow runs cannot be paused' : 'terminal workflow runs cannot be cancelled', 'INVALID_TRANSITION');
            }
            return { control: this.patchControl(control, patch) };
        });
    }
    persistTransactionUnlocked(runId, snapshot, update) {
        if (update.state) {
            if (update.state.runId !== runId)
                throw new WorkflowStateError('workflow transaction run identity changed', 'CORRUPT_STATE');
            parseState(`${JSON.stringify(update.state)}\n`, this.statePath(runId));
        }
        if (update.control)
            parseControl(update.control, this.controlPath(runId));
        const workflowId = update.state?.workflowId
            ?? snapshot.state?.workflowId
            ?? snapshot.history[0]?.workflowId
            ?? update.history?.[0]?.workflowId;
        if (!workflowId)
            throw new WorkflowStateError('workflow transaction has no workflow identity', 'CORRUPT_STATE');
        assertStableId(workflowId, 'workflowId');
        if (snapshot.state && snapshot.state.workflowId !== workflowId) {
            throw new WorkflowStateError('workflow transaction state identity changed', 'CORRUPT_STATE');
        }
        const appended = (update.history ?? []).map((input, index) => {
            if (input.runId !== runId || input.workflowId !== workflowId) {
                throw new WorkflowStateError('workflow transaction history identity changed', 'CORRUPT_STATE');
            }
            const sequence = snapshot.history.length + index + 1;
            return { ...input, sequence, eventId: deterministicHistoryEventId(input, sequence) };
        });
        const nextHistory = [...snapshot.history, ...appended];
        if (appended.length > 0) {
            validateHistory(nextHistory, runId, workflowId, this.maxHistoryEvents, this.maxHistoryBytes, this.historyPath(runId));
        }
        const unsigned = {
            schemaVersion: WORKFLOW_TRANSACTION_SCHEMA_VERSION,
            runId,
            workflowId,
            stateBeforeDigest: jsonDigest(snapshot.state ?? null),
            ...(update.state && jsonDigest(update.state) !== jsonDigest(snapshot.state ?? null)
                ? { state: { beforeDigest: jsonDigest(snapshot.state ?? null), value: update.state } }
                : {}),
            ...(update.control && jsonDigest(update.control) !== jsonDigest(snapshot.control)
                ? { control: { beforeDigest: jsonDigest(snapshot.control), value: update.control } }
                : {}),
            ...(appended.length > 0
                ? { history: { beforeDigest: jsonDigest(snapshot.history), value: nextHistory } }
                : {}),
        };
        if (!unsigned.state && !unsigned.control && !unsigned.history)
            return appended;
        const record = {
            ...unsigned,
            transactionId: `txn_${jsonDigest(unsigned)}`,
        };
        const path = this.transactionPath(runId);
        if (existsSync(path))
            throw new WorkflowStateError('workflow transaction WAL was not replayed', 'CORRUPT_STATE');
        writeJsonAtomic(this.root, path, record);
        this.notifyTransactionPhase(record, 'commit', 'wal_persisted');
        this.applyTransactionUnlocked(record, 'commit');
        return appended;
    }
    replayTransactionUnlocked(runId) {
        const record = this.readTransactionUnlocked(runId, true);
        if (record)
            this.applyTransactionUnlocked(record, 'replay');
    }
    readTransactionUnlocked(runId, optional = false) {
        const path = this.transactionPath(runId);
        const value = optional ? readOptionalJsonFile(path) : readJsonFile(path);
        if (value === undefined)
            return undefined;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new WorkflowStateError('workflow transaction WAL is invalid', 'CORRUPT_STATE');
        }
        const version = value.schemaVersion;
        if (version !== WORKFLOW_TRANSACTION_SCHEMA_VERSION) {
            throw new WorkflowStateError(`unsupported workflow transaction schema: ${String(version)}`, 'UNSUPPORTED_SCHEMA');
        }
        const record = value;
        if (record.runId !== runId || typeof record.transactionId !== 'string'
            || !/^txn_[a-f0-9]{64}$/.test(record.transactionId)
            || typeof record.workflowId !== 'string' || !isDigest(record.stateBeforeDigest)
            || (!record.state && !record.control && !record.history)) {
            throw new WorkflowStateError('workflow transaction WAL is invalid', 'CORRUPT_STATE');
        }
        assertStableId(record.runId, 'runId');
        assertStableId(record.workflowId, 'workflowId');
        for (const projection of [record.state, record.control, record.history]) {
            if (projection && (!isDigest(projection.beforeDigest) || !Object.prototype.hasOwnProperty.call(projection, 'value'))) {
                throw new WorkflowStateError('workflow transaction projection is invalid', 'CORRUPT_STATE');
            }
        }
        if (record.state) {
            const state = parseState(`${JSON.stringify(record.state.value)}\n`, this.statePath(runId));
            if (state.workflowId !== record.workflowId) {
                throw new WorkflowStateError('workflow transaction state identity is invalid', 'CORRUPT_STATE');
            }
        }
        if (record.control)
            parseControl(record.control.value, this.controlPath(runId));
        if (record.history) {
            validateHistory(record.history.value, runId, record.workflowId, this.maxHistoryEvents, this.maxHistoryBytes, this.historyPath(runId));
        }
        const { transactionId: _transactionId, ...unsigned } = record;
        if (record.transactionId !== `txn_${jsonDigest(unsigned)}`) {
            throw new WorkflowStateError('workflow transaction WAL digest is invalid', 'CORRUPT_STATE');
        }
        return record;
    }
    applyTransactionUnlocked(record, mode) {
        const stateBeforeProjection = this.readOptionalStoredUnlocked(record.runId);
        if (!record.state && jsonDigest(stateBeforeProjection ?? null) !== record.stateBeforeDigest) {
            throw new WorkflowStateError('workflow transaction state precondition diverged', 'CORRUPT_STATE');
        }
        if (record.state) {
            this.assertProjectionBase(stateBeforeProjection ?? null, record.state, 'state');
            if (jsonDigest(stateBeforeProjection ?? null) !== jsonDigest(record.state.value)) {
                writeJsonAtomic(this.root, this.statePath(record.runId), record.state.value);
            }
            this.notifyTransactionPhase(record, mode, 'state_projected');
        }
        if (record.control) {
            const current = this.readControlUnlocked(record.runId);
            this.assertProjectionBase(current, record.control, 'control');
            if (jsonDigest(current) !== jsonDigest(record.control.value)) {
                writeJsonAtomic(this.root, this.controlPath(record.runId), record.control.value);
            }
            this.notifyTransactionPhase(record, mode, 'control_projected');
        }
        if (record.history) {
            const current = this.readHistoryUnlocked(record.runId, record.workflowId);
            this.assertProjectionBase(current, record.history, 'history');
            if (jsonDigest(current) !== jsonDigest(record.history.value)) {
                writeJsonAtomic(this.root, this.historyPath(record.runId), record.history.value);
            }
            this.notifyTransactionPhase(record, mode, 'history_projected');
        }
        this.notifyTransactionPhase(record, mode, 'before_wal_clear');
        unlinkDurable(this.transactionPath(record.runId));
    }
    assertProjectionBase(current, projection, label) {
        const currentDigest = jsonDigest(current);
        if (currentDigest !== projection.beforeDigest && currentDigest !== jsonDigest(projection.value)) {
            throw new WorkflowStateError(`workflow transaction ${label} projection diverged`, 'CORRUPT_STATE');
        }
    }
    notifyTransactionPhase(record, mode, phase) {
        this.options.onTransactionPhase?.({ runId: record.runId, transactionId: record.transactionId, mode, phase });
    }
    patchControl(control, patch) {
        const next = { ...control, approvals: { ...control.approvals } };
        if (Object.prototype.hasOwnProperty.call(patch, 'pause')) {
            if (patch.pause === null || patch.pause === undefined)
                delete next.pause;
            else
                next.pause = patch.pause;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'cancel')) {
            if (patch.cancel === null || patch.cancel === undefined)
                delete next.cancel;
            else
                next.cancel = patch.cancel;
        }
        return next;
    }
    withCommitLock(runId, fn) {
        assertStableId(runId, 'runId');
        // Legacy binaries lock control and history independently. Keep this order stable so mixed-version
        // processes serialize both projections before the WAL-wide commit lock is acquired.
        const lockPaths = [
            this.legacyControlLockPath(runId),
            this.legacyHistoryLockPath(runId),
            this.commitLockPath(runId),
        ];
        const acquired = [];
        try {
            for (const lockPath of lockPaths) {
                assertNoSymlink(lockPath);
                acquireLock(lockPath, this.options.lock);
                acquired.push(lockPath);
                assertNoSymlink(lockPath);
            }
            return fn();
        }
        finally {
            for (const lockPath of acquired.reverse())
                releaseLock(lockPath);
        }
    }
}