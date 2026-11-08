import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DEFAULT_HOOK_COMMAND, DEFAULT_PROMPT_RECALL_HOOK_COMMAND, claudeCodeTargets, codexConfigTarget, installInjection, uninstallInjection, resolveInstallComponents, cursorRulesPath, resolveAntigravityConfigTargets, resolveOpenCodeConfig, resolveKiroConfig, readSharedFileSnapshot, INSTALLER_TRANSACTION_SCHEMA, } from '@evomap/evolver-mcp';
import { executeSetupTransaction, recoverSetupTransaction } from './setupHooksTransaction.js';
export { inspectSetupTransactions } from './setupHooksTransaction.js';
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
        transactions: { schema: INSTALLER_TRANSACTION_SCHEMA, durable: supported, atomicVisibility: false, recovery: supported },
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
        configRoot: resolve(context.configRoot),
        scope: context.scope,
        homeDir: resolve(options.homeDir ?? homedir()),
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
    return digest(JSON.stringify([path, readSharedFileSnapshot(path).identity]));
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
        const paths = [...lifecycleConfigPaths(context), ...dryRun.files, ...(dryRun.backups ?? []).map(path => path.replace(/\.evolver-backup\.json$/, ''))];
        for (const path of paths.map((path) => resolve(path))) {
            resolvedPaths.set(digest(`${context.runtime}\0${context.scope}\0${path}`).slice(0, 32), path);
        }
    }
    const files = [...new Set([...dryRun.files, ...(dryRun.backups ?? []).map(path => path.replace(/\.evolver-backup\.json$/, ''))].map((path) => resolve(path)))].sort();
    const targets = files.map((path) => {
        const backups = (dryRun.backups ?? []).filter(backup => resolve(backup) === `${path}.evolver-backup.json`);
        const expectedIdentity = digest(JSON.stringify([fileIdentity(path), ...backups.map(fileIdentity)]));
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
const transactionDriver = {
    intent: lifecycleIntentDigest, plan: planForTimes, preview: planResult, apply: applyLifecycleMutation, verify: verifySetupLifecycle,
};
export function executeSetupLifecyclePlan(context, confirmed, options = {}) {
    return executeSetupTransaction(context, confirmed, options, transactionDriver);
}
export function recoverSetupLifecycle(context, id, recovery, confirmedState) {
    return recoverSetupTransaction(context, id, recovery, transactionDriver, confirmedState);
}