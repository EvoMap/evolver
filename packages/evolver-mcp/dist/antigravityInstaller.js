import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir as osHomedir } from 'node:os';
import { dirname, join } from 'node:path';
import { util } from '@evomap/evolver-core';
import { EmptySharedConfigError, SymlinkRefusedError, UnparseableConfigError, } from './installer.js';
const ENV_FILE_KEY = 'EVOLVER_ENV_FILE';
const CONFIG_FILE = 'mcp_config.json';
const CONFIG_WRITE_RETRIES = 5;
const NEW_CONFIG_MODE = 0o600;
const NEW_DIR_MODE = 0o700;
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
function readRawIfExists(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function existingFileMode(path) {
    try {
        return statSync(path).mode & 0o777;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
function writeJsonAtomic(path, data) {
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const mode = existingFileMode(path) ?? NEW_CONFIG_MODE;
    const restoreMode = process.platform === 'win32' && existsSync(path) ? existingFileMode(path) : undefined;
    try {
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode });
        chmodSync(tmp, mode);
        if (process.platform === 'win32' && existsSync(path))
            chmodSync(path, mode | 0o200);
        renameSync(tmp, path);
        chmodSync(path, mode);
    }
    catch (error) {
        rmSync(tmp, { force: true });
        if (restoreMode !== undefined) {
            try {
                if (existsSync(path))
                    chmodSync(path, restoreMode);
            }
            catch { /* preserve the original error */ }
        }
        throw error;
    }
}
function updateConfigWithRetry(path, update) {
    const lockPath = `${path}.evolver.lock`;
    util.acquireLock(lockPath);
    try {
        for (let attempt = 0; attempt < CONFIG_WRITE_RETRIES; attempt++) {
            const snapshot = readStrictSnapshot(path);
            const next = update(snapshot.data);
            if (!next.changed)
                return false;
            if (readRawIfExists(path) !== snapshot.raw)
                continue;
            writeJsonAtomic(path, next.data);
            return true;
        }
    }
    finally {
        util.releaseLock(lockPath);
    }
    throw new Error(`[setup-hooks] refusing to overwrite Antigravity MCP config (${path}): the file changed repeatedly while evolver was merging it. Retry after Antigravity finishes writing it.`);
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
function hasEvolver(current) {
    const mcpServers = current['mcpServers'];
    return isObj(mcpServers) && 'evolver' in mcpServers;
}
function ensureTargetRoot(target) {
    const geminiRoot = dirname(target.root);
    assertDirectoryOrMissing(geminiRoot, '~/.gemini');
    mkdirSync(dirname(target.configPath), { recursive: true, mode: NEW_DIR_MODE });
    assertDirectoryOrMissing(geminiRoot, '~/.gemini');
    assertDirectoryOrMissing(target.root, `~/.gemini/${target.namespace}`);
    assertFileNotSymlink(target.configPath, `~/.gemini/${target.namespace}/${CONFIG_FILE}`);
}
/** Install MCP tool discovery only. Antigravity has no verified SessionStart hook contract. */
export function installAntigravity(plan, opts) {
    const serverEntry = antigravityMcpServerEntry(opts.server);
    const targets = resolveAntigravityConfigTargets(opts.homeDir);
    // Validate every shared config before the first mutation so one corrupt namespace cannot leave a partial install.
    const snapshots = targets.map((target) => ({ target, snapshot: readStrictSnapshot(target.configPath) }));
    if (!opts.force && snapshots.every(({ snapshot }) => hasEvolver(snapshot.data))) {
        return { ok: true, runtime: plan.runtime, mode: plan.mode, files: [], alreadyInstalled: true };
    }
    const files = [];
    for (const { target } of snapshots) {
        ensureTargetRoot(target);
        const changed = updateConfigWithRetry(target.configPath, (current) => {
            if (!opts.force && hasEvolver(current))
                return { changed: false, data: current };
            return { changed: true, data: mergeAntigravityConfig(current, serverEntry) };
        });
        if (changed)
            files.push(target.configPath);
    }
    return { ok: true, runtime: plan.runtime, mode: plan.mode, files };
}
/** Remove only mcpServers.evolver. The shared config file and all unrelated user content always remain. */
export function uninstallAntigravity(runtime, opts) {
    const targets = resolveAntigravityConfigTargets(opts.homeDir);
    const snapshots = targets.map((target) => ({ target, snapshot: readStrictSnapshot(target.configPath) }));
    const files = [];
    for (const { target, snapshot } of snapshots) {
        if (!hasEvolver(snapshot.data))
            continue;
        const changed = updateConfigWithRetry(target.configPath, stripAntigravityManaged);
        if (changed)
            files.push(target.configPath);
    }
    return { ok: true, runtime, mode: 'uninstall', files };
}