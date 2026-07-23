import { homedir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { containsWorkflowSensitiveText, CORE_WHITELIST, isRef, } from './dsl.js';
import { assertStableId, deriveWorkflowDefinitionDigest, findWorkflowJsonViolation, WORKFLOW_DEFINITION_SCHEMA_VERSION, WORKFLOW_RUN_SCHEMA_VERSION, WorkflowStateError, WorkflowStateStore, } from './stateStore.js';
const makeUlid = monotonicFactory();
const MAX_RETRY_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 300_000;
const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const MAX_CONCURRENT_RUNS = 64;
const DEFAULT_MAX_QUEUED_RUNS = 256;
const MAX_QUEUED_RUNS = 4_096;
const DEFAULT_MAX_STEP_EXECUTIONS = 10_000;
const MAX_STEP_EXECUTIONS = 100_000;
const CONTROL_POLL_INTERVAL_MS = 50;
export const MAX_WORKFLOW_DEFINITION_STEPS = 256;
export const MAX_WORKFLOW_NESTING_DEPTH = 16;
export const MAX_WORKFLOW_FOREACH_ITEMS = 1_000;
const SENSITIVE_KEY_RE = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credentials?|access[_-]?key)(?:[_-]?(?:id|file|path))?$/i;
const NON_SECRET_CONTAINER_KEYS = new Set(['input', 'output', 'outputs']);
export class WorkflowRuntimeError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'WorkflowRuntimeError';
    }
}
export class WorkflowRunFailedError extends Error {
    runId;
    status;
    errorClass;
    constructor(runId, status, errorClass) {
        super(`workflow run ${runId} ended with status ${status} (${errorClass ?? 'unknown'})`);
        this.runId = runId;
        this.status = status;
        this.errorClass = errorClass;
        this.name = 'WorkflowRunFailedError';
    }
}
export class ClassifiedWorkflowError extends Error {
    errorClass;
    constructor(errorClass, message = 'workflow step failed') {
        super(message);
        this.errorClass = errorClass;
        this.name = 'ClassifiedWorkflowError';
    }
}
class DeterministicWorkflowError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DeterministicWorkflowError';
    }
}
class WorkflowSuspendedError extends Error {
    constructor() {
        super('workflow execution suspended at a durable operator boundary');
        this.name = 'WorkflowSuspendedError';
    }
}
class CheckpointInterruptionError extends Error {
    interruption;
    constructor(interruption) {
        super(interruption instanceof Error ? interruption.message : 'workflow checkpoint hook interrupted execution');
        this.interruption = interruption;
        this.name = 'CheckpointInterruptionError';
    }
}
class BoundedScheduler {
    limit;
    maxQueuedRuns;
    active = 0;
    queue = [];
    admissionWaiters = new Set();
    constructor(limit, maxQueuedRuns) {
        this.limit = limit;
        this.maxQueuedRuns = maxQueuedRuns;
    }
    schedule(run) {
        if (!this.hasAdmissionCapacity()) {
            throw new WorkflowRuntimeError('workflow scheduler waiting queue limit exceeded', 'RESOURCE_LIMIT');
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ run, resolve: resolve, reject });
            this.drain();
        });
    }
    async waitForAdmission() {
        while (!this.hasAdmissionCapacity()) {
            await new Promise((resolve) => { this.admissionWaiters.add(resolve); });
        }
    }
    hasAdmissionCapacity() {
        return this.active < this.limit || this.queue.length < this.maxQueuedRuns;
    }
    notifyAdmissionWaiters() {
        if (!this.hasAdmissionCapacity())
            return;
        const waiters = [...this.admissionWaiters];
        this.admissionWaiters.clear();
        for (const resolve of waiters)
            resolve();
    }
    drain() {
        while (this.active < this.limit) {
            const job = this.queue.shift();
            if (!job)
                return;
            this.notifyAdmissionWaiters();
            this.active += 1;
            void job.run()
                .then(job.resolve, job.reject)
                .finally(() => {
                this.active -= 1;
                this.notifyAdmissionWaiters();
                this.drain();
            });
        }
    }
}
export function defaultWorkflowStateDir() {
    return join(homedir(), '.evolver', 'workflows');
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        return `{${Object.entries(value)
            .filter(([key]) => key !== 'workflowId')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
export function deriveWorkflowId(spec) {
    const violation = findWorkflowJsonViolation(spec);
    if (violation)
        throw new WorkflowRuntimeError(`workflow definition contains a non-JSON value at ${violation}`, 'INVALID_STATE');
    if (spec.workflowId !== undefined) {
        assertStableId(spec.workflowId, 'workflowId');
        return spec.workflowId;
    }
    return `wf_${deriveWorkflowDefinitionDigest(spec).slice(0, 24)}`;
}
function findSensitivePath(value, path = '$', seen = new Set()) {
    if (typeof value === 'string')
        return containsWorkflowSensitiveText(value) ? path : null;
    if (typeof value !== 'object' || value === null)
        return null;
    if (seen.has(value))
        return null;
    seen.add(value);
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            const found = findSensitivePath(value[index], `${path}[${index}]`, seen);
            if (found)
                return found;
        }
        return null;
    }
    for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        if (!NON_SECRET_CONTAINER_KEYS.has(key) && SENSITIVE_KEY_RE.test(key) && child !== undefined && child !== null && child !== '')
            return childPath;
        const found = findSensitivePath(child, childPath, seen);
        if (found)
            return found;
    }
    return null;
}
function assertPersistable(value) {
    const sensitivePath = findSensitivePath(value);
    if (sensitivePath) {
        throw new WorkflowRuntimeError(`refusing to persist sensitive workflow data at ${sensitivePath}`, 'SENSITIVE_STATE');
    }
    const violation = findWorkflowJsonViolation(value);
    if (violation)
        throw new WorkflowRuntimeError(`workflow state contains a non-JSON value at ${violation}`, 'INVALID_STATE');
}
function invalidWorkflowSpec(path) {
    throw new WorkflowRuntimeError(`workflow definition is malformed at ${path}`, 'INVALID_STATE');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assertValueShape(value, path) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
        return;
    if (!isRecord(value) || typeof value['ref'] !== 'string')
        invalidWorkflowSpec(path);
}
function assertRetryShape(value, path) {
    if (value === undefined)
        return;
    if (!isRecord(value) || typeof value['maxAttempts'] !== 'number')
        invalidWorkflowSpec(path);
    for (const key of ['initialDelayMs', 'maxDelayMs', 'multiplier']) {
        if (value[key] !== undefined && typeof value[key] !== 'number')
            invalidWorkflowSpec(`${path}.${key}`);
    }
}
function workflowResourceLimit(message) {
    throw new WorkflowRuntimeError(message, 'RESOURCE_LIMIT');
}
function assertStepArrayShape(value, path, ancestors = new Set(), budget = { steps: 0 }, depth = 0) {
    if (depth > MAX_WORKFLOW_NESTING_DEPTH) {
        workflowResourceLimit(`workflow definition nesting exceeds ${MAX_WORKFLOW_NESTING_DEPTH} at ${path}`);
    }
    if (!Array.isArray(value) || ancestors.has(value))
        invalidWorkflowSpec(path);
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
        budget.steps += 1;
        if (budget.steps > MAX_WORKFLOW_DEFINITION_STEPS) {
            workflowResourceLimit(`workflow definition exceeds ${MAX_WORKFLOW_DEFINITION_STEPS} steps`);
        }
        const stepPath = `${path}[${index}]`;
        const candidate = value[index];
        if (!isRecord(candidate) || typeof candidate['id'] !== 'string' || typeof candidate['kind'] !== 'string') {
            invalidWorkflowSpec(stepPath);
        }
        const kind = candidate['kind'];
        if (kind === 'script' || kind === 'agent') {
            if (candidate['idempotency'] !== undefined
                && candidate['idempotency'] !== 'idempotent'
                && candidate['idempotency'] !== 'non_idempotent') {
                invalidWorkflowSpec(`${stepPath}.idempotency`);
            }
            assertRetryShape(candidate['retry'], `${stepPath}.retry`);
        }
        if (kind === 'script') {
            const call = candidate['call'];
            if (typeof candidate['setOutput'] !== 'string' || !isRecord(call)
                || typeof call['fn'] !== 'string' || !Array.isArray(call['args'])) {
                invalidWorkflowSpec(stepPath);
            }
            for (let arg = 0; arg < call['args'].length; arg += 1) {
                assertValueShape(call['args'][arg], `${stepPath}.call.args[${arg}]`);
            }
        }
        else if (kind === 'agent') {
            if (typeof candidate['prompt'] !== 'string'
                || (candidate['outputKey'] !== undefined && typeof candidate['outputKey'] !== 'string')) {
                invalidWorkflowSpec(stepPath);
            }
        }
        else if (kind === 'approval') {
            if (candidate['label'] !== undefined && typeof candidate['label'] !== 'string')
                invalidWorkflowSpec(stepPath);
        }
        else if (kind === 'if') {
            assertValueShape(candidate['cond'], `${stepPath}.cond`);
            assertStepArrayShape(candidate['then'], `${stepPath}.then`, ancestors, budget, depth + 1);
            if (candidate['else'] !== undefined) {
                assertStepArrayShape(candidate['else'], `${stepPath}.else`, ancestors, budget, depth + 1);
            }
        }
        else if (kind === 'foreach') {
            if (!isRecord(candidate['over']) || typeof candidate['over']['ref'] !== 'string'
                || typeof candidate['as'] !== 'string'
                || (candidate['parallel'] !== undefined && typeof candidate['parallel'] !== 'boolean')
                || (candidate['collect'] !== undefined && typeof candidate['collect'] !== 'string')) {
                invalidWorkflowSpec(stepPath);
            }
            assertStepArrayShape(candidate['body'], `${stepPath}.body`, ancestors, budget, depth + 1);
        }
        else {
            invalidWorkflowSpec(`${stepPath}.kind`);
        }
    }
    ancestors.delete(value);
}
export function assertValidWorkflowSpec(value) {
    if (!isRecord(value) || typeof value['name'] !== 'string'
        || (value['workflowId'] !== undefined && typeof value['workflowId'] !== 'string')
        || (value['input'] !== undefined && !isRecord(value['input']))) {
        invalidWorkflowSpec('$');
    }
    if (value['output'] !== undefined
        && (!isRecord(value['output']) || typeof value['output']['ref'] !== 'string')) {
        invalidWorkflowSpec('$.output');
    }
    assertStepArrayShape(value['steps'], '$.steps');
    validateSteps(value['steps']);
}
function resolveRef(ref, ctx) {
    const [head, ...rest] = ref.split('.');
    let base;
    if (head === 'input')
        base = ctx.input;
    else if (head === 'steps') {
        const stepId = rest.shift();
        base = stepId !== undefined ? ctx.steps[stepId] : undefined;
    }
    else if (head === 'item')
        base = ctx.item;
    else
        throw new DeterministicWorkflowError(`invalid workflow reference root: ${head}`);
    for (const key of rest) {
        if (base == null)
            return undefined;
        if (typeof base !== 'object')
            return undefined;
        base = base[key];
    }
    return base;
}
function evalValue(value, ctx) {
    return isRef(value) ? resolveRef(value.ref, ctx) : value;
}
function evalCore(call, ctx, core) {
    const fn = core[call.fn];
    if (!fn)
        throw new DeterministicWorkflowError(`core function is not allowlisted: ${call.fn}`);
    return fn(...call.args.map((arg) => evalValue(arg, ctx)));
}
function retrySettings(step) {
    const retry = step.retry;
    const maxAttempts = retry?.maxAttempts ?? 1;
    const initialDelayMs = retry?.initialDelayMs ?? 1_000;
    const maxDelayMs = retry?.maxDelayMs ?? 30_000;
    const multiplier = retry?.multiplier ?? 2;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_RETRY_ATTEMPTS
        || !Number.isFinite(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > MAX_BACKOFF_MS
        || !Number.isFinite(maxDelayMs) || maxDelayMs < initialDelayMs || maxDelayMs > MAX_BACKOFF_MS
        || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
        throw new WorkflowRuntimeError('invalid bounded workflow retry policy', 'INVALID_RETRY');
    }
    return { maxAttempts, initialDelayMs, maxDelayMs, multiplier };
}
function backoffMs(settings, attempts) {
    return Math.min(settings.maxDelayMs, Math.round(settings.initialDelayMs * settings.multiplier ** Math.max(0, attempts - 1)));
}
function defaultClassifyError(error) {
    if (error instanceof ClassifiedWorkflowError)
        return error.errorClass;
    const code = typeof error === 'object' && error !== null ? error.code : undefined;
    return code && ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(code) ? 'transient' : 'unknown';
}
function stepIdempotency(step) {
    return step.idempotency ?? (step.kind === 'script' ? 'idempotent' : 'non_idempotent');
}
function validateSteps(steps, ids = new Set()) {
    for (const step of steps) {
        assertStableId(step.id, 'stepId');
        if (ids.has(step.id))
            throw new WorkflowRuntimeError(`duplicate workflow step id: ${step.id}`, 'RUN_NOT_RESUMABLE');
        ids.add(step.id);
        if (step.kind === 'script' || step.kind === 'agent') {
            const settings = retrySettings(step);
            if (stepIdempotency(step) === 'non_idempotent' && settings.maxAttempts > 1) {
                throw new WorkflowRuntimeError('non-idempotent workflow steps cannot be retried without an idempotency guarantee', 'INVALID_RETRY');
            }
        }
        else if (step.kind === 'if') {
            const beforeBranches = new Set(ids);
            const thenIds = new Set(ids);
            const elseIds = new Set(ids);
            validateSteps(step.then, thenIds);
            validateSteps(step.else ?? [], elseIds);
            for (const id of [...thenIds, ...elseIds]) {
                if (!beforeBranches.has(id))
                    ids.add(id);
            }
        }
        else if (step.kind === 'foreach') {
            if (step.parallel) {
                throw new WorkflowRuntimeError('durable foreach parallelism is deferred beyond phase one', 'UNSUPPORTED_PARALLELISM');
            }
            validateSteps(step.body, ids);
        }
    }
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function collectCanonicalMetadata(steps, prefix = 'root', output = []) {
    for (const step of steps) {
        const executionPrefix = `${prefix}/${escapeRegExp(step.id)}`;
        if (step.kind === 'script' || step.kind === 'agent') {
            output.push({
                pattern: new RegExp(`^${executionPrefix}$`),
                stepId: step.id,
                kind: step.kind,
                idempotency: stepIdempotency(step),
                maxAttempts: retrySettings(step).maxAttempts,
            });
        }
        else if (step.kind === 'approval') {
            output.push({
                pattern: new RegExp(`^${executionPrefix}$`),
                stepId: step.id,
                kind: 'approval',
                idempotency: 'idempotent',
                maxAttempts: 1,
            });
        }
        else if (step.kind === 'if') {
            collectCanonicalMetadata(step.then, `${executionPrefix}:then`, output);
            collectCanonicalMetadata(step.else ?? [], `${executionPrefix}:else`, output);
        }
        else {
            collectCanonicalMetadata(step.body, `${executionPrefix}\\[\\d+\\]`, output);
        }
    }
    return output;
}
function validateResumeState(state) {
    assertValidWorkflowSpec(state.spec);
    assertPersistable(state.spec);
    if (state.spec.workflowId !== state.workflowId || deriveWorkflowId(state.spec) !== state.workflowId) {
        throw new WorkflowRuntimeError('persisted workflow identity does not match its definition', 'RUN_NOT_RESUMABLE');
    }
    if (state.definitionDigest !== deriveWorkflowDefinitionDigest(state.spec)) {
        throw new WorkflowRuntimeError('persisted workflow definition does not match its digest', 'RUN_NOT_RESUMABLE');
    }
    if (stableJson(state.context.input) !== stableJson(state.spec.input ?? {})) {
        throw new WorkflowRuntimeError('persisted workflow input does not match its definition', 'RUN_NOT_RESUMABLE');
    }
    const canonical = collectCanonicalMetadata(state.spec.steps);
    for (const [executionId, persisted] of Object.entries(state.steps)) {
        const expected = canonical.find((candidate) => candidate.pattern.test(executionId));
        if (!expected
            || persisted.executionId !== executionId
            || persisted.stepId !== expected.stepId
            || persisted.kind !== expected.kind
            || persisted.idempotency !== expected.idempotency
            || persisted.maxAttempts !== expected.maxAttempts
            || persisted.attempts > expected.maxAttempts) {
            throw new WorkflowRuntimeError(`persisted workflow step metadata is inconsistent: ${executionId}`, 'RUN_NOT_RESUMABLE');
        }
    }
    if (state.currentStep !== undefined) {
        const current = state.steps[state.currentStep];
        if (!current || !canonical.some((candidate) => candidate.pattern.test(state.currentStep ?? ''))) {
            throw new WorkflowRuntimeError('persisted currentStep is inconsistent with the workflow definition', 'RUN_NOT_RESUMABLE');
        }
    }
    if (state.status === 'waiting_approval') {
        const approval = state.approval;
        const current = approval ? state.steps[approval.executionId] : undefined;
        if (!approval || state.currentStep !== approval.executionId || current?.kind !== 'approval'
            || current.status !== 'waiting_approval' || current.stepId !== approval.gateId) {
            throw new WorkflowRuntimeError('persisted approval state is inconsistent', 'RUN_NOT_RESUMABLE');
        }
    }
}
function validateConcurrency(value) {
    const configured = value ?? DEFAULT_MAX_CONCURRENT_RUNS;
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > MAX_CONCURRENT_RUNS) {
        throw new WorkflowRuntimeError('maxConcurrentRuns must be an integer between 1 and 64', 'INVALID_CONCURRENCY');
    }
    return configured;
}
function validateMaxQueuedRuns(value) {
    const configured = value ?? DEFAULT_MAX_QUEUED_RUNS;
    if (!Number.isSafeInteger(configured) || configured < 0 || configured > MAX_QUEUED_RUNS) {
        throw new WorkflowRuntimeError('maxQueuedRuns must be an integer between 0 and 4096', 'INVALID_CONCURRENCY');
    }
    return configured;
}
function validateMaxStepExecutions(value) {
    const configured = value ?? DEFAULT_MAX_STEP_EXECUTIONS;
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > MAX_STEP_EXECUTIONS) {
        throw new WorkflowRuntimeError('maxStepExecutions must be an integer between 1 and 100000', 'RESOURCE_LIMIT');
    }
    return configured;
}
function isTerminal(status) {
    return ['cancelled', 'succeeded', 'failed', 'unsafe_to_resume'].includes(status);
}
function canBypassHistoryForSafety(error) {
    return error instanceof WorkflowStateError
        && ['RESOURCE_LIMIT', 'CORRUPT_STATE', 'UNSAFE_PATH', 'INSECURE_PERMISSIONS'].includes(error.code);
}
export class DurableWorkflowRuntime {
    deps;
    store;
    core;
    now;
    sleep;
    classifyError;
    generateRunId;
    scheduler;
    maxConcurrentRuns;
    maxStepExecutions;
    inFlight = new Map();
    constructor(deps) {
        this.deps = deps;
        this.store = new WorkflowStateStore(deps.stateDir ?? defaultWorkflowStateDir(), {
            lock: deps.lock,
            onTransactionPhase: deps.onTransactionPhase,
        });
        this.core = { ...CORE_WHITELIST, ...(deps.core ?? {}) };
        this.now = deps.now ?? (() => Date.now());
        this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.classifyError = deps.classifyError ?? defaultClassifyError;
        this.generateRunId = deps.generateRunId ?? (() => `run_${makeUlid()}`);
        this.maxConcurrentRuns = validateConcurrency(deps.maxConcurrentRuns);
        this.maxStepExecutions = validateMaxStepExecutions(deps.maxStepExecutions);
        const sharedLimit = this.store.ensureConcurrencyLimit(this.maxConcurrentRuns);
        if (sharedLimit !== this.maxConcurrentRuns) {
            throw new WorkflowRuntimeError(`state directory maxConcurrentRuns is ${sharedLimit}, not ${this.maxConcurrentRuns}`, 'INVALID_CONCURRENCY');
        }
        this.scheduler = new BoundedScheduler(this.maxConcurrentRuns, validateMaxQueuedRuns(deps.maxQueuedRuns));
    }
    async start(spec, options = {}) {
        assertValidWorkflowSpec(spec);
        assertPersistable(spec);
        const workflowId = deriveWorkflowId(spec);
        const runId = typeof options === 'string' ? options : (options.runId ?? this.generateRunId());
        assertStableId(runId, 'runId');
        const timestamp = this.timestamp();
        const state = {
            schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
            workflowSchemaVersion: WORKFLOW_DEFINITION_SCHEMA_VERSION,
            workflowId,
            definitionDigest: deriveWorkflowDefinitionDigest(spec),
            runId,
            workflowName: spec.name,
            status: 'queued',
            spec: { ...spec, workflowId },
            context: { input: spec.input ?? {}, steps: {} },
            steps: {},
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        await this.withLockedRun(runId, async () => {
            try {
                this.store.readStored(runId);
                throw new WorkflowRuntimeError(`workflow run already exists: ${runId}`, 'RUN_NOT_RESUMABLE');
            }
            catch (error) {
                if (!(error instanceof WorkflowStateError) || error.code !== 'STATE_NOT_FOUND')
                    throw error;
            }
            await this.checkpoint(state, [
                this.historyEvent(state, 'run_created'),
                this.historyEvent(state, 'run_queued'),
            ]);
        });
        let scheduled;
        try {
            // Keep admission separate from await so execution failures are not mistaken for synchronous queue rejection.
            scheduled = this.scheduleRun(runId, 'start');
        }
        catch (error) {
            if (error instanceof WorkflowRuntimeError && error.code === 'RESOURCE_LIMIT') {
                await this.withLockedRun(runId, async () => {
                    const rejected = this.store.readStored(runId);
                    if (rejected.status === 'queued')
                        await this.failState(rejected, 'resource_limit');
                });
            }
            throw error;
        }
        return await scheduled;
    }
    async resume(runId, options) {
        if (options !== undefined)
            return await this.operatorResume(runId, options);
        return await this.scheduleRun(runId, 'recovery');
    }
    async operatorResume(runId, options) {
        const existing = this.inFlight.get(runId);
        if (existing)
            await existing;
        await this.withLockedRun(runId, async () => {
            const state = this.store.readStored(runId);
            await this.validateResumeStateOrFail(state);
            if (state.status !== 'paused' && state.status !== 'waiting_approval') {
                throw new WorkflowStateError('workflow run is not paused or waiting for approval', 'INVALID_TRANSITION');
            }
            if (state.status === 'waiting_approval') {
                const control = this.store.readControl(runId);
                const executionId = state.approval?.executionId;
                const decision = executionId ? control.approvals[executionId] : undefined;
                if (!decision) {
                    throw new WorkflowStateError('workflow approval decision is still pending', 'INVALID_TRANSITION');
                }
                this.ensureApprovalDecisionHistory(state, decision);
            }
            state.status = 'queued';
            state.updatedAt = this.timestamp();
            try {
                await this.checkpoint(state, [this.historyEvent(state, 'resume_requested', options)], { pause: null });
            }
            catch (error) {
                if (!canBypassHistoryForSafety(error))
                    throw error;
                await this.safetyCheckpoint(state, { pause: null });
            }
        });
        return await this.scheduleRun(runId, 'operator');
    }
    async pause(runId, options) {
        const at = this.timestamp();
        this.store.requestPauseWithHistory(runId, options, at);
        return this.result(this.store.read(runId));
    }
    async cancel(runId, options) {
        const state = this.store.readStored(runId);
        const at = this.timestamp();
        this.store.requestCancelWithHistory(runId, options, at);
        if (state.status !== 'paused' && state.status !== 'waiting_approval') {
            return this.result(this.store.read(runId));
        }
        return await this.withLockedRun(runId, async () => {
            const lockedState = this.store.readStored(runId);
            if (isTerminal(lockedState.status))
                return this.result(lockedState);
            const cancel = this.store.readControl(runId).cancel;
            if (!cancel)
                return this.result(lockedState);
            await this.finalizeCancellation(lockedState, cancel);
            return this.result(lockedState);
        });
    }
    async approve(runId, gateId, options) {
        const at = this.timestamp();
        await this.withLockedRun(runId, async () => {
            const state = this.store.readStored(runId);
            await this.validateResumeStateOrFail(state);
            this.store.approve(runId, gateId, options, at);
        });
        return await this.operatorResume(runId, options);
    }
    async reject(runId, gateId, options) {
        const at = this.timestamp();
        await this.withLockedRun(runId, async () => {
            const state = this.store.readStored(runId);
            await this.validateResumeStateOrFail(state);
            this.store.reject(runId, gateId, options, at);
        });
        return await this.operatorResume(runId, options);
    }
    status(runId) {
        return this.store.read(runId);
    }
    history(runId) {
        return this.store.readHistory(runId);
    }
    async recoverPending() {
        return await this.recoverRuns((runId) => this.isRecoveryCandidate(this.store.readStored(runId), this.store.readControl(runId)), (runId, error) => { this.reportRecoveryFailure(runId, error); });
    }
    isRecoveryCandidate(state, control) {
        const hasRecoverableCancel = (state.status === 'paused' || state.status === 'waiting_approval')
            && control.cancel !== undefined;
        const approvalExecutionId = state.status === 'waiting_approval' ? state.approval?.executionId : undefined;
        const hasRecoverableDecision = approvalExecutionId !== undefined
            && control.approvals[approvalExecutionId] !== undefined;
        return hasRecoverableCancel || hasRecoverableDecision
            || ['queued', 'pending', 'running', 'retry_wait'].includes(state.status);
    }
    async recoverRuns(shouldRecover, reportFailure) {
        const runIds = this.store.listRunIds();
        const results = new Array(runIds.length);
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < runIds.length) {
                const index = nextIndex;
                nextIndex += 1;
                const runId = runIds[index];
                try {
                    if (await shouldRecover(runId))
                        results[index] = await this.scheduleRecoveryRun(runId);
                }
                catch (error) {
                    reportFailure(runId, error);
                }
            }
        };
        const workerCount = Math.min(this.maxConcurrentRuns, runIds.length);
        await Promise.all(Array.from({ length: workerCount }, worker));
        return results.filter((result) => result !== undefined);
    }
    async scheduleRecoveryRun(runId) {
        while (true) {
            await this.scheduler.waitForAdmission();
            let scheduled;
            try {
                scheduled = this.scheduleRun(runId, 'recovery');
            }
            catch (error) {
                if (error instanceof WorkflowRuntimeError && error.code === 'RESOURCE_LIMIT')
                    continue;
                throw error;
            }
            return await scheduled;
        }
    }
    scheduleRun(runId, mode) {
        const existing = this.inFlight.get(runId);
        if (existing)
            return existing;
        const scheduled = this.scheduler.schedule(async () => await this.withConcurrencySlot(async () => await this.resumeLocked(runId, mode)));
        this.inFlight.set(runId, scheduled);
        void scheduled.finally(() => {
            if (this.inFlight.get(runId) === scheduled)
                this.inFlight.delete(runId);
        }).catch(() => undefined);
        return scheduled;
    }
    async resumeLocked(runId, mode) {
        return await this.withLockedRun(runId, async () => {
            const state = this.store.readStored(runId);
            await this.validateResumeStateOrFail(state);
            if (isTerminal(state.status))
                return this.result(state);
            const control = this.store.readControl(runId);
            const cancel = control.cancel;
            if (cancel) {
                await this.finalizeCancellation(state, cancel);
                return this.result(state);
            }
            if (state.status === 'paused')
                return this.result(state);
            if (state.status === 'waiting_approval') {
                const executionId = state.approval?.executionId;
                const decision = executionId ? control.approvals[executionId] : undefined;
                if (!decision)
                    return this.result(state);
                this.ensureApprovalDecisionHistory(state, decision);
            }
            if (mode === 'recovery') {
                this.appendHistoryUnlessUnavailable(this.historyEvent(state, 'recovery_started'));
            }
            const interrupted = state.currentStep ? state.steps[state.currentStep] : undefined;
            if (interrupted?.status === 'running') {
                if (interrupted.idempotency === 'non_idempotent') {
                    interrupted.status = 'failed';
                    interrupted.lastErrorClass = 'interrupted_non_idempotent';
                    state.status = 'unsafe_to_resume';
                    state.lastErrorClass = 'interrupted_non_idempotent';
                    state.updatedAt = this.timestamp();
                    try {
                        await this.checkpoint(state, [
                            this.historyEvent(state, 'unsafe_to_resume', {
                                executionId: interrupted.executionId,
                                stepId: interrupted.stepId,
                                errorClass: 'interrupted_non_idempotent',
                            }),
                        ]);
                    }
                    catch (error) {
                        if (!canBypassHistoryForSafety(error))
                            throw error;
                        await this.safetyCheckpoint(state);
                    }
                    return this.result(state);
                }
                interrupted.status = 'pending';
                interrupted.attempts = Math.max(0, interrupted.attempts - 1);
                delete interrupted.startedAt;
                delete interrupted.completedAt;
                delete interrupted.nextAttemptAt;
            }
            return await this.execute(state);
        });
    }
    async withLockedRun(runId, fn) {
        this.store.acquireRunLock(runId);
        try {
            return await fn();
        }
        finally {
            this.store.releaseRunLock(runId);
        }
    }
    async withConcurrencySlot(fn) {
        let slot = null;
        while (slot === null) {
            slot = this.store.tryAcquireConcurrencySlot(this.maxConcurrentRuns);
            if (slot === null)
                await new Promise((resolve) => setTimeout(resolve, 10));
        }
        try {
            return await fn();
        }
        finally {
            this.store.releaseConcurrencySlot(slot);
        }
    }
    async validateResumeStateOrFail(state) {
        try {
            validateResumeState(state);
        }
        catch (error) {
            if (error instanceof WorkflowRuntimeError
                && ['RUN_NOT_RESUMABLE', 'INVALID_STATE', 'INVALID_RETRY', 'UNSUPPORTED_PARALLELISM', 'RESOURCE_LIMIT'].includes(error.code)
                && !isTerminal(state.status)) {
                await this.failState(state, error.code === 'RESOURCE_LIMIT' ? 'resource_limit' : 'invalid_control_flow');
            }
            throw error;
        }
    }
    async execute(state) {
        try {
            await this.enforceControlBoundary(state);
            state.status = 'running';
            state.updatedAt = this.timestamp();
            await this.checkpoint(state, [this.historyEvent(state, 'run_started')]);
            const ctx = { input: state.context.input, steps: state.context.steps };
            await this.runSteps(state, state.spec.steps, ctx, 'root', { remaining: this.maxStepExecutions });
            await this.enforceControlBoundary(state);
            state.context = { input: ctx.input, steps: ctx.steps };
            delete state.currentStep;
            delete state.approval;
            state.status = 'succeeded';
            state.completedAt = this.timestamp();
            state.updatedAt = state.completedAt;
            await this.checkpointCompletion(state, [this.historyEvent(state, 'run_succeeded')]);
            return this.result(state);
        }
        catch (error) {
            if (error instanceof WorkflowSuspendedError)
                return this.result(this.store.readStored(state.runId));
            if (error instanceof CheckpointInterruptionError)
                throw error;
            if (error instanceof DeterministicWorkflowError) {
                await this.failState(state, 'invalid_control_flow');
                throw new WorkflowRunFailedError(state.runId, 'failed', 'invalid_control_flow');
            }
            const latest = this.store.readStored(state.runId);
            if (latest.status === 'failed' || latest.status === 'unsafe_to_resume') {
                throw new WorkflowRunFailedError(latest.runId, latest.status, latest.lastErrorClass);
            }
            if ((error instanceof WorkflowRuntimeError
                && (error.code === 'SENSITIVE_STATE' || error.code === 'INVALID_STATE' || error.code === 'RESOURCE_LIMIT'))
                || canBypassHistoryForSafety(error)) {
                const errorClass = error instanceof WorkflowStateError
                    ? (error.code === 'RESOURCE_LIMIT' ? 'resource_limit' : 'invalid_control_flow')
                    : (error.code === 'SENSITIVE_STATE'
                        ? 'sensitive_output'
                        : (error.code === 'RESOURCE_LIMIT' ? 'resource_limit' : 'invalid_output'));
                await this.failState(latest, errorClass);
                throw new WorkflowRunFailedError(latest.runId, 'failed', errorClass);
            }
            throw error;
        }
    }
    async runSteps(state, steps, ctx, prefix, budget) {
        for (const step of steps) {
            await this.enforceControlBoundary(state);
            await this.runStep(state, step, ctx, prefix, budget);
        }
    }
    async runStep(state, step, ctx, prefix, budget) {
        if (budget.remaining <= 0)
            workflowResourceLimit('workflow expanded step execution limit exceeded');
        budget.remaining -= 1;
        const executionId = `${prefix}/${step.id}`;
        if (step.kind === 'script' || step.kind === 'agent') {
            const output = await this.runLeaf(state, step, ctx, executionId);
            ctx.steps[step.id] = output;
            state.context = { input: state.context.input, steps: ctx.steps };
            return;
        }
        if (step.kind === 'approval') {
            await this.runApproval(state, step, ctx, executionId);
            return;
        }
        if (step.kind === 'if') {
            const branchName = evalValue(step.cond, ctx) ? 'then' : 'else';
            await this.runSteps(state, branchName === 'then' ? step.then : (step.else ?? []), ctx, `${executionId}:${branchName}`, budget);
            return;
        }
        const items = resolveRef(step.over.ref, ctx);
        if (!Array.isArray(items))
            throw new DeterministicWorkflowError(`foreach reference is not an array: ${step.over.ref}`);
        if (items.length > MAX_WORKFLOW_FOREACH_ITEMS) {
            workflowResourceLimit(`workflow foreach exceeds ${MAX_WORKFLOW_FOREACH_ITEMS} items`);
        }
        const results = [];
        for (let index = 0; index < items.length; index += 1) {
            const sub = { input: ctx.input, steps: { ...ctx.steps }, item: items[index] };
            await this.runSteps(state, step.body, sub, `${executionId}[${index}]`, budget);
            results.push(this.lastStepOutput(step.body, sub));
        }
        const collected = { [step.collect ?? 'results']: results };
        assertPersistable(collected);
        ctx.steps[step.id] = collected;
        state.context = { input: state.context.input, steps: ctx.steps };
        state.updatedAt = this.timestamp();
        await this.checkpoint(state);
    }
    lastStepOutput(steps, ctx) {
        const last = steps.at(-1);
        if (!last)
            return null;
        if (last.kind !== 'if')
            return ctx.steps[last.id] ?? null;
        const branch = evalValue(last.cond, ctx) ? last.then : (last.else ?? []);
        return this.lastStepOutput(branch, ctx);
    }
    async failState(state, errorClass) {
        const completedAt = this.timestamp();
        const current = state.currentStep ? state.steps[state.currentStep] : undefined;
        if (current && current.status !== 'succeeded' && current.status !== 'failed') {
            current.status = 'failed';
            current.lastErrorClass = errorClass;
            current.completedAt = completedAt;
        }
        state.status = 'failed';
        state.lastErrorClass = errorClass;
        state.completedAt = completedAt;
        state.updatedAt = completedAt;
        delete state.approval;
        try {
            await this.checkpoint(state, [this.historyEvent(state, 'run_failed', { errorClass })]);
        }
        catch (error) {
            if (!canBypassHistoryForSafety(error))
                throw error;
            await this.safetyCheckpoint(state);
        }
    }
    async runApproval(state, step, ctx, executionId) {
        const existing = state.steps[executionId];
        if (existing?.status === 'succeeded') {
            ctx.steps[step.id] = existing.output ?? { approved: true };
            return;
        }
        const stepState = existing ?? {
            executionId,
            stepId: step.id,
            kind: 'approval',
            idempotency: 'idempotent',
            status: 'pending',
            attempts: 0,
            maxAttempts: 1,
        };
        state.steps[executionId] = stepState;
        const control = this.store.readControl(state.runId);
        const decision = control.approvals[executionId];
        if (decision?.decision === 'rejected') {
            stepState.status = 'failed';
            stepState.lastErrorClass = 'approval_rejected';
            stepState.completedAt = this.timestamp();
            state.currentStep = executionId;
            state.status = 'failed';
            state.lastErrorClass = 'approval_rejected';
            state.completedAt = stepState.completedAt;
            state.updatedAt = stepState.completedAt;
            delete state.approval;
            await this.checkpoint(state, [
                this.historyEvent(state, 'step_failed', {
                    executionId,
                    stepId: step.id,
                    errorClass: 'approval_rejected',
                }),
                this.historyEvent(state, 'run_failed', { errorClass: 'approval_rejected' }),
            ]);
            throw new ClassifiedWorkflowError('permanent', 'workflow approval was rejected');
        }
        if (decision?.decision === 'approved') {
            const output = { approved: true };
            stepState.output = output;
            stepState.status = 'succeeded';
            stepState.completedAt = this.timestamp();
            state.currentStep = executionId;
            state.updatedAt = stepState.completedAt;
            delete state.approval;
            ctx.steps[step.id] = output;
            state.context = { input: state.context.input, steps: ctx.steps };
            await this.checkpoint(state, [this.historyEvent(state, 'step_succeeded', { executionId, stepId: step.id })]);
            return;
        }
        const requestedAt = this.timestamp();
        stepState.status = 'waiting_approval';
        stepState.startedAt ??= requestedAt;
        state.currentStep = executionId;
        state.approval = { gateId: step.id, executionId, requestedAt };
        state.status = 'waiting_approval';
        state.updatedAt = requestedAt;
        await this.checkpoint(state, [
            this.historyEvent(state, 'approval_waiting', { executionId, stepId: step.id, gateId: step.id }),
        ]);
        throw new WorkflowSuspendedError();
    }
    async runLeaf(state, step, ctx, executionId) {
        const settings = retrySettings(step);
        const idempotency = stepIdempotency(step);
        const existing = state.steps[executionId];
        if (existing?.status === 'succeeded')
            return existing.output;
        const stepState = existing ?? {
            executionId,
            stepId: step.id,
            kind: step.kind,
            idempotency,
            status: 'pending',
            attempts: 0,
            maxAttempts: settings.maxAttempts,
        };
        state.steps[executionId] = stepState;
        while (stepState.attempts < stepState.maxAttempts) {
            await this.enforceControlBoundary(state);
            if (stepState.status === 'retry_wait' && stepState.nextAttemptAt) {
                const remaining = Date.parse(stepState.nextAttemptAt) - this.now();
                if (remaining > 0)
                    await this.sleep(remaining);
                await this.enforceControlBoundary(state);
            }
            stepState.attempts += 1;
            stepState.status = 'running';
            stepState.startedAt = this.timestamp();
            delete stepState.nextAttemptAt;
            state.currentStep = executionId;
            state.status = 'running';
            state.updatedAt = stepState.startedAt;
            await this.checkpoint(state, [
                this.historyEvent(state, 'step_started', {
                    executionId,
                    stepId: step.id,
                    attempt: stepState.attempts,
                }),
            ]);
            let output;
            try {
                output = step.kind === 'script'
                    ? { [step.setOutput]: evalCore(step.call, ctx, this.core) }
                    : { [step.outputKey ?? 'output']: await this.runAgentAttempt(state.runId, step.prompt, ctx) };
                assertPersistable(output);
            }
            catch (error) {
                const persistError = error instanceof WorkflowRuntimeError
                    && (error.code === 'SENSITIVE_STATE' || error.code === 'INVALID_STATE');
                if (persistError) {
                    const errorClass = error.code === 'SENSITIVE_STATE' ? 'sensitive_output' : 'invalid_output';
                    stepState.status = 'failed';
                    stepState.lastErrorClass = errorClass;
                    state.status = stepState.idempotency === 'non_idempotent' ? 'unsafe_to_resume' : 'failed';
                    state.lastErrorClass = errorClass;
                }
                else {
                    const errorClass = this.classifyError(error);
                    stepState.lastErrorClass = errorClass;
                    state.lastErrorClass = errorClass;
                    if (errorClass === 'transient' && stepState.attempts < stepState.maxAttempts) {
                        const delay = backoffMs(settings, stepState.attempts);
                        stepState.status = 'retry_wait';
                        stepState.nextAttemptAt = new Date(this.now() + delay).toISOString();
                        state.status = 'retry_wait';
                        state.updatedAt = this.timestamp();
                        await this.checkpointCompletion(state, [
                            this.historyEvent(state, 'step_retry_scheduled', {
                                executionId,
                                stepId: step.id,
                                attempt: stepState.attempts,
                                errorClass,
                            }),
                        ]);
                        continue;
                    }
                    stepState.status = 'failed';
                    state.status = stepState.idempotency === 'non_idempotent'
                        && (errorClass === 'unknown' || errorClass === 'permanent')
                        ? 'unsafe_to_resume'
                        : 'failed';
                }
                stepState.completedAt = this.timestamp();
                state.completedAt = stepState.completedAt;
                state.updatedAt = stepState.completedAt;
                await this.checkpointCompletion(state, [
                    this.historyEvent(state, 'step_failed', {
                        executionId,
                        stepId: step.id,
                        attempt: stepState.attempts,
                        ...(stepState.lastErrorClass ? { errorClass: stepState.lastErrorClass } : {}),
                    }),
                    state.status === 'unsafe_to_resume'
                        ? this.historyEvent(state, 'unsafe_to_resume', {
                            executionId,
                            stepId: step.id,
                            ...(stepState.lastErrorClass ? { errorClass: stepState.lastErrorClass } : {}),
                        })
                        : this.historyEvent(state, 'run_failed', {
                            ...(stepState.lastErrorClass ? { errorClass: stepState.lastErrorClass } : {}),
                        }),
                ]);
                throw error;
            }
            stepState.output = output;
            stepState.status = 'succeeded';
            stepState.completedAt = this.timestamp();
            delete stepState.lastErrorClass;
            delete state.lastErrorClass;
            state.updatedAt = stepState.completedAt;
            await this.checkpointCompletion(state, [
                this.historyEvent(state, 'step_succeeded', {
                    executionId,
                    stepId: step.id,
                    attempt: stepState.attempts,
                }),
            ]);
            return output;
        }
        state.status = 'failed';
        state.updatedAt = this.timestamp();
        await this.checkpoint(state, [this.historyEvent(state, 'run_failed')]);
        throw new WorkflowRuntimeError('workflow retry attempts exhausted', 'RUN_NOT_RESUMABLE');
    }
    async runAgentAttempt(runId, prompt, ctx) {
        const controller = new AbortController();
        const observer = this.observeCancellation(runId, controller);
        try {
            const execution = Promise.resolve().then(async () => {
                if (controller.signal.aborted)
                    throw new WorkflowSuspendedError();
                return await this.deps.agent(prompt, ctx, { signal: controller.signal });
            });
            return await Promise.race([execution, observer.failure]);
        }
        finally {
            observer.stop();
        }
    }
    observeCancellation(runId, controller) {
        let stopped = false;
        let timer;
        let rejectFailure;
        const failure = new Promise((_resolve, reject) => { rejectFailure = reject; });
        const poll = () => {
            if (stopped)
                return;
            try {
                if (this.store.readControl(runId).cancel) {
                    controller.abort();
                    return;
                }
                timer = setTimeout(poll, CONTROL_POLL_INTERVAL_MS);
            }
            catch (error) {
                controller.abort();
                rejectFailure(error);
            }
        };
        poll();
        return {
            failure,
            stop: () => {
                stopped = true;
                if (timer !== undefined)
                    clearTimeout(timer);
            },
        };
    }
    async checkpointCompletion(state, history) {
        assertPersistable(state);
        const cancellation = this.store.commitUnlessCancelled(state, history);
        if (cancellation) {
            const durableState = this.store.readStored(state.runId);
            await this.finalizeCancellation(durableState, cancellation);
            throw new WorkflowSuspendedError();
        }
        try {
            await this.deps.afterCheckpoint?.(state);
        }
        catch (error) {
            throw new CheckpointInterruptionError(error);
        }
    }
    async enforceControlBoundary(state) {
        const control = this.store.readControl(state.runId);
        if (control.cancel) {
            await this.finalizeCancellation(state, control.cancel);
            throw new WorkflowSuspendedError();
        }
        if (control.pause) {
            state.status = 'paused';
            state.updatedAt = this.timestamp();
            await this.checkpoint(state, [
                this.historyEvent(state, 'paused', {
                    actor: control.pause.actor,
                    ...(control.pause.reason ? { reason: control.pause.reason } : {}),
                }),
            ]);
            throw new WorkflowSuspendedError();
        }
    }
    async finalizeCancellation(state, request) {
        if (state.status === 'cancelled')
            return;
        const completedAt = this.timestamp();
        state.status = 'cancelled';
        state.completedAt = completedAt;
        state.updatedAt = completedAt;
        delete state.approval;
        try {
            await this.checkpoint(state, [
                this.historyEvent(state, 'cancelled', {
                    actor: request.actor,
                    ...(request.reason ? { reason: request.reason } : {}),
                    at: completedAt,
                }),
            ], { pause: null, cancel: null });
        }
        catch (error) {
            if (!canBypassHistoryForSafety(error))
                throw error;
            // Retain cancel as the bounded durable audit when operation history cannot accept another event.
            await this.safetyCheckpoint(state, { pause: null });
        }
    }
    async checkpoint(state, history = [], controlPatch = {}) {
        assertPersistable(state);
        this.store.commit(state, history, controlPatch);
        try {
            await this.deps.afterCheckpoint?.(state);
        }
        catch (error) {
            throw new CheckpointInterruptionError(error);
        }
    }
    async safetyCheckpoint(state, controlPatch = {}) {
        assertPersistable(state);
        this.store.commitSafetyState(state, controlPatch);
        try {
            await this.deps.afterCheckpoint?.(state);
        }
        catch (error) {
            throw new CheckpointInterruptionError(error);
        }
    }
    ensureApprovalDecisionHistory(state, decision) {
        try {
            const type = decision.decision === 'approved' ? 'approval_approved' : 'approval_rejected';
            const recorded = this.store.readHistory(state.runId).some((event) => event.type === type
                && event.gateId === decision.gateId
                && event.at === decision.requestedAt
                && event.actor === decision.actor
                && event.reason === decision.reason
                && (event.executionId === undefined || event.executionId === decision.executionId));
            if (recorded)
                return;
            this.store.appendHistory(this.historyEvent(state, type, {
                at: decision.requestedAt,
                executionId: decision.executionId,
                gateId: decision.gateId,
                actor: decision.actor,
                ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
            }));
        }
        catch (error) {
            if (!canBypassHistoryForSafety(error))
                throw error;
        }
    }
    appendHistoryUnlessUnavailable(event) {
        try {
            this.store.appendHistory(event);
        }
        catch (error) {
            if (!canBypassHistoryForSafety(error))
                throw error;
        }
    }
    historyEvent(state, type, metadata = {}) {
        const { at, ...rest } = metadata;
        return {
            runId: state.runId,
            workflowId: state.workflowId,
            type,
            status: state.status,
            at: at ?? this.timestamp(),
            ...rest,
        };
    }
    timestamp() {
        return new Date(this.now()).toISOString();
    }
    result(state) {
        const ctx = { input: state.context.input, steps: state.context.steps };
        return {
            runId: state.runId,
            workflowId: state.workflowId,
            status: state.status,
            output: state.status === 'succeeded' && state.spec.output ? resolveRef(state.spec.output.ref, ctx) : undefined,
            ctx,
        };
    }
    reportRecoveryFailure(runId, error) {
        try {
            this.deps.onRecoveryFailure?.({ runId, code: recoveryFailureCode(error) });
        }
        catch {
            // Startup recovery must continue even if an optional diagnostic sink fails.
        }
    }
}
function recoveryFailureCode(error) {
    if (error instanceof WorkflowStateError)
        return error.code;
    if (error instanceof WorkflowRunFailedError)
        return 'RUN_FAILED';
    return 'RECOVERY_FAILED';
}