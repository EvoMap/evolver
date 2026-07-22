import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';
import { installJsonMcpRuntime, McpConfigChangedError, McpConfigConflictError, McpConfigOwnershipError, McpConfigShapeError, uninstallJsonMcpRuntime, } from './jsonMcpInstaller.js';
function configuredPath(value) {
    const trimmed = value?.trim();
    return trimmed ? (isAbsolute(trimmed) ? trimmed : resolve(trimmed)) : undefined;
}
export function resolveOpenCodeManagedConfigDir(opts = {}) {
    const platform = opts.opencodePlatform ?? process.platform;
    if (platform === 'darwin')
        return '/Library/Application Support/opencode';
    if (platform === 'win32') {
        return win32.join(opts.opencodeProgramData ?? process.env['ProgramData'] ?? 'C:\\ProgramData', 'opencode');
    }
    return '/etc/opencode';
}
export function resolveOpenCodeManagedPreferencePaths(opts = {}) {
    if ((opts.opencodePlatform ?? process.platform) !== 'darwin')
        return [];
    let username = opts.opencodeUsername;
    if (username === undefined) {
        try {
            username = userInfo().username || 'user';
        }
        catch {
            username = 'user';
        }
    }
    return [
        posix.join('/Library/Managed Preferences', username, 'ai.opencode.managed.plist'),
        posix.join('/Library/Managed Preferences', 'ai.opencode.managed.plist'),
    ];
}
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
function mergeOpenCodeValue(target, source) {
    if (!isRecord(target) || !isRecord(source))
        return source;
    const merged = { ...target };
    for (const [key, value] of Object.entries(source)) {
        // Define user-controlled keys as data so `__proto__` cannot invoke the legacy object setter.
        Object.defineProperty(merged, key, {
            configurable: true,
            enumerable: true,
            value: mergeOpenCodeValue(merged[key], value),
            writable: true,
        });
    }
    return merged;
}
function mergeEffectiveEntry(current, entry, source) {
    if (!entry.present)
        return current;
    return {
        present: true,
        value: current.present ? mergeOpenCodeValue(current.value, entry.value) : entry.value,
        source,
    };
}
function readReadOnlySource(path) {
    if (!existsSync(path))
        return { path, raw: null };
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
        throw new McpConfigOwnershipError('opencode', 'a layered configuration is a symbolic link');
    }
    if (!stat.isFile()) {
        throw new McpConfigOwnershipError('opencode', 'a layered configuration is not a regular file');
    }
    return { path, raw: readFileSync(path, 'utf8') };
}
function parseReadOnlyJsonc(raw, source) {
    let withoutComments = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        const next = raw[index + 1];
        if (inString) {
            withoutComments += char;
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            withoutComments += char;
            continue;
        }
        if (char === '/' && next === '/') {
            withoutComments += '  ';
            index += 1;
            while (index + 1 < raw.length && raw[index + 1] !== '\n' && raw[index + 1] !== '\r') {
                withoutComments += ' ';
                index += 1;
            }
            continue;
        }
        if (char === '/' && next === '*') {
            withoutComments += '  ';
            index += 1;
            let closed = false;
            while (index + 1 < raw.length) {
                const current = raw[index + 1];
                const following = raw[index + 2];
                if (current === '*' && following === '/') {
                    withoutComments += '  ';
                    index += 2;
                    closed = true;
                    break;
                }
                withoutComments += current === '\n' || current === '\r' ? current : ' ';
                index += 1;
            }
            if (!closed)
                throw new McpConfigShapeError('opencode', source, 'layered JSONC configuration has an unterminated comment');
            continue;
        }
        withoutComments += char;
    }
    let normalized = '';
    inString = false;
    escaped = false;
    for (let index = 0; index < withoutComments.length; index += 1) {
        const char = withoutComments[index];
        if (inString) {
            normalized += char;
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            normalized += char;
            continue;
        }
        if (char === ',') {
            let lookahead = index + 1;
            while (/\s/.test(withoutComments[lookahead] ?? ''))
                lookahead += 1;
            if (withoutComments[lookahead] === '}' || withoutComments[lookahead] === ']')
                continue;
        }
        normalized += char;
    }
    try {
        return JSON.parse(normalized);
    }
    catch {
        throw new McpConfigShapeError('opencode', source, 'layered configuration is not valid JSON/JSONC');
    }
}
function entryFromLayeredConfig(raw, source) {
    const parsed = source.endsWith('.jsonc') ? parseReadOnlyJsonc(raw, source) : (() => {
        try {
            return JSON.parse(raw);
        }
        catch {
            throw new McpConfigShapeError('opencode', source, 'layered configuration is not valid JSON');
        }
    })();
    if (!isRecord(parsed))
        throw new McpConfigShapeError('opencode', source, 'layered configuration must be a JSON object');
    const mcp = parsed['mcp'];
    if (mcp === undefined)
        return { present: false };
    if (!isRecord(mcp))
        throw new McpConfigShapeError('opencode', source, 'mcp must be a JSON object');
    return Object.prototype.hasOwnProperty.call(mcp, 'evolver')
        ? { present: true, value: mcp['evolver'] }
        : { present: false };
}
function uniquePaths(paths) {
    return [...new Set(paths)];
}
function canonicalOpenCodeProjectRoot(configRoot) {
    const directory = resolve(configRoot);
    const parent = dirname(directory);
    if (parent === directory)
        return directory;
    try {
        // Resolve parent aliases such as macOS /tmp, but leave the project-root entry itself for the shared
        // safe-parent guard to reject when configRoot is a caller-controlled symlink.
        return join(realpathSync(parent), basename(directory));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        return join(canonicalOpenCodeProjectRoot(parent), basename(directory));
    }
}
function nearestExistingCanonicalDirectory(path) {
    let current = path;
    while (true) {
        try {
            if (lstatSync(current).isDirectory())
                return realpathSync(current);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        const parent = dirname(current);
        if (parent === current)
            return current;
        current = parent;
    }
}
function isLexicallyContained(root, path) {
    const relativePath = relative(root, path);
    return relativePath === ''
        || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}
function filesystemRoot(path) {
    let current = path;
    while (dirname(current) !== current)
        current = dirname(current);
    return current;
}
function openCodeWorktreeRoot(configRoot) {
    const directory = canonicalOpenCodeProjectRoot(configRoot);
    try {
        // Keep a caller-controlled root alias as the safe root so the shared guard refuses it before ancestor
        // discovery can retarget a managed config elsewhere in the worktree.
        if (lstatSync(directory).isSymbolicLink())
            return directory;
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const gitCwd = nearestExistingCanonicalDirectory(directory);
    let output;
    try {
        output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: gitCwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    }
    catch {
        return filesystemRoot(directory);
    }
    if (!output)
        return directory;
    let canonicalWorktreeRoot;
    try {
        canonicalWorktreeRoot = realpathSync(output);
    }
    catch {
        return directory;
    }
    return isLexicallyContained(canonicalWorktreeRoot, directory)
        ? canonicalWorktreeRoot
        : directory;
}
function openCodeProjectLayerPaths(configRoot, worktreeRoot = openCodeWorktreeRoot(configRoot)) {
    const directory = canonicalOpenCodeProjectRoot(configRoot);
    const ancestors = [];
    let current = directory;
    while (true) {
        ancestors.push(current);
        if (current === worktreeRoot)
            break;
        const parent = dirname(current);
        if (parent === current)
            return [
                join(directory, 'opencode.json'),
                join(directory, 'opencode.jsonc'),
                join(directory, '.opencode', 'opencode.json'),
                join(directory, '.opencode', 'opencode.jsonc'),
            ];
        current = parent;
    }
    return [
        ...[...ancestors].reverse().flatMap((ancestor) => [
            join(ancestor, 'opencode.json'),
            join(ancestor, 'opencode.jsonc'),
        ]),
        ...ancestors.flatMap((ancestor) => [
            join(ancestor, '.opencode', 'opencode.json'),
            join(ancestor, '.opencode', 'opencode.jsonc'),
        ]),
    ];
}
function openCodeLayerPaths(opts, projectDisabled) {
    const home = opts.homeDir ?? homedir();
    const xdgHome = configuredPath(opts.xdgConfigHome ?? process.env['XDG_CONFIG_HOME']) ?? join(home, '.config');
    const globalDir = join(xdgHome, 'opencode');
    const paths = [
        join(globalDir, 'config.json'),
        join(globalDir, 'opencode.json'),
        join(globalDir, 'opencode.jsonc'),
    ];
    const explicitConfig = configuredPath(opts.opencodeConfig ?? process.env['OPENCODE_CONFIG']);
    if (explicitConfig)
        paths.push(explicitConfig);
    if ((opts.scope ?? 'project') === 'project' && !projectDisabled) {
        paths.push(...openCodeProjectLayerPaths(opts.configRoot));
    }
    paths.push(join(home, '.opencode', 'opencode.json'), join(home, '.opencode', 'opencode.jsonc'));
    const explicitDir = configuredPath(opts.opencodeConfigDir ?? process.env['OPENCODE_CONFIG_DIR']);
    if (explicitDir)
        paths.push(join(explicitDir, 'opencode.json'), join(explicitDir, 'opencode.jsonc'));
    return uniquePaths(paths);
}
function entryFromStrictConfig(raw, source) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new McpConfigShapeError('opencode', source, 'higher-precedence configuration is not valid strict JSON');
    }
    if (!isRecord(parsed)) {
        throw new McpConfigShapeError('opencode', source, 'higher-precedence configuration must be a JSON object');
    }
    const mcp = parsed['mcp'];
    if (mcp === undefined)
        return { present: false };
    if (!isRecord(mcp)) {
        throw new McpConfigShapeError('opencode', source, 'mcp must be a JSON object');
    }
    return Object.prototype.hasOwnProperty.call(mcp, 'evolver')
        ? { present: true, value: mcp['evolver'] }
        : { present: false };
}
function openCodeInstallPreflight(resolution, opts, expected) {
    const disableProjectFromOptions = opts.opencodeDisableProjectConfig !== undefined;
    const disableProjectEnvironment = process.env['OPENCODE_DISABLE_PROJECT_CONFIG'];
    const projectDisabled = disableProjectFromOptions
        ? opts.opencodeDisableProjectConfig === true
        : ['true', '1'].includes(disableProjectEnvironment?.toLowerCase() ?? '');
    const projectTargetDisabled = projectDisabled
        && (opts.scope ?? 'project') === 'project'
        && !configuredPath(opts.opencodeConfigDir ?? process.env['OPENCODE_CONFIG_DIR']);
    const layerPaths = openCodeLayerPaths(opts, projectDisabled);
    const resolvedTargetPath = resolve(resolution.configPath);
    const targetIndex = layerPaths.findIndex((path) => resolve(path) === resolvedTargetPath);
    const layerSnapshots = layerPaths.map(readReadOnlySource);
    let effectiveEntry = { present: false };
    let plannedEffectiveEntry = { present: false };
    for (const [index, snapshot] of layerSnapshots.entries()) {
        const isTarget = resolve(snapshot.path) === resolvedTargetPath;
        const source = isTarget
            ? 'target'
            : targetIndex >= 0 && index < targetIndex ? 'lower' : 'higher';
        const entry = snapshot.raw === null
            ? { present: false }
            : entryFromLayeredConfig(snapshot.raw, snapshot.path);
        effectiveEntry = mergeEffectiveEntry(effectiveEntry, entry, source);
        plannedEffectiveEntry = mergeEffectiveEntry(plannedEffectiveEntry, isTarget ? { present: true, value: expected } : entry, source);
    }
    const inlineFromOptions = opts.opencodeConfigContent !== undefined;
    const inline = inlineFromOptions ? opts.opencodeConfigContent : process.env['OPENCODE_CONFIG_CONTENT'];
    if (inline) {
        const entry = entryFromStrictConfig(inline, 'OPENCODE_CONFIG_CONTENT');
        effectiveEntry = mergeEffectiveEntry(effectiveEntry, entry, 'higher');
        plannedEffectiveEntry = mergeEffectiveEntry(plannedEffectiveEntry, entry, 'higher');
    }
    const managedDir = opts.opencodeManagedConfigDir
        ?? process.env['OPENCODE_TEST_MANAGED_CONFIG_DIR']
        ?? resolveOpenCodeManagedConfigDir(opts);
    const managedPaths = [join(managedDir, 'opencode.json'), join(managedDir, 'opencode.jsonc')];
    const managedSnapshots = managedPaths.map(readReadOnlySource);
    for (const snapshot of managedSnapshots) {
        if (snapshot.raw === null)
            continue;
        const entry = entryFromLayeredConfig(snapshot.raw, snapshot.path);
        effectiveEntry = mergeEffectiveEntry(effectiveEntry, entry, 'higher');
        plannedEffectiveEntry = mergeEffectiveEntry(plannedEffectiveEntry, entry, 'higher');
    }
    const preferencePaths = opts.opencodeManagedPreferencePaths ?? resolveOpenCodeManagedPreferencePaths(opts);
    if (preferencePaths.some(existsSync)) {
        throw new McpConfigOwnershipError('opencode', 'macOS managed preferences are active and cannot be safely inspected without invoking system tooling');
    }
    const effectiveMatches = effectiveEntry.present && valuesEqual(effectiveEntry.value, expected);
    const plannedEffectiveMatches = plannedEffectiveEntry.present
        && valuesEqual(plannedEffectiveEntry.value, expected);
    if (!projectTargetDisabled && !effectiveMatches && !plannedEffectiveMatches) {
        throw new McpConfigConflictError('opencode', 'mcp.evolver', expected, plannedEffectiveEntry.present ? plannedEffectiveEntry.value : '<missing>');
    }
    if (effectiveEntry.present && !effectiveMatches && effectiveEntry.source !== 'target') {
        const forceCanOverride = opts.force === true && !projectTargetDisabled;
        if (!forceCanOverride) {
            throw new McpConfigConflictError('opencode', 'mcp.evolver', expected, effectiveEntry.value);
        }
    }
    if (projectTargetDisabled && !effectiveMatches) {
        throw new McpConfigConflictError('opencode', 'mcp.evolver', expected, effectiveEntry.present ? effectiveEntry.value : '<missing while OPENCODE_DISABLE_PROJECT_CONFIG is enabled>');
    }
    const alreadyInstalled = effectiveMatches && effectiveEntry.source !== 'target';
    const guardedLayerSnapshots = alreadyInstalled
        ? layerSnapshots
        : layerSnapshots.filter((snapshot) => resolve(snapshot.path) !== resolvedTargetPath);
    return {
        alreadyInstalled,
        assertUnchanged() {
            if (!inlineFromOptions && process.env['OPENCODE_CONFIG_CONTENT'] !== inline) {
                throw new McpConfigChangedError('opencode', 'OPENCODE_CONFIG_CONTENT');
            }
            if (!disableProjectFromOptions
                && process.env['OPENCODE_DISABLE_PROJECT_CONFIG'] !== disableProjectEnvironment) {
                throw new McpConfigChangedError('opencode', 'OPENCODE_DISABLE_PROJECT_CONFIG');
            }
            for (const snapshot of [...guardedLayerSnapshots, ...managedSnapshots]) {
                const current = readReadOnlySource(snapshot.path);
                if (current.raw !== snapshot.raw)
                    throw new McpConfigChangedError('opencode', snapshot.path);
            }
            if (preferencePaths.some(existsSync))
                throw new McpConfigChangedError('opencode', 'macOS managed preferences');
        },
    };
}
/** Resolve the OpenCode file that is active at the requested scope.
 * OpenCode layers project files from the worktree root down to the current directory, or from the filesystem root
 * outside Git, then .opencode directories in reverse order. JSONC follows JSON at every location. Global,
 * explicit, home, and managed layers retain their surrounding precedence. A JSONC path is writable only when its
 * contents are strict JSON;
 * comment/trailing-comma syntax is rejected by the shared strict parser so setup never rewrites it lossy.
 */
export function resolveOpenCodeConfig(opts) {
    const scope = opts.scope ?? 'project';
    const explicitDir = configuredPath(opts.opencodeConfigDir ?? process.env['OPENCODE_CONFIG_DIR']);
    if (explicitDir) {
        const jsonPath = join(explicitDir, 'opencode.json');
        const jsoncPath = join(explicitDir, 'opencode.jsonc');
        return {
            configPath: existsSync(jsoncPath) ? jsoncPath : jsonPath,
            safeRoot: explicitDir,
            conflictingPaths: [],
            evidencePaths: [explicitDir, jsonPath, jsoncPath],
            topologyCandidatePaths: [jsonPath, jsoncPath],
            uninstallCandidatePaths: [jsonPath, jsoncPath],
        };
    }
    if (scope === 'user') {
        const home = opts.homeDir ?? homedir();
        const explicitConfig = configuredPath(opts.opencodeConfig ?? process.env['OPENCODE_CONFIG']);
        if (explicitConfig) {
            return {
                configPath: explicitConfig,
                safeRoot: dirname(explicitConfig),
                conflictingPaths: [],
                evidencePaths: [explicitConfig],
                topologyCandidatePaths: [explicitConfig],
            };
        }
        const xdgHome = configuredPath(opts.xdgConfigHome ?? process.env['XDG_CONFIG_HOME']) ?? join(home, '.config');
        const directory = join(xdgHome, 'opencode');
        const jsonPath = join(directory, 'opencode.json');
        const jsoncPath = join(directory, 'opencode.jsonc');
        return {
            configPath: existsSync(jsoncPath) ? jsoncPath : jsonPath,
            safeRoot: directory,
            conflictingPaths: [],
            evidencePaths: [directory, jsonPath, jsoncPath],
            topologyCandidatePaths: [jsonPath, jsoncPath],
            uninstallCandidatePaths: [jsonPath, jsoncPath],
        };
    }
    const projectRoot = canonicalOpenCodeProjectRoot(opts.configRoot);
    const rootJson = join(projectRoot, 'opencode.json');
    const rootJsonc = join(projectRoot, 'opencode.jsonc');
    const nestedJson = join(projectRoot, '.opencode', 'opencode.json');
    const nestedJsonc = join(projectRoot, '.opencode', 'opencode.jsonc');
    const target = existsSync(nestedJsonc)
        ? nestedJsonc
        : existsSync(nestedJson)
            ? nestedJson
            : existsSync(rootJsonc)
                ? rootJsonc
                : rootJson;
    const userResolution = resolveOpenCodeConfig({ ...opts, scope: 'user' });
    const worktreeRoot = openCodeWorktreeRoot(projectRoot);
    const projectLayerPaths = openCodeProjectLayerPaths(projectRoot, worktreeRoot);
    return {
        configPath: target,
        safeRoot: projectRoot,
        conflictingPaths: [],
        evidencePaths: [...(userResolution.evidencePaths ?? []), ...projectLayerPaths],
        topologyCandidatePaths: [rootJson, rootJsonc, nestedJson, nestedJsonc],
        uninstallCandidatePaths: [rootJson, rootJsonc, nestedJson, nestedJsonc],
        installDiscoveryPaths: projectLayerPaths,
        installSafeRoot: worktreeRoot,
        uninstallDiscoveryPaths: projectLayerPaths,
        uninstallSafeRoot: worktreeRoot,
    };
}
export const OPENCODE_SPEC = {
    runtime: 'opencode',
    configPath: (opts) => resolveOpenCodeConfig(opts).configPath,
    resolveConfig: resolveOpenCodeConfig,
    installPreflight: openCodeInstallPreflight,
    containerKey: 'mcp',
    entry: (server) => ({
        type: 'local',
        command: [server.command, ...(server.args ?? [])],
        ...(server.env && Object.keys(server.env).length > 0 ? { environment: server.env } : {}),
        enabled: true,
    }),
};
export const installOpenCode = installJsonMcpRuntime.bind(undefined, OPENCODE_SPEC);
export const uninstallOpenCode = uninstallJsonMcpRuntime.bind(undefined, OPENCODE_SPEC);