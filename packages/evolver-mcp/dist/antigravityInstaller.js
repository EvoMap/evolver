import { lstatSync, readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { installJsonMcpRuntime, uninstallJsonMcpRuntime } from './jsonMcpInstaller.js';
import { runManagedInstallerTransaction } from './installerRuntimeTransaction.js';
import { EmptySharedConfigError, SymlinkRefusedError, UnparseableConfigError, } from './installerShared.js';
import { sameRuntimePath } from './runtimePathIdentity.js';
const ENV_FILE_KEY = 'EVOLVER_ENV_FILE';
const CONFIG_FILE = 'mcp_config.json';
export const ANTIGRAVITY_NAMESPACES = ['antigravity', 'antigravity-ide'];
export class AntigravityConfigShapeError extends Error {
    constructor(path, detail) {
        super(`[setup-hooks] refusing to overwrite Antigravity MCP config (${path}): ${detail}. Fix the shared config, then rerun.`);
        this.name = 'AntigravityConfigShapeError';
    }
}
export class AntigravityPathTypeError extends Error {
    constructor(label, path) {
        super(`[setup-hooks] refusing to operate: ${label} (${path}) exists but is not a directory.`);
        this.name = 'AntigravityPathTypeError';
    }
}
export class AntigravitySecretRefusedError extends Error {
    constructor(detail) {
        super(`[setup-hooks] refusing to write Antigravity MCP config: ${detail}; use only an ${ENV_FILE_KEY} pointer to a credential file.`);
        this.name = 'AntigravitySecretRefusedError';
    }
}
const isObj = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function lstatIfExists(path) {
    try {
        return lstatSync(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
function assertDirectoryOrMissing(path, label) {
    const stat = lstatIfExists(path);
    if (stat === undefined)
        return false;
    if (stat.isSymbolicLink())
        throw new SymlinkRefusedError(label, path);
    if (!stat.isDirectory())
        throw new AntigravityPathTypeError(label, path);
    return true;
}
function assertFileNotSymlink(path, label) {
    const stat = lstatIfExists(path);
    if (stat?.isSymbolicLink())
        throw new SymlinkRefusedError(label, path);
}
/**
 * Resolve Antigravity's user-level config targets. Every existing runtime root is targeted. If neither namespace
 * exists, installation falls back to the canonical ~/.gemini/antigravity root. This function never creates paths.
 */
export function resolveAntigravityConfigTargets(homeDir = osHomedir()) {
    assertDirectoryOrMissing(homeDir, 'home directory');
    const geminiRoot = join(homeDir, '.gemini');
    assertDirectoryOrMissing(geminiRoot, '~/.gemini');
    const candidates = ANTIGRAVITY_NAMESPACES.map((namespace) => {
        const root = join(geminiRoot, namespace);
        return { namespace, root, configPath: join(root, CONFIG_FILE) };
    });
    const existing = candidates.filter((target) => assertDirectoryOrMissing(target.root, `~/.gemini/${target.namespace}`));
    const targets = existing.length > 0 ? existing : [candidates[0]];
    for (const target of targets) {
        assertFileNotSymlink(target.configPath, `~/.gemini/${target.namespace}/${CONFIG_FILE}`);
    }
    return targets;
}
function validateConfigShape(data, path) {
    const mcpServers = data['mcpServers'];
    if (mcpServers !== undefined && !isObj(mcpServers)) {
        throw new AntigravityConfigShapeError(path, 'mcpServers must be a JSON object');
    }
}
function readStrictSnapshot(path) {
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { data: {}, raw: null };
        throw error;
    }
    const trimmed = raw.trim();
    if (!trimmed)
        throw new EmptySharedConfigError('Antigravity MCP config', path, 'Antigravity');
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        throw new UnparseableConfigError('Antigravity MCP config', path, 'Antigravity');
    }
    if (!isObj(parsed)) {
        throw new AntigravityConfigShapeError(path, 'the top-level JSON value must be an object');
    }
    validateConfigShape(parsed, path);
    return { data: parsed, raw };
}
const SECRET_FLAG_RE = /(?:^|\s)--?(?:api[-_]?key|password|passwd|secret|token)(?:=|\s+)/i;
const SECRET_ASSIGNMENT_RE = /\b(?:A2A_NODE_SECRET|EVOMAP_ENTERPRISE_TOKEN|EVOMAP_PRIVATE_HUB_TOKEN|EVOMAP_NODE_SECRET|EVOLVER_IPC_TOKEN|EVOLVER_LLM_TOKEN|PHUB_ENTERPRISE_TOKEN|PRIVATE_HUB_ENTERPRISE_TOKEN)\b\s*=/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i;
function looksLikeEnvFilePointer(value) {
    return /[\\/]/.test(value)
        || /^[.~$%]/.test(value)
        || /\.(?:env|dotenv)(?:$|[._-])/i.test(value);
}
function validateServer(server) {
    const commandLine = [server.command, ...(server.args ?? [])].join(' ');
    if (SECRET_FLAG_RE.test(commandLine) || SECRET_ASSIGNMENT_RE.test(commandLine) || BEARER_RE.test(commandLine)) {
        throw new AntigravitySecretRefusedError('the MCP command or args contain an inline secret-looking value');
    }
    if (server.env === undefined || Object.keys(server.env).length === 0)
        return;
    const keys = Object.keys(server.env);
    if (keys.some((key) => key !== ENV_FILE_KEY)) {
        throw new AntigravitySecretRefusedError(`env may contain only ${ENV_FILE_KEY}`);
    }
    const pointer = server.env[ENV_FILE_KEY]?.trim();
    if (!pointer || !looksLikeEnvFilePointer(pointer)) {
        throw new AntigravitySecretRefusedError(`${ENV_FILE_KEY} must contain a file path, not a credential value`);
    }
}
export function antigravityMcpServerEntry(server) {
    validateServer(server);
    const pointer = server.env?.[ENV_FILE_KEY]?.trim();
    return {
        command: server.command,
        args: server.args ?? [],
        ...(pointer ? { env: { [ENV_FILE_KEY]: pointer } } : {}),
    };
}
export function mergeAntigravityConfig(current, serverEntry) {
    const prior = current['mcpServers'];
    const mcpServers = isObj(prior) ? { ...prior } : {};
    mcpServers['evolver'] = serverEntry;
    return { ...current, mcpServers };
}
export function stripAntigravityManaged(current) {
    const prior = current['mcpServers'];
    if (!isObj(prior) || !('evolver' in prior))
        return { changed: false, data: current };
    const mcpServers = { ...prior };
    delete mcpServers['evolver'];
    const data = { ...current };
    if (Object.keys(mcpServers).length > 0)
        data['mcpServers'] = mcpServers;
    else
        delete data['mcpServers'];
    return { changed: true, data };
}
function managedAntigravityTargets(opts) {
    const targets = resolveAntigravityConfigTargets(opts.homeDir);
    if (opts.targetPath === undefined)
        return targets;
    const selected = targets.filter((target) => sameRuntimePath(target.configPath, opts.targetPath));
    if (selected.length !== 1)
        throw new Error('Antigravity lifecycle target is outside the managed namespace');
    return selected;
}
function managedAntigravitySpec(target, homeDir) {
    return {
        runtime: 'antigravity',
        configPath: () => target.configPath,
        safeRoot: () => homeDir ?? osHomedir(),
        containerKey: 'mcpServers',
        entry: antigravityMcpServerEntry,
    };
}
function combineManagedResults(runtime, mode, results) {
    return {
        ok: results.every((result) => result.ok), runtime, mode,
        files: results.flatMap((result) => result.files),
        backups: results.flatMap((result) => result.backups ?? []),
        ...(results.every((result) => result.alreadyInstalled) ? { alreadyInstalled: true } : {}),
        verified: results.every((result) => result.verified),
        ...(results.every((result) => result.dryRun) ? { dryRun: true } : {}),
    };
}
/** Install MCP discovery. Exact targetPath owns one namespace; the normal path owns a recoverable set. */
export function installAntigravity(plan, opts) {
    return runManagedInstallerTransaction(plan.runtime, opts, 'install', verification => installAntigravityOnce(plan, { ...opts, dryRun: true, ...(verification ? { force: false } : {}) }), targetPath => installAntigravityOnce(plan, { ...opts, ...(targetPath === undefined ? {} : { targetPath }) }), plan);
}
function installAntigravityOnce(plan, opts) {
    antigravityMcpServerEntry(opts.server);
    const targets = managedAntigravityTargets(opts);
    for (const target of targets)
        readStrictSnapshot(target.configPath);
    const results = targets.map(target => installJsonMcpRuntime(managedAntigravitySpec(target, opts.homeDir), plan, opts));
    return combineManagedResults(plan.runtime, plan.mode, results);
}
/** Ownership-backed removal, including restoration of force-replaced user entries. */
export function uninstallAntigravity(runtime, opts) {
    return runManagedInstallerTransaction(runtime, opts, 'uninstall', () => uninstallAntigravityOnce(runtime, { ...opts, dryRun: true }), targetPath => uninstallAntigravityOnce(runtime, { ...opts, ...(targetPath === undefined ? {} : { targetPath }) }));
}
function uninstallAntigravityOnce(runtime, opts) {
    const targets = managedAntigravityTargets(opts);
    for (const target of targets)
        readStrictSnapshot(target.configPath);
    return combineManagedResults(runtime, 'uninstall', targets.map(target => uninstallJsonMcpRuntime(managedAntigravitySpec(target, opts.homeDir), runtime, opts)));
}