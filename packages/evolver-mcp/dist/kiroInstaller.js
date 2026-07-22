import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { installJsonMcpRuntime, McpConfigChangedError, McpConfigConflictError, McpConfigOwnershipError, McpConfigShapeError, uninstallJsonMcpRuntime, } from './jsonMcpInstaller.js';
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function valuesEqual(left, right) {
    if (Object.is(left, right))
        return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => valuesEqual(value, right[index]));
    }
    if (!isRecord(left) || !isRecord(right))
        return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && valuesEqual(left[key], right[key]));
}
function readKiroLayer(path) {
    if (!existsSync(path))
        return { path, raw: null };
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
        throw new McpConfigOwnershipError('kiro', 'a layered configuration is a symbolic link');
    }
    if (!stat.isFile()) {
        throw new McpConfigOwnershipError('kiro', 'a layered configuration is not a regular file');
    }
    return { path, raw: readFileSync(path, 'utf8') };
}
function entryFromKiroLayer(snapshot) {
    if (snapshot.raw === null)
        return { present: false };
    let parsed;
    try {
        parsed = JSON.parse(snapshot.raw);
    }
    catch {
        throw new McpConfigShapeError('kiro', snapshot.path, 'layered configuration is not valid JSON');
    }
    if (!isRecord(parsed)) {
        throw new McpConfigShapeError('kiro', snapshot.path, 'layered configuration must be a JSON object');
    }
    const servers = parsed['mcpServers'];
    if (servers === undefined)
        return { present: false };
    if (!isRecord(servers)) {
        throw new McpConfigShapeError('kiro', snapshot.path, 'mcpServers must be a JSON object');
    }
    return Object.prototype.hasOwnProperty.call(servers, 'evolver')
        ? { present: true, value: servers['evolver'], path: snapshot.path }
        : { present: false };
}
function kiroBaseConfigPaths(opts) {
    const globalRoot = kiroConfigRoot({ ...opts, scope: 'user' });
    return {
        global: join(globalRoot, 'settings', 'mcp.json'),
        workspace: join(opts.configRoot, '.kiro', 'settings', 'mcp.json'),
    };
}
/** Resolve only Kiro's base mcp.json contract; custom agent JSON is intentionally out of scope. */
export function resolveKiroConfig(opts) {
    const paths = kiroBaseConfigPaths(opts);
    const configPath = (opts.scope ?? 'project') === 'user' ? paths.global : paths.workspace;
    const safeRoot = (opts.scope ?? 'project') === 'user'
        ? kiroConfigRoot({ ...opts, scope: 'user' })
        : opts.configRoot;
    return {
        configPath,
        safeRoot,
        conflictingPaths: [],
        evidencePaths: [paths.global, paths.workspace],
        topologyCandidatePaths: [configPath],
        uninstallCandidatePaths: [configPath],
    };
}
function kiroInstallPreflight(resolution, opts, expected) {
    const paths = kiroBaseConfigPaths(opts);
    const layerPaths = [...new Set([paths.global, paths.workspace])];
    const snapshots = layerPaths.map(readKiroLayer);
    let effective = { present: false };
    for (const snapshot of snapshots) {
        const entry = entryFromKiroLayer(snapshot);
        if (entry.present)
            effective = entry;
    }
    const effectiveMatches = effective.present && valuesEqual(effective.value, expected);
    if (effective.present && !effectiveMatches && effective.path !== resolution.configPath) {
        const projectCanForceWorkspaceOverride = (opts.scope ?? 'project') === 'project'
            && opts.force === true
            && effective.path === paths.global;
        if (!projectCanForceWorkspaceOverride) {
            throw new McpConfigConflictError('kiro', 'mcpServers.evolver', expected, effective.value);
        }
    }
    const targetIndex = layerPaths.indexOf(resolution.configPath);
    const effectiveIndex = effective.path === undefined ? -1 : layerPaths.indexOf(effective.path);
    const alreadyInstalled = effectiveMatches
        && effective.path !== resolution.configPath
        && effectiveIndex >= 0
        && targetIndex >= 0
        && effectiveIndex < targetIndex;
    const guardedSnapshots = alreadyInstalled
        ? snapshots
        : snapshots.filter((snapshot) => snapshot.path !== resolution.configPath);
    return {
        alreadyInstalled,
        assertUnchanged() {
            for (const snapshot of guardedSnapshots) {
                const current = readKiroLayer(snapshot.path);
                if (current.raw !== snapshot.raw)
                    throw new McpConfigChangedError('kiro', snapshot.path);
            }
        },
    };
}
export const KIRO_SPEC = {
    runtime: 'kiro',
    configPath: (opts) => resolveKiroConfig(opts).configPath,
    resolveConfig: resolveKiroConfig,
    installPreflight: kiroInstallPreflight,
    containerKey: 'mcpServers',
    entry: (server) => ({
        command: server.command,
        args: server.args ?? [],
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
        disabled: false,
    }),
};
export function kiroConfigRoot({ configRoot, scope, homeDir, kiroHome }) {
    if (scope !== 'user')
        return join(configRoot, '.kiro');
    const configured = kiroHome?.trim();
    if (configured)
        return resolve(configured);
    if (homeDir !== undefined)
        return join(homeDir, '.kiro');
    const environmentHome = process.env['KIRO_HOME']?.trim();
    return environmentHome ? resolve(environmentHome) : join(homedir(), '.kiro');
}
export const installKiro = installJsonMcpRuntime.bind(undefined, KIRO_SPEC);
export const uninstallKiro = uninstallJsonMcpRuntime.bind(undefined, KIRO_SPEC);