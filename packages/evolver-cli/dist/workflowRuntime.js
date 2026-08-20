import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { algo, assetstore, events, exec, schema, verify, wire, workflow } from '@evomap/evolver-core';
import { readAutoExecConfig } from './autoexecConfig.js';
import { runRequiredSandboxedValidation } from './requiredSandboxValidation.js';
const DEFAULT_MAX_CONCURRENT_RUNS = 4;
const MAX_MAX_CONCURRENT_RUNS = 64;
const MAX_PROMPT_LENGTH = 4_000;
const MAX_REPO_PATH_LENGTH = 4_096;
const MAX_SIGNALS = 32;
const MAX_SIGNAL_LENGTH = 160;
const EXECUTION_CONTEXT_KEY = 'workflowExecution';
const POLICY_CONTEXT_KEY = 'workflowPolicyContext';
const LEGACY_POLICY_CONTEXT_SCHEMA_VERSION = 1;
const POLICY_CONTEXT_SCHEMA_VERSION = 2;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_TEXT_RE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|gh[oprsu])_[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+)/i;
const EXECUTION_CONTEXT_KEYS = new Set(['repo', 'signals', 'reviewedGeneAssetId', 'validationProfile']);
const RECOVERY_CODES = new Set([
    'INVALID_ID',
    'CORRUPT_STATE',
    'UNSUPPORTED_SCHEMA',
    'UNSAFE_PATH',
    'INSECURE_PERMISSIONS',
    'STATE_NOT_FOUND',
    'RUN_FAILED',
    'RECOVERY_FAILED',
    'RECOVERY_INIT_FAILED',
]);
function classified(errorClass, message) {
    return new workflow.ClassifiedWorkflowError(errorClass, message);
}
function classifyWorkflowExecutionFailure(result) {
    const reason = result.outcome.reason;
    const operationalReason = reason === 'execution cancelled' || reason?.startsWith('execution proof failed:') === true;
    if (reason !== undefined && !operationalReason) {
        return classified('safety', 'workflow agent execution was rejected by diff policy');
    }
    switch (result.failureKind) {
        case 'spawn_failed':
        case 'timeout':
            return classified('transient', 'workflow agent execution failed transiently');
        case 'cancelled':
            return classified('permanent', 'workflow agent execution was cancelled');
        case 'permission_denied':
            return classified('safety', 'workflow agent execution was denied by runner policy');
        case 'non_zero_exit':
        case 'invalid_output':
            return classified('permanent', 'workflow agent execution failed permanently');
        case 'runtime_error':
            return classified('unknown', 'workflow agent execution or proof capture failed');
        case undefined:
            return classified('permanent', 'workflow agent execution did not produce an accepted change');
    }
}
export function defaultWorkflowAutoExecHome(env = process.env) {
    return join(events.evomapHome(env), 'autoexec');
}
export function resolveWorkflowAutoExecHome(options = {}) {
    const env = options.env ?? process.env;
    const configured = options.autoExecHome ?? env['EVOLVER_AUTOEXEC_HOME']?.trim();
    return resolve(configured || defaultWorkflowAutoExecHome(env));
}
function canonicalPolicyHome(path) {
    const suffix = [];
    let cursor = resolve(path);
    while (true) {
        try {
            return join(realpathSync(cursor), ...suffix.reverse());
        }
        catch {
            const parent = dirname(cursor);
            if (parent === cursor)
                return resolve(path);
            suffix.push(basename(cursor));
            cursor = parent;
        }
    }
}
function digestPolicy(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function normalizedLegacyPolicy(config) {
    const validationProfiles = Object.keys(config.workflowValidationProfiles)
        .sort()
        .map((name) => [name, config.workflowValidationProfiles[name]]);
    return {
        allowedRoots: [...new Set(config.allowedRoots.map((root) => root.trim()))].sort(),
        runner: config.runner,
        timeoutMs: config.timeoutMs,
        validationProfiles,
    };
}
function normalizedPolicy(config, allowedRoots) {
    const legacy = normalizedLegacyPolicy(config);
    return { ...legacy, allowedRoots };
}
function createWorkflowPolicyContext(home, assetsDir, config, allowedRoots) {
    const canonicalHome = canonicalPolicyHome(home);
    const policy = normalizedPolicy(config, allowedRoots);
    const legacyPolicy = normalizedLegacyPolicy(config);
    return {
        schemaVersion: POLICY_CONTEXT_SCHEMA_VERSION,
        homeId: digestPolicy(canonicalHome),
        policyId: digestPolicy({ ...policy, assetsRealm: canonicalPolicyHome(assetsDir) }),
        legacyPolicyId: digestPolicy({ home: canonicalHome, ...legacyPolicy }),
        allowLegacyPolicyExact: legacyPolicy.allowedRoots.length === allowedRoots.length
            && legacyPolicy.allowedRoots.every((root, index) => root === allowedRoots[index]),
    };
}
function isWorkflowPolicyContext(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const record = value;
    return Object.keys(record).length === 3
        && record['schemaVersion'] === POLICY_CONTEXT_SCHEMA_VERSION
        && typeof record['homeId'] === 'string'
        && /^[a-f0-9]{64}$/.test(record['homeId'])
        && typeof record['policyId'] === 'string'
        && /^[a-f0-9]{64}$/.test(record['policyId']);
}
function isLegacyWorkflowPolicyContext(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const record = value;
    return Object.keys(record).length === 2
        && record['schemaVersion'] === LEGACY_POLICY_CONTEXT_SCHEMA_VERSION
        && typeof record['policyId'] === 'string'
        && /^[a-f0-9]{64}$/.test(record['policyId']);
}
function persistedPolicyContext(expected) {
    return {
        schemaVersion: expected.schemaVersion,
        homeId: expected.homeId,
        policyId: expected.policyId,
    };
}
function policyContextDisposition(input, expected) {
    const persisted = input[POLICY_CONTEXT_KEY];
    if (isWorkflowPolicyContext(persisted)) {
        if (persisted.homeId !== expected.homeId)
            return 'owner_unknown_or_mismatch';
        return persisted.policyId === expected.policyId ? 'exact' : 'same_home_drift';
    }
    if (isLegacyWorkflowPolicyContext(persisted)
        && expected.allowLegacyPolicyExact
        && persisted.policyId === expected.legacyPolicyId)
        return 'exact';
    return 'owner_unknown_or_mismatch';
}
function policyContextMatches(input, expected) {
    return policyContextDisposition(input, expected) === 'exact';
}
function containsAgentStep(steps) {
    return steps.some((step) => {
        if (step.kind === 'agent')
            return true;
        if (step.kind === 'foreach')
            return containsAgentStep(step.body);
        if (step.kind === 'if') {
            return containsAgentStep(step.then) || containsAgentStep(step.else ?? []);
        }
        return false;
    });
}
function runPolicyContextMatches(state, expected, allowSafeLegacyUnbound) {
    if (state.context.input[POLICY_CONTEXT_KEY] === undefined) {
        return allowSafeLegacyUnbound && !containsAgentStep(state.spec.steps);
    }
    return policyContextMatches(state.context.input, expected);
}
function runPolicyContextDisposition(state, expected, allowSafeLegacyUnbound) {
    if (state.context.input[POLICY_CONTEXT_KEY] === undefined) {
        return allowSafeLegacyUnbound && !containsAgentStep(state.spec.steps)
            ? 'exact'
            : 'owner_unknown_or_mismatch';
    }
    return policyContextDisposition(state.context.input, expected);
}
function resolveWorkflowAssetsDir(options) {
    const env = options.env ?? process.env;
    return resolve(options.assetsDir ?? events.assetsDir(env));
}
function parseExecutionContext(input) {
    const raw = input[EXECUTION_CONTEXT_KEY];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw classified('safety', `workflow input.${EXECUTION_CONTEXT_KEY} is required`);
    }
    const record = raw;
    if (Object.keys(record).some((key) => !EXECUTION_CONTEXT_KEYS.has(key))) {
        throw classified('safety', 'workflow execution context contains unsupported fields');
    }
    const repo = record['repo'];
    if (typeof repo !== 'string' || !isAbsolute(repo) || repo.length === 0 || repo.length > MAX_REPO_PATH_LENGTH || repo.includes('\0') || SECRET_TEXT_RE.test(repo)) {
        throw classified('safety', 'workflow execution repo is invalid');
    }
    const assetId = record['reviewedGeneAssetId'];
    if (typeof assetId !== 'string' || !SAFE_ID_RE.test(assetId) || SECRET_TEXT_RE.test(assetId)) {
        throw classified('safety', 'workflow execution reviewed Gene is invalid');
    }
    const rawSignals = record['signals'];
    if (!Array.isArray(rawSignals) || rawSignals.length === 0 || rawSignals.length > MAX_SIGNALS) {
        throw classified('safety', 'workflow execution signals are required');
    }
    const signals = rawSignals.map((signal) => {
        if (typeof signal !== 'string' || signal.trim().length === 0 || signal.length > MAX_SIGNAL_LENGTH || SECRET_TEXT_RE.test(signal)) {
            throw classified('safety', 'workflow execution signal is invalid');
        }
        return signal.trim();
    });
    const validationProfile = record['validationProfile'];
    if (validationProfile !== undefined && (typeof validationProfile !== 'string' || !PROFILE_NAME_RE.test(validationProfile))) {
        throw classified('safety', 'workflow validation profile is invalid');
    }
    return {
        repo,
        signals,
        reviewedGeneAssetId: assetId,
        ...(typeof validationProfile === 'string' ? { validationProfile } : {}),
    };
}
function canonicalDirectory(path) {
    try {
        const canonical = realpathSync(resolve(path));
        if (!statSync(canonical).isDirectory())
            throw new Error('not a directory');
        return canonical;
    }
    catch {
        throw classified('safety', 'workflow execution repo is unavailable');
    }
}
function isWithinRoot(child, root) {
    return child === root || child.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
function canonicalAllowedRoots(roots) {
    const canonical = [];
    for (const root of roots) {
        const normalized = root.trim();
        if (!isAbsolute(normalized) || normalized.length > MAX_REPO_PATH_LENGTH || normalized.includes('\0'))
            continue;
        try {
            const path = realpathSync(resolve(normalized));
            if (statSync(path).isDirectory())
                canonical.push(path);
        }
        catch {
            // Invalid configured roots stay denied; one stale entry must not disable other valid roots.
        }
    }
    return Object.freeze([...new Set(canonical)].sort());
}
function safeScore(value) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
function diffSummary(result) {
    // #961: snake_case 优先, 兼容读旧 camelCase 存量资产(gitDiffOf).
    const diff = result.proofOfWork?.kind === 'git_diff' ? schema.gitDiffOf(result.proofOfWork) : undefined;
    return {
        changedFiles: Number.isSafeInteger(diff?.files) && (diff?.files ?? -1) >= 0 ? (diff?.files ?? 0) : 0,
        changedLines: Number.isSafeInteger(diff?.lines) && (diff?.lines ?? -1) >= 0 ? (diff?.lines ?? 0) : 0,
    };
}
async function requireReviewedGene(context, store, provenance, review) {
    let gene;
    try {
        gene = await store.get(context.reviewedGeneAssetId);
    }
    catch {
        throw classified('unknown', 'workflow review lookup failed');
    }
    if (gene?.type !== 'Gene' || gene.asset_id !== context.reviewedGeneAssetId) {
        throw classified('safety', 'workflow reviewed Gene is unavailable');
    }
    if (!provenance.isTrusted(context.reviewedGeneAssetId) || !review.isExplicitlyApproved(context.reviewedGeneAssetId)) {
        throw classified('safety', 'workflow reviewed Gene is not trusted and explicitly approved');
    }
    return gene;
}
function workflowMutation(prompt, context) {
    const id = createHash('sha256')
        .update(JSON.stringify([context.repo, context.reviewedGeneAssetId, context.signals, prompt]))
        .digest('hex')
        .slice(0, 24);
    return {
        type: 'Mutation',
        id: `workflow_${id}`,
        category: 'repair',
        trigger_signals: context.signals,
        target: prompt,
        expected_effect: prompt,
        risk_level: 'high',
    };
}
/**
 * Compose the production workflow AgentBridge from the existing hardened execution primitive.
 * The workflow may select only an operator-configured validation profile; raw validation commands are not accepted.
 */
export function createProductionWorkflowAgentBridge(config, options = {}, expectedPolicyContext) {
    const assetsDir = resolveWorkflowAssetsDir(options);
    const allowedRoots = canonicalAllowedRoots(config.allowedRoots);
    const policyContext = expectedPolicyContext
        ?? createWorkflowPolicyContext(resolveWorkflowAutoExecHome(options), assetsDir, config, allowedRoots);
    return createProductionWorkflowAgentBridgeFromSnapshot(config, options, policyContext, allowedRoots);
}
function createProductionWorkflowAgentBridgeFromSnapshot(config, options, policyContext, allowedRoots) {
    const assetsDir = resolveWorkflowAssetsDir(options);
    const store = options.store ?? new assetstore.LocalJsonlProvider(assetsDir);
    const provenance = options.provenance ?? new assetstore.ProvenanceStore(assetsDir);
    const review = options.review ?? new assetstore.ReviewLedger(assetsDir);
    const runValidation = options.runValidation ?? verify.runSandboxedValidation;
    return async (prompt, ctx, bridgeOptions) => {
        if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_LENGTH || SECRET_TEXT_RE.test(prompt)) {
            throw classified('safety', 'workflow agent prompt is invalid');
        }
        if (!policyContextMatches(ctx.input, policyContext)) {
            throw classified('safety', 'workflow policy context does not match the durable run');
        }
        const context = parseExecutionContext(ctx.input);
        const repo = canonicalDirectory(context.repo);
        if (allowedRoots.length === 0 || !allowedRoots.some((root) => isWithinRoot(repo, root))) {
            throw classified('safety', 'workflow execution repo is not allowlisted');
        }
        const gene = await requireReviewedGene(context, store, provenance, review);
        const logicalGeneId = typeof gene['id'] === 'string' && SAFE_ID_RE.test(gene['id'])
            ? gene['id']
            : context.reviewedGeneAssetId;
        const validationCommands = context.validationProfile === undefined
            ? undefined
            : config.workflowValidationProfiles[context.validationProfile];
        if (context.validationProfile !== undefined && validationCommands === undefined) {
            throw classified('safety', 'workflow validation profile is not configured');
        }
        const validate = validationCommands
            ? async (_mutation, _decision, cwd) => {
                const result = await runRequiredSandboxedValidation(validationCommands, cwd, {}, runValidation);
                return { passed: result.passed, score: result.score };
            }
            : undefined;
        let execute;
        let result;
        try {
            execute = exec.makeSafeExecute(repo, store, {
                allowedRoots,
                runner: config.runner,
                timeoutMs: config.timeoutMs,
                scrubEnv: true,
                isolation: 'worktree',
                requireTrustedGene: true,
                ...(bridgeOptions?.signal ? { signal: bridgeOptions.signal } : {}),
            }, {
                provenance,
                review,
                ...(validate ? { validate } : {}),
                ...(validationCommands ? { validationCmds: validationCommands } : {}),
                ...(options.agent ? { agent: options.agent } : {}),
                ...(options.git ? { git: options.git } : {}),
            });
            result = await execute(workflowMutation(prompt.trim(), context), {
                selectedGeneId: logicalGeneId,
                selectedAssetId: context.reviewedGeneAssetId,
                candidates: [],
                weightsVersion: 'workflow-production-v1',
                strategyName: 'workflow-reviewed-gene',
            });
        }
        catch (error) {
            if (error instanceof workflow.ClassifiedWorkflowError)
                throw error;
            const name = error instanceof Error ? error.name : '';
            if (name === 'ExecBridgeForbiddenError'
                || name === 'UnsandboxedFullAccessRequiresIsolationError'
                || name === 'UnsupportedAutonomousClaudeRunnerError'
                || name === 'UnsupportedAutonomousCodexRunnerError'
                || name === 'UnsupportedCursorAutonomousIsolationError') {
                throw classified('safety', 'workflow agent execution was denied by safety policy');
            }
            throw classified('unknown', 'workflow agent execution failed');
        }
        if (result.outcome.status !== 'success') {
            throw classifyWorkflowExecutionFailure(result);
        }
        return {
            status: 'accepted',
            score: safeScore(result.outcome.score),
            ...diffSummary(result),
            validation: validationCommands ? 'passed' : 'not_requested',
        };
    };
}
export function resolveWorkflowMaxConcurrentRuns(env = process.env) {
    const raw = env['EVOLVER_WORKFLOW_MAX_CONCURRENT_RUNS'];
    if (raw === undefined)
        return DEFAULT_MAX_CONCURRENT_RUNS;
    const normalized = raw.trim();
    if (!/^[1-9]\d*$/.test(normalized))
        return DEFAULT_MAX_CONCURRENT_RUNS;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed <= MAX_MAX_CONCURRENT_RUNS
        ? parsed
        : DEFAULT_MAX_CONCURRENT_RUNS;
}
function boundedRecoveryCode(code) {
    return typeof code === 'string' && RECOVERY_CODES.has(code) ? code : 'RECOVERY_FAILED';
}
function emitRecoveryDiagnostic(writeDiagnostic, code) {
    try {
        writeDiagnostic(`[evolver-autoexec] workflow recovery code=${boundedRecoveryCode(code)}\n`);
    }
    catch {
        // Diagnostics are best-effort and must never affect daemon readiness or recovery.
    }
}
class PolicyBoundWorkflowRuntime extends workflow.DurableWorkflowRuntime {
    policyContext;
    allowSafeLegacyUnbound;
    onRecoveryFailure;
    rejectionResumeDepth = new Map();
    constructor(deps, policyContext, allowSafeLegacyUnbound) {
        super(deps);
        this.policyContext = policyContext;
        this.allowSafeLegacyUnbound = allowSafeLegacyUnbound;
        this.onRecoveryFailure = deps.onRecoveryFailure;
    }
    async start(spec, options = {}) {
        const input = spec.input ?? {};
        if (Object.prototype.hasOwnProperty.call(input, POLICY_CONTEXT_KEY)) {
            throw new workflow.WorkflowRuntimeError('workflow policy context is runtime-managed', 'INVALID_STATE');
        }
        return await super.start({
            ...spec,
            input: { ...input, [POLICY_CONTEXT_KEY]: persistedPolicyContext(this.policyContext) },
        }, options);
    }
    async recoverPending() {
        return await this.recoverRuns((runId) => this.preparePolicyRecovery(runId), (runId, error) => { this.reportPolicyRecoveryFailure(runId, error); });
    }
    async resume(runId, options) {
        this.assertRunPolicyContext(runId);
        return await super.resume(runId, options);
    }
    async operatorResume(runId, options) {
        if (!this.isInternalRejectionResume(runId))
            this.assertRunPolicyContext(runId);
        return await super.operatorResume(runId, options);
    }
    async pause(runId, options) {
        return await super.pause(runId, options);
    }
    async cancel(runId, options) {
        return await super.cancel(runId, options);
    }
    async approve(runId, gateId, options) {
        this.assertRunPolicyContext(runId);
        return await super.approve(runId, gateId, options);
    }
    async reject(runId, gateId, options) {
        this.rejectionResumeDepth.set(runId, (this.rejectionResumeDepth.get(runId) ?? 0) + 1);
        try {
            return await super.reject(runId, gateId, options);
        }
        finally {
            const depth = (this.rejectionResumeDepth.get(runId) ?? 1) - 1;
            if (depth === 0)
                this.rejectionResumeDepth.delete(runId);
            else
                this.rejectionResumeDepth.set(runId, depth);
        }
    }
    isInternalRejectionResume(runId) {
        if ((this.rejectionResumeDepth.get(runId) ?? 0) === 0)
            return false;
        const state = this.store.readStored(runId);
        const executionId = state.status === 'waiting_approval' ? state.approval?.executionId : undefined;
        return executionId !== undefined
            && this.store.readControl(runId).approvals[executionId]?.decision === 'rejected';
    }
    assertRunPolicyContext(runId) {
        this.assertStatePolicyContext(this.store.readStored(runId));
    }
    assertStatePolicyContext(state) {
        if (!runPolicyContextMatches(state, this.policyContext, this.allowSafeLegacyUnbound)) {
            throw new workflow.WorkflowRuntimeError('workflow policy context does not match the durable run', 'RUN_NOT_RESUMABLE');
        }
    }
    preparePolicyRecovery(runId) {
        const state = this.store.readStored(runId);
        const control = this.store.readControl(runId);
        if (!this.isRecoveryCandidate(state, control))
            return false;
        const executionId = state.status === 'waiting_approval' ? state.approval?.executionId : undefined;
        const decision = executionId === undefined ? undefined : control.approvals[executionId];
        if (control.cancel || decision?.decision === 'rejected')
            return true;
        const disposition = runPolicyContextDisposition(state, this.policyContext, this.allowSafeLegacyUnbound);
        if (disposition === 'exact')
            return true;
        if (disposition === 'same_home_drift')
            return this.terminalizePolicyDrift(runId);
        throw new workflow.WorkflowRuntimeError('workflow policy owner does not match the durable run', 'RUN_NOT_RESUMABLE');
    }
    terminalizePolicyDrift(runId) {
        this.store.acquireRunLock(runId);
        try {
            const state = this.store.readStored(runId);
            if (['cancelled', 'succeeded', 'failed', 'unsafe_to_resume'].includes(state.status))
                return false;
            if (this.store.readControl(runId).cancel)
                return true;
            const at = new Date().toISOString();
            const history = this.applyPolicyDriftTerminalState(state, at);
            try {
                return this.store.commitUnlessCancelled(state, history) !== undefined;
            }
            catch (error) {
                if (!(error instanceof workflow.WorkflowStateError)
                    || !['RESOURCE_LIMIT', 'CORRUPT_STATE', 'UNSAFE_PATH', 'INSECURE_PERMISSIONS'].includes(error.code)) {
                    throw error;
                }
                return this.store.commitUnlessCancelled(state, []) !== undefined;
            }
        }
        finally {
            this.store.releaseRunLock(runId);
        }
    }
    applyPolicyDriftTerminalState(state, at) {
        const current = state.currentStep ? state.steps[state.currentStep] : undefined;
        if (current?.status === 'running' && current.idempotency === 'non_idempotent') {
            current.status = 'failed';
            current.lastErrorClass = 'interrupted_non_idempotent';
            current.completedAt = at;
            state.status = 'unsafe_to_resume';
            state.lastErrorClass = 'interrupted_non_idempotent';
            state.completedAt = at;
            state.updatedAt = at;
            delete state.approval;
            return [{
                    runId: state.runId, workflowId: state.workflowId, type: 'unsafe_to_resume',
                    status: state.status, at, executionId: current.executionId, stepId: current.stepId,
                    errorClass: 'interrupted_non_idempotent',
                }];
        }
        const history = [];
        if (current && current.status !== 'succeeded' && current.status !== 'failed') {
            current.status = 'failed';
            current.lastErrorClass = 'safety';
            current.completedAt = at;
            history.push({
                runId: state.runId, workflowId: state.workflowId, type: 'step_failed',
                status: 'failed', at, executionId: current.executionId, stepId: current.stepId,
                errorClass: 'safety',
            });
        }
        state.status = 'failed';
        state.lastErrorClass = 'safety';
        state.completedAt = at;
        state.updatedAt = at;
        delete state.approval;
        history.push({
            runId: state.runId, workflowId: state.workflowId, type: 'run_failed',
            status: state.status, at, errorClass: 'safety',
        });
        return history;
    }
    reportPolicyRecoveryFailure(runId, error) {
        try {
            this.onRecoveryFailure?.({
                runId,
                code: error instanceof workflow.WorkflowStateError
                    ? error.code
                    : error instanceof workflow.WorkflowRunFailedError
                        ? 'RUN_FAILED'
                        : 'RECOVERY_FAILED',
            });
        }
        catch {
            // Startup recovery diagnostics are best-effort and must not block other runs.
        }
    }
}
/** Create the shared production runtime used by CLI commands and daemon recovery. */
export function createProductionWorkflowRuntime(options = {}) {
    const env = options.env ?? process.env;
    const writeDiagnostic = options.writeDiagnostic ?? ((message) => { process.stderr.write(message); });
    const configuredStateDir = env['EVOLVER_WORKFLOW_STATE_DIR']?.trim();
    const stateDir = resolve(options.stateDir ?? (configuredStateDir || workflow.defaultWorkflowStateDir()));
    const autoExecHome = resolveWorkflowAutoExecHome({ ...options, env });
    const assetsDir = resolveWorkflowAssetsDir({ ...options, env });
    const config = options.autoExecConfig ?? readAutoExecConfig(autoExecHome);
    const allowedRoots = canonicalAllowedRoots(config.allowedRoots);
    const policyContext = createWorkflowPolicyContext(autoExecHome, assetsDir, config, allowedRoots);
    const runtimeOptions = { ...options, env, stateDir, autoExecHome, assetsDir };
    const agent = createProductionWorkflowAgentBridgeFromSnapshot(config, runtimeOptions, policyContext, allowedRoots);
    const allowSafeLegacyUnbound = canonicalPolicyHome(autoExecHome)
        === canonicalPolicyHome(defaultWorkflowAutoExecHome(env));
    const deps = {
        agent,
        stateDir,
        maxConcurrentRuns: resolveWorkflowMaxConcurrentRuns(env),
        ...(options.maxQueuedRuns !== undefined ? { maxQueuedRuns: options.maxQueuedRuns } : {}),
        onRecoveryFailure: ({ code }) => { emitRecoveryDiagnostic(writeDiagnostic, code); },
    };
    return new PolicyBoundWorkflowRuntime(deps, policyContext, allowSafeLegacyUnbound);
}
/**
 * Start recovery exactly once without awaiting it. A hung workflow may occupy a scheduler slot, but it cannot delay
 * construction of the resident loop or daemon readiness.
 */
export function scheduleWorkflowStartupRecovery(runtime, writeDiagnostic = (message) => { process.stderr.write(message); }) {
    void Promise.resolve()
        .then(async () => { await runtime.recoverPending(); })
        .catch(() => { emitRecoveryDiagnostic(writeDiagnostic, 'RECOVERY_FAILED'); });
}
/**
 * Initialize daemon startup recovery without making workflow state availability a prerequisite for autoexec.
 * Runtime construction can fail on corrupt state, insecure permissions, or concurrent access; those failures are
 * reported as a bounded code while the independent task queue remains available.
 */
export function initializeWorkflowStartupRecovery(options, dependencies = {}) {
    const writeDiagnostic = dependencies.writeDiagnostic
        ?? options.writeDiagnostic
        ?? ((message) => { process.stderr.write(message); });
    try {
        const runtime = (dependencies.createRuntime ?? createProductionWorkflowRuntime)({
            ...options,
            writeDiagnostic,
        });
        (dependencies.scheduleRecovery ?? scheduleWorkflowStartupRecovery)(runtime, writeDiagnostic);
        return true;
    }
    catch {
        emitRecoveryDiagnostic(writeDiagnostic, 'RECOVERY_INIT_FAILED');
        return false;
    }
}