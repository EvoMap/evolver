import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DEFAULT_HOOK_COMMAND, DEFAULT_PROMPT_RECALL_HOOK_COMMAND, claudeCodeTargets, codexConfigTarget, installInjection, uninstallInjection, resolveInstallComponents, cursorRulesPath, resolveAntigravityConfigTargets, resolveOpenCodeConfig, resolveKiroConfig, } from '@evomap/evolver-mcp';
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
    const supported = ['claude-code', 'codex', 'cursor', 'antigravity', 'opencode', 'kiro'].includes(runtime)
        && (runtime !== 'cursor' || scope === 'project')
        && (runtime !== 'antigravity' || scope === 'user');
    return {
        schema: SETUP_LIFECYCLE_SCHEMA,
        runtime,
        scope,
        supported,
        hookCommandsBound: runtime === 'claude-code' || runtime === 'codex',
        standaloneMcp: true,
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
    const options = lifecycleInstallOptions(context);
    const targetResolution = {
        components: resolveInstallComponents(options.components),
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
function lifecycleInstallOptions(context) {
    return { ...context.installOptions, configRoot: context.configRoot, scope: context.scope };
}
function planResult(context, action) {
    const options = { ...lifecycleInstallOptions(context), dryRun: true };
    return action === 'install' ? installInjection(context.injectionPlan, options) : uninstallInjection(context.runtime, options);
}
function applyLifecycleMutation(context, action, targetPath) {
    const options = { ...lifecycleInstallOptions(context), ...(targetPath === undefined ? {} : { targetPath }) };
    return action === 'install'
        ? installInjection(context.injectionPlan, options)
        : uninstallInjection(context.runtime, options);
}
function applyConfirmedTargets(context, plan, paths) {
    const files = [];
    for (const target of plan.targets) {
        if (target.disposition === 'already_satisfied')
            continue;
        const path = paths.get(target.target_id);
        if (!path)
            throw new SetupLifecycleError('PLAN_STALE', 'confirmed target is no longer resolved');
        const result = applyLifecycleMutation(context, plan.action, path);
        files.push(...result.files);
        if (!result.ok)
            return { ...result, files };
    }
    return { ok: true, runtime: context.runtime, mode: context.injectionPlan.mode, files };
}
function lifecycleConfigPaths(context) {
    const options = lifecycleInstallOptions(context);
    switch (context.runtime) {
        case 'claude-code': {
            const targets = claudeCodeTargets(context.scope, context.configRoot, options.homeDir);
            return [targets.mcpConfigPath, ...(resolveInstallComponents(options.components) === 'product-only' ? [] : [targets.settingsPath])];
        }
        case 'codex': return [codexConfigTarget(options).configPath];
        case 'cursor': return [cursorRulesPath(context.configRoot)];
        case 'antigravity': return resolveAntigravityConfigTargets(options.homeDir).map((target) => target.configPath);
        case 'opencode': return [resolveOpenCodeConfig(options).configPath];
        case 'kiro': return [resolveKiroConfig(options).configPath];
    }
}
function planForTimes(context, action, createdAt, expiresAt, resolvedPaths) {
    const capabilities = setupLifecycleCapabilities(context.runtime, context.scope);
    if (!capabilities.supported || !capabilities.operations[action]) {
        throw new SetupLifecycleError('CAPABILITY_UNAVAILABLE', `lifecycle ${action} is unavailable for ${context.runtime}/${context.scope}`);
    }
    const dryRun = planResult(context, action);
    if (!dryRun.ok)
        throw new SetupLifecycleError('PLAN_INVALID', dryRun.error ?? 'lifecycle plan failed');
    if (resolvedPaths) {
        const paths = [...lifecycleConfigPaths(context), ...dryRun.files];
        for (const path of paths.map((path) => resolve(path))) {
            resolvedPaths.set(digest(`${context.runtime}\0${context.scope}\0${path}`).slice(0, 32), path);
        }
    }
    const files = [...new Set(dryRun.files.map((path) => resolve(path)))].sort();
    const targets = files.map((path) => {
        const expectedIdentity = fileIdentity(path);
        const targetId = digest(`${context.runtime}\0${context.scope}\0${path}`).slice(0, 32);
        return {
            target_id: targetId,
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
    const result = installInjection(context.injectionPlan, { ...lifecycleInstallOptions(context), dryRun: true });
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
    const resolvedPaths = new Map();
    const current = planForTimes(context, confirmed.action, createdAt, expiresAt, resolvedPaths);
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
        result = context.runtime === 'claude-code' || context.runtime === 'codex'
            ? applyLifecycleMutation(context, confirmed.action)
            : applyConfirmedTargets(context, confirmed, resolvedPaths);
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
        const path = resolvedPaths.get(target.target_id);
        const committed = path !== undefined && fileIdentity(path) !== target.expected_identity;
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
    const resolvedPaths = new Map();
    const current = planForTimes(context, confirmed.action, createdAt, expiresAt, resolvedPaths);
    const currentTargets = current.targets.filter((target) => target.disposition !== 'already_satisfied');
    const currentByID = new Map(currentTargets.map((target) => [target.target_id, target]));
    if (currentTargets.some((target) => !confirmedIds.has(target.target_id))) {
        throw new SetupLifecycleError('PLAN_STALE', 'lifecycle target set changed; create a fresh plan');
    }
    const currentSelected = currentByID.get(targetId);
    if (currentSelected && (currentSelected.target_ref !== selected.target_ref || currentSelected.disposition !== selected.disposition)) {
        throw new SetupLifecycleError('PLAN_STALE', 'selected lifecycle target metadata changed');
    }
    if (selected.disposition === 'already_satisfied') {
        if (current.plan_id !== confirmed.plan_id)
            throw new SetupLifecycleError('PLAN_STALE', 'no-op lifecycle plan changed');
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
    const targetPath = resolvedPaths.get(targetId);
    if (targetPath === undefined
        || displayTarget(targetPath, context) !== selected.target_ref
        || selected.disposition !== (confirmed.action === 'install' ? 'installable' : 'removable')) {
        throw new SetupLifecycleError('PLAN_STALE', 'selected lifecycle target is not owned by this operation');
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
        const result = applyLifecycleMutation(context, confirmed.action, targetPath);
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
    const committed = fileIdentity(targetPath) !== selected.expected_identity;
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