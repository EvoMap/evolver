import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DEFAULT_HOOK_COMMAND, DEFAULT_PROMPT_RECALL_HOOK_COMMAND, installInjection, uninstallInjection, } from '@evomap/evolver-mcp';
export const SETUP_LIFECYCLE_SCHEMA = 'evolver.setup_hooks.lifecycle.v1';
export const SETUP_LIFECYCLE_PLAN_TTL_MS = 120_000;
export class SetupLifecycleError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SetupLifecycleError';
    }
}
export function setupLifecycleCapabilities(runtime, scope) {
    const supported = runtime === 'claude-code' || runtime === 'codex';
    return {
        schema: SETUP_LIFECYCLE_SCHEMA,
        runtime,
        scope,
        supported,
        operations: {
            plan: supported,
            verify: supported,
            install: supported,
            uninstall: supported,
        },
    };
}
function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return value.map(canonicalJson);
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
            .map(([key, entry]) => [key, canonicalJson(entry)]);
        return Object.fromEntries(entries);
    }
    return value;
}
function lifecycleIntentDigest(context, action) {
    const options = context.installOptions;
    const targetResolution = {
        configRoot: context.configRoot,
        scope: context.scope,
        homeDir: options.homeDir,
        codexHome: options.codexHome,
        kiroHome: options.kiroHome,
        xdgConfigHome: options.xdgConfigHome,
        opencodeConfig: options.opencodeConfig,
        opencodeConfigDir: options.opencodeConfigDir,
    };
    const intent = action === 'install'
        ? {
            action,
            runtime: context.runtime,
            scope: context.scope,
            targetResolution,
            injectionPlan: {
                runtime: context.injectionPlan.runtime,
                mode: context.injectionPlan.mode,
                config: context.injectionPlan.config,
            },
            install: {
                server: options.server,
                productBridgeNodePath: options.productBridgeNodePath ?? process.execPath,
                hookCommand: options.hookCommand ?? DEFAULT_HOOK_COMMAND,
                promptRecallHookCommand: options.promptRecallHookCommand ?? DEFAULT_PROMPT_RECALL_HOOK_COMMAND,
                force: options.force === true,
                genes: options.genes,
                maxGenes: options.maxGenes,
                opencodeConfigContent: options.opencodeConfigContent,
                opencodeDisableProjectConfig: options.opencodeDisableProjectConfig,
                opencodeManagedConfigDir: options.opencodeManagedConfigDir,
                opencodeManagedPreferencePaths: options.opencodeManagedPreferencePaths,
                opencodePlatform: options.opencodePlatform,
                opencodeProgramData: options.opencodeProgramData,
                opencodeUsername: options.opencodeUsername,
            },
        }
        : { action, runtime: context.runtime, scope: context.scope, targetResolution };
    return digest(JSON.stringify(canonicalJson(intent)));
}
function fileIdentity(path) {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink())
            return digest(`symlink:${path}`);
        if (!stat.isFile())
            return digest(`non-file:${path}:${stat.mode}`);
        return digest(Buffer.concat([
            Buffer.from(`file:${path}:${stat.mode}:`),
            readFileSync(path),
        ]));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return digest(`absent:${path}`);
        throw error;
    }
}
function displayTarget(path, context) {
    const base = context.scope === 'user' ? context.installOptions.homeDir ?? homedir() : context.configRoot;
    const candidate = relative(base, path);
    if (!isAbsolute(candidate) && candidate !== '..' && !candidate.startsWith(`..${sep}`)) {
        return context.scope === 'user' ? `~/${candidate.replaceAll('\\', '/')}` : candidate.replaceAll('\\', '/');
    }
    return `<managed:${context.runtime}:${context.scope}>`;
}
function planResult(context, action) {
    if (action === 'install') {
        return installInjection(context.injectionPlan, { ...context.installOptions, dryRun: true });
    }
    return uninstallInjection(context.runtime, {
        configRoot: context.configRoot,
        scope: context.scope,
        homeDir: context.installOptions.homeDir,
        codexHome: context.installOptions.codexHome,
        kiroHome: context.installOptions.kiroHome,
        xdgConfigHome: context.installOptions.xdgConfigHome,
        opencodeConfig: context.installOptions.opencodeConfig,
        opencodeConfigDir: context.installOptions.opencodeConfigDir,
        dryRun: true,
    });
}
function planForTimes(context, action, createdAt, expiresAt) {
    const capabilities = setupLifecycleCapabilities(context.runtime, context.scope);
    if (!capabilities.supported || !capabilities.operations[action]) {
        throw new SetupLifecycleError('CAPABILITY_UNAVAILABLE', `lifecycle ${action} is unavailable for ${context.runtime}/${context.scope}`);
    }
    const dryRun = planResult(context, action);
    if (!dryRun.ok)
        throw new SetupLifecycleError('PLAN_INVALID', dryRun.error ?? 'lifecycle plan failed');
    const files = [...new Set(dryRun.files.map((path) => resolve(path)))].sort();
    const targets = files.map((path) => {
        const expectedIdentity = fileIdentity(path);
        return {
            target_id: digest(`${context.runtime}\0${context.scope}\0${path}`).slice(0, 32),
            target_ref: displayTarget(path, context),
            expected_identity: expectedIdentity,
            disposition: action === 'install' ? 'installable' : 'removable',
            impact_hints: action === 'uninstall' ? ['new_sessions_required'] : [],
        };
    });
    if (targets.length === 0) {
        targets.push({
            target_id: digest(`${context.runtime}\0${context.scope}\0already-satisfied`).slice(0, 32),
            target_ref: `${context.runtime}:${context.scope}`,
            expected_identity: digest('already-satisfied'),
            disposition: 'already_satisfied',
            impact_hints: [],
        });
    }
    const intentDigest = lifecycleIntentDigest(context, action);
    const generation = digest(JSON.stringify([intentDigest, targets.map(({ target_id, expected_identity }) => [target_id, expected_identity])]));
    const targetSetDigest = digest(JSON.stringify(targets.map(({ target_id }) => target_id)));
    const base = {
        schema: SETUP_LIFECYCLE_SCHEMA,
        generation,
        target_set_digest: targetSetDigest,
        intent_digest: intentDigest,
        created_at: createdAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        action,
        runtime: context.runtime,
        scope: context.scope,
        targets,
    };
    return { ...base, plan_id: digest(JSON.stringify(base)) };
}
export function createSetupLifecyclePlan(context, action) {
    const createdAt = (context.now ?? (() => new Date()))();
    return planForTimes(context, action, createdAt, new Date(createdAt.getTime() + SETUP_LIFECYCLE_PLAN_TTL_MS));
}
export function encodeSetupLifecyclePlan(plan) {
    return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}
export function decodeSetupLifecyclePlan(raw) {
    let value;
    try {
        value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    }
    catch {
        throw new SetupLifecycleError('PLAN_INVALID', 'confirmed lifecycle plan is not valid base64url JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SetupLifecycleError('PLAN_INVALID', 'confirmed lifecycle plan must be an object');
    }
    const plan = value;
    const targetsValid = Array.isArray(plan.targets) && plan.targets.every((target) => target !== null
        && typeof target === 'object'
        && typeof target.target_id === 'string'
        && typeof target.target_ref === 'string'
        && typeof target.expected_identity === 'string'
        && ['installable', 'removable', 'already_satisfied'].includes(target.disposition)
        && Array.isArray(target.impact_hints)
        && target.impact_hints.every((hint) => typeof hint === 'string'));
    if (plan.schema !== SETUP_LIFECYCLE_SCHEMA
        || typeof plan.plan_id !== 'string'
        || typeof plan.generation !== 'string'
        || typeof plan.target_set_digest !== 'string'
        || typeof plan.intent_digest !== 'string'
        || typeof plan.created_at !== 'string'
        || typeof plan.expires_at !== 'string'
        || (plan.action !== 'install' && plan.action !== 'uninstall')
        || typeof plan.runtime !== 'string'
        || (plan.scope !== 'project' && plan.scope !== 'user')
        || !targetsValid) {
        throw new SetupLifecycleError('PLAN_INVALID', 'confirmed lifecycle plan has an invalid schema');
    }
    return plan;
}
export function verifySetupLifecycle(context) {
    const result = installInjection(context.injectionPlan, { ...context.installOptions, dryRun: true });
    return result.ok && result.alreadyInstalled === true && result.verified === true && result.files.length === 0;
}
export function executeSetupLifecyclePlan(context, confirmed, options = {}) {
    if (confirmed.runtime !== context.runtime || confirmed.scope !== context.scope) {
        throw new SetupLifecycleError('PLAN_INVALID', 'confirmed lifecycle plan does not match runtime scope');
    }
    const { plan_id: confirmedPlanID, ...confirmedBase } = confirmed;
    if (digest(JSON.stringify(confirmedBase)) !== confirmedPlanID) {
        throw new SetupLifecycleError('PLAN_INVALID', 'confirmed lifecycle plan identity is invalid');
    }
    if (lifecycleIntentDigest(context, confirmed.action) !== confirmed.intent_digest) {
        throw new SetupLifecycleError('PLAN_STALE', 'lifecycle write intent changed; create a fresh plan');
    }
    const now = (context.now ?? (() => new Date()))();
    const createdAt = new Date(confirmed.created_at);
    const expiresAt = new Date(confirmed.expires_at);
    if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(expiresAt.getTime())) {
        throw new SetupLifecycleError('PLAN_INVALID', 'confirmed lifecycle plan has invalid timestamps');
    }
    const continuingTargetExecution = options.targetId !== undefined && (options.completedTargetIds?.length ?? 0) > 0;
    if (now.getTime() > expiresAt.getTime() && !continuingTargetExecution) {
        throw new SetupLifecycleError('PLAN_EXPIRED', 'confirmed lifecycle plan expired; create a fresh plan');
    }
    if (options.targetId !== undefined) {
        return executeSetupLifecycleTarget(context, confirmed, options.targetId, options.completedTargetIds ?? [], createdAt, expiresAt);
    }
    const current = planForTimes(context, confirmed.action, createdAt, expiresAt);
    const sameTargets = JSON.stringify(current.targets.map((target) => target.target_id))
        === JSON.stringify(confirmed.targets.map((target) => target.target_id));
    if (current.plan_id !== confirmed.plan_id
        || current.generation !== confirmed.generation
        || current.target_set_digest !== confirmed.target_set_digest
        || !sameTargets) {
        throw new SetupLifecycleError('PLAN_STALE', 'lifecycle target identity changed; create a fresh plan');
    }
    let result;
    let executionFailed = false;
    try {
        result = confirmed.action === 'install'
            ? installInjection(context.injectionPlan, context.installOptions)
            : uninstallInjection(context.runtime, {
                configRoot: context.configRoot,
                scope: context.scope,
                homeDir: context.installOptions.homeDir,
                codexHome: context.installOptions.codexHome,
                kiroHome: context.installOptions.kiroHome,
                xdgConfigHome: context.installOptions.xdgConfigHome,
                opencodeConfig: context.installOptions.opencodeConfig,
                opencodeConfigDir: context.installOptions.opencodeConfigDir,
            });
        executionFailed = !result.ok;
    }
    catch {
        executionFailed = true;
    }
    let verified = false;
    if (!executionFailed) {
        try {
            verified = confirmed.action === 'install'
                ? verifySetupLifecycle(context)
                : planResult(context, 'uninstall').files.length === 0;
        }
        catch {
            executionFailed = true;
        }
    }
    const targets = confirmed.targets.map((target) => {
        const path = resolveTargetRef(target, context);
        const committed = path !== '' && fileIdentity(path) !== target.expected_identity;
        const targetVerified = !executionFailed && verified;
        return {
            target_id: target.target_id,
            outcome: target.disposition === 'already_satisfied' || !committed && targetVerified
                ? confirmed.action === 'uninstall' ? 'already_absent' : 'already_satisfied'
                : committed
                    ? confirmed.action === 'install' ? 'installed' : 'removed'
                    : 'failed',
            committed,
            verified: targetVerified,
            ...(!targetVerified ? { recovery: committed ? 'RETRY_VERIFICATION' : 'OPEN_CONFIG' } : {}),
        };
    });
    return {
        schema: SETUP_LIFECYCLE_SCHEMA,
        action: confirmed.action,
        runtime: context.runtime,
        scope: context.scope,
        plan_id: confirmed.plan_id,
        generation: confirmed.generation,
        target_set_digest: confirmed.target_set_digest,
        complete: verified,
        verified,
        targets,
    };
}
function executeSetupLifecycleTarget(context, confirmed, targetId, completedTargetIds, createdAt, expiresAt) {
    const selected = confirmed.targets.find((target) => target.target_id === targetId);
    if (!selected)
        throw new SetupLifecycleError('PLAN_INVALID', 'selected lifecycle target is not in the confirmed plan');
    const confirmedIds = new Set(confirmed.targets.map((target) => target.target_id));
    const completed = new Set(completedTargetIds);
    if (completed.size !== completedTargetIds.length || completed.has(targetId) || [...completed].some((id) => !confirmedIds.has(id))) {
        throw new SetupLifecycleError('PLAN_INVALID', 'completed lifecycle target set is invalid');
    }
    const current = planForTimes(context, confirmed.action, createdAt, expiresAt);
    const currentTargets = current.targets.filter((target) => target.disposition !== 'already_satisfied');
    const currentByID = new Map(currentTargets.map((target) => [target.target_id, target]));
    if (currentTargets.some((target) => !confirmedIds.has(target.target_id))) {
        throw new SetupLifecycleError('PLAN_STALE', 'lifecycle target set changed; create a fresh plan');
    }
    if (selected.disposition === 'already_satisfied') {
        return {
            schema: SETUP_LIFECYCLE_SCHEMA,
            action: confirmed.action,
            runtime: context.runtime,
            scope: context.scope,
            plan_id: confirmed.plan_id,
            generation: confirmed.generation,
            target_set_digest: confirmed.target_set_digest,
            complete: true,
            verified: true,
            targets: [{
                    target_id: targetId,
                    outcome: confirmed.action === 'uninstall' ? 'already_absent' : 'already_satisfied',
                    committed: false,
                    verified: true,
                }],
        };
    }
    for (const target of confirmed.targets) {
        if (target.disposition === 'already_satisfied')
            continue;
        const currentTarget = currentByID.get(target.target_id);
        if (completed.has(target.target_id)) {
            if (currentTarget)
                throw new SetupLifecycleError('PLAN_STALE', 'a completed lifecycle target is no longer verified');
            continue;
        }
        if (target.target_id === targetId) {
            if (currentTarget && currentTarget.expected_identity !== target.expected_identity) {
                throw new SetupLifecycleError('PLAN_STALE', 'selected lifecycle target identity changed');
            }
            continue;
        }
        if (!currentTarget || currentTarget.expected_identity !== target.expected_identity) {
            throw new SetupLifecycleError('PLAN_STALE', 'a pending lifecycle target identity changed');
        }
    }
    const targetPath = resolveTargetRef(selected, context);
    const alreadyApplied = !currentByID.has(targetId);
    if (alreadyApplied) {
        return {
            schema: SETUP_LIFECYCLE_SCHEMA,
            action: confirmed.action,
            runtime: context.runtime,
            scope: context.scope,
            plan_id: confirmed.plan_id,
            generation: confirmed.generation,
            target_set_digest: confirmed.target_set_digest,
            complete: true,
            verified: true,
            targets: [{
                    target_id: targetId,
                    outcome: confirmed.action === 'uninstall' ? 'already_absent' : 'already_satisfied',
                    committed: false,
                    verified: true,
                }],
        };
    }
    let executionFailed = false;
    try {
        const result = confirmed.action === 'install'
            ? installInjection(context.injectionPlan, { ...context.installOptions, targetPath })
            : uninstallInjection(context.runtime, {
                configRoot: context.configRoot,
                scope: context.scope,
                homeDir: context.installOptions.homeDir,
                codexHome: context.installOptions.codexHome,
                kiroHome: context.installOptions.kiroHome,
                xdgConfigHome: context.installOptions.xdgConfigHome,
                opencodeConfig: context.installOptions.opencodeConfig,
                opencodeConfigDir: context.installOptions.opencodeConfigDir,
                targetPath,
            });
        executionFailed = !result.ok;
    }
    catch {
        executionFailed = true;
    }
    let verified = false;
    try {
        const after = planForTimes(context, confirmed.action, createdAt, expiresAt);
        verified = !after.targets.some((target) => target.target_id === targetId);
    }
    catch {
        executionFailed = true;
    }
    const committed = targetPath !== '' && fileIdentity(targetPath) !== selected.expected_identity;
    const targetVerified = !executionFailed && verified;
    const outcome = targetVerified
        ? confirmed.action === 'install' ? 'installed' : 'removed'
        : 'failed';
    return {
        schema: SETUP_LIFECYCLE_SCHEMA,
        action: confirmed.action,
        runtime: context.runtime,
        scope: context.scope,
        plan_id: confirmed.plan_id,
        generation: confirmed.generation,
        target_set_digest: confirmed.target_set_digest,
        complete: targetVerified,
        verified: targetVerified,
        targets: [{
                target_id: targetId,
                outcome,
                committed,
                verified: targetVerified,
                ...(!targetVerified ? { recovery: committed ? 'RETRY_VERIFICATION' : 'OPEN_CONFIG' } : {}),
            }],
    };
}
function resolveTargetRef(target, context) {
    if (target.disposition === 'already_satisfied' || target.target_ref.startsWith('<managed:'))
        return '';
    if (target.target_ref.startsWith('~/')) {
        return resolve(context.installOptions.homeDir ?? homedir(), target.target_ref.slice(2));
    }
    return resolve(context.configRoot, target.target_ref);
}