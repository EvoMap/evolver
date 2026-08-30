// `evolver setup-hooks` — wire (or remove) evolver into an agent runtime. Drives the evolver-mcp installer:
// for Claude Code it registers the evolver MCP server AND merges a SessionStart hook so memory is injected at
// session start (the hybrid). `--scope=user` registers into ~/.claude.json so evolver loads in EVERY project
// (the real device-wide scope); `--scope=project` (default) writes the project's own .mcp.json. Deny-nothing:
// it only writes the runtime's own config, is idempotent, refuses symlinked adapter paths, and `--uninstall`
// cleanly removes only evolver's entries.
import { planInjection, installInjection, uninstallInjection, runtimeSupport, renderManualWiring, renderServiceGuidance, SETUP_RUNTIMES, SERVICE_TARGETS, kiroConfigRoot, resolveOpenCodeConfig, McpConfigConflictError, McpConfigOwnershipError, McpConfigVerificationError, McpServerValidationError } from '@evomap/evolver-mcp';
import { assetstore, events } from '@evomap/evolver-core';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentTopCursorGenes } from './cursorRewrite.js';
import { resolveProxyBinPath, resolveStableNodePath } from './lifecycle.js';
import { reviewLedgerForStore } from './reviewFilter.js';
import { maybeEmitNonGitWorkspaceNotice } from './nonGitWorkspaceNotice.js';
const requireFromHere = createRequire(import.meta.url);
function configuredHomeDir() {
    const configured = process.platform === 'win32'
        ? process.env['USERPROFILE']
        : process.env['HOME'];
    return configured && configured.trim() ? configured : homedir();
}
function parseFlags(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a && a.startsWith('--')) {
            const key = a.slice(2);
            const eq = key.indexOf('=');
            if (eq >= 0) {
                out[key.slice(0, eq)] = key.slice(eq + 1);
            }
            else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
                out[key] = argv[++i];
            }
            else {
                out[key] = true;
            }
        }
    }
    return out;
}
const USAGE = `usage: evolver setup-hooks [--runtime=${SETUP_RUNTIMES.join('|')}] [--scope=user|project|global] [--root=<dir>] [--env-file=<path>] [--profile-descriptor=<json>] [--service=${SERVICE_TARGETS.join('|')}] [--verify] [--uninstall] [--dry-run] [--force] [--json] [--hook-command="evolver inject session-start"] [--server-command=<cmd>] [--server-args=a,b] [--service-command=<cmd>] [--service-args=a,b]\n  --verify is read-only for opencode and kiro\n`;
export function commandNamesForPath(command, platform, pathExt) {
    if (platform !== 'win32' || /\.[^\\/]+$/.test(command))
        return [command];
    const extensions = (pathExt?.trim() || '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((extension) => extension.trim())
        .filter((extension) => /^\.?[A-Za-z\d]+$/.test(extension))
        .map((extension) => extension.startsWith('.') ? extension : `.${extension}`);
    return [command, ...extensions.map((extension) => `${command}${extension}`)];
}
function commandOnPath(command) {
    const names = commandNamesForPath(command, process.platform, process.env['PATHEXT']);
    for (const directory of (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
        for (const name of names) {
            try {
                const candidate = join(directory, name);
                if (!statSync(candidate).isFile())
                    continue;
                accessSync(candidate, constants.X_OK);
                return true;
            }
            catch {
                // Continue searching PATH.
            }
        }
    }
    return false;
}
function defaultRuntimeAvailable(runtime, configRoot, scope) {
    if (runtime === 'opencode') {
        const resolution = resolveOpenCodeConfig({
            configRoot,
            scope,
            homeDir: configuredHomeDir(),
            xdgConfigHome: process.env['XDG_CONFIG_HOME'],
            opencodeConfig: process.env['OPENCODE_CONFIG'],
            opencodeConfigDir: process.env['OPENCODE_CONFIG_DIR'],
        });
        return commandOnPath('opencode') || (resolution.evidencePaths ?? [resolution.configPath]).some(existsSync);
    }
    const pathOptions = {
        configRoot,
        homeDir: configuredHomeDir(),
        kiroHome: process.env['KIRO_HOME'],
    };
    const evidenceRoots = scope === 'project'
        ? [
            kiroConfigRoot({ ...pathOptions, scope: 'project' }),
            kiroConfigRoot({ ...pathOptions, scope: 'user' }),
        ]
        : [kiroConfigRoot({ ...pathOptions, scope: 'user' })];
    return commandOnPath('kiro') || commandOnPath('kiro-cli') || evidenceRoots.some(existsSync);
}
function displaySetupPath(path, configRoot, scope) {
    if (scope === 'user') {
        const home = configuredHomeDir();
        const homePath = safeRelativePath(home, path);
        if (homePath === '')
            return '~';
        if (homePath !== undefined)
            return `~/${homePath.replaceAll('\\', '/')}`;
    }
    const projectPath = safeProjectRelativePath(configRoot, path);
    if (projectPath === '')
        return '.';
    return projectPath !== undefined ? projectPath.replaceAll('\\', '/') : '<config-path>';
}
function safeRelativePath(root, path) {
    const candidate = relative(root, path);
    if (isAbsolute(candidate) || candidate === '..' || candidate.startsWith(`..${sep}`))
        return undefined;
    return candidate;
}
function safeProjectRelativePath(root, path) {
    const descendant = safeRelativePath(root, path);
    if (descendant !== undefined)
        return descendant;
    return safeRelativePath(dirname(path), root) === undefined ? undefined : relative(root, path);
}
function displayResultPaths(paths, configRoot, scope) {
    return paths?.map((path) => displaySetupPath(path, configRoot, scope));
}
export function safeSetupOperationError(error) {
    if (error instanceof McpConfigConflictError)
        return error.message;
    if (error instanceof McpConfigOwnershipError)
        return error.message;
    if (error instanceof McpConfigVerificationError) {
        return error.restored
            ? '[setup-hooks] runtime configuration verification failed; the previous configuration was restored.'
            : '[setup-hooks] runtime configuration verification failed; rollback could not be confirmed. Inspect the runtime config before retrying.';
    }
    if (error instanceof McpServerValidationError)
        return error.message;
    const name = error instanceof Error ? error.name : '';
    switch (name) {
        case 'McpConfigConflictError': return '[setup-hooks] existing Evolver configuration conflicts; use --force to replace only the Evolver entry.';
        case 'McpConfigOwnershipError': return '[setup-hooks] Evolver ownership metadata is ambiguous or no longer matches the runtime configuration; inspect it before retrying.';
        case 'McpConfigShapeError': return '[setup-hooks] runtime configuration has an invalid JSON shape.';
        case 'McpConfigVerificationError': return error.restored === true
            ? '[setup-hooks] runtime configuration verification failed; the previous configuration was restored.'
            : '[setup-hooks] runtime configuration verification failed; rollback could not be confirmed. Inspect the runtime config before retrying.';
        case 'McpConfigChangedError': return '[setup-hooks] runtime configuration changed during the operation; retry after the runtime finishes writing it.';
        case 'EmptySharedConfigError': return '[setup-hooks] runtime configuration is empty; repair or remove it before retrying.';
        case 'UnparseableConfigError': return '[setup-hooks] runtime configuration is not valid JSON; repair it before retrying.';
        case 'SymlinkRefusedError': return '[setup-hooks] refused an unsafe symbolic-link configuration path.';
        default: return '[setup-hooks] runtime configuration operation failed.';
    }
}
export function safeSetupResultError(error) {
    if (typeof error !== 'string')
        return safeSetupOperationError(error);
    const reason = error.replace(/\s+/g, ' ').trim();
    const passive = reason.match(/^passive runtime ([a-z0-9][a-z0-9-]{0,63}): no tool injection$/);
    const unimplementedInstall = reason.match(/^installer not yet implemented for ([a-z0-9][a-z0-9-]{0,63}) \(supported: [a-z0-9, -]+\)$/);
    const unimplementedUninstall = reason.match(/^uninstall not implemented for ([a-z0-9][a-z0-9-]{0,63})$/);
    const runtime = passive?.[1] ?? unimplementedInstall?.[1] ?? unimplementedUninstall?.[1];
    if (!runtime || !SETUP_RUNTIMES.includes(runtime)) {
        return safeSetupOperationError(error);
    }
    if (passive)
        return `[setup-hooks] passive runtime ${runtime}: no tool injection`;
    if (unimplementedInstall)
        return `[setup-hooks] installer not yet implemented for ${runtime}`;
    return `[setup-hooks] uninstall not implemented for ${runtime}`;
}
const PROFILE_DESCRIPTOR_FLAG = 'profile-descriptor';
const SECRET_ASSIGNMENT_RE = /\b(?:A2A_NODE_SECRET|EVOMAP_ENTERPRISE_TOKEN|EVOMAP_PRIVATE_HUB_TOKEN|EVOMAP_NODE_SECRET|EVOLVER_IPC_TOKEN|EVOLVER_LLM_TOKEN|PHUB_ENTERPRISE_TOKEN|PRIVATE_HUB_ENTERPRISE_TOKEN)\b\s*[:=]\s*["']?[^"'\s<]+/;
const INLINE_BEARER_RE = /\bBearer\s+(?!<|\$|%|REDACTED\b|TOKEN\b|token\b|env:)[A-Za-z0-9._~+/=-]{12,}/i;
const INLINE_SECRET_FLAG_RE = /(?:^|\s)--?(?:api[-_]?key|password|passwd|secret|token)(?:=|\s+)["']?(?!<|\$|%|REDACTED\b|TOKEN\b|token\b|env:)[^"'\s]+/i;
const RAW_SECRET_VALUE_RE = /^(?=.{16,}$)(?!.*[\\/])(?=.*(?:evomap|key|phub|private|secret|token))(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9._~+/=-]+$/i;
/** Map and validate --scope before any config write. Omitted keeps the legacy project default; values are
 *  intentionally case-sensitive so typos do not silently install into project scope. */
function parseScope(raw) {
    if (raw === undefined)
        return { ok: true, scope: 'project' };
    if (raw === 'project')
        return { ok: true, scope: 'project' };
    if (raw === 'user' || raw === 'global')
        return { ok: true, scope: 'user' };
    if (raw === true) {
        return { ok: false, error: 'missing value for --scope (expected: project|user|global)' };
    }
    return { ok: false, error: `invalid --scope '${raw}' (expected: project|user|global; values are case-sensitive)` };
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasInlineSecretSyntax(value) {
    return SECRET_ASSIGNMENT_RE.test(value) || INLINE_BEARER_RE.test(value) || INLINE_SECRET_FLAG_RE.test(value);
}
function hasInlineSecretHint(hint) {
    const trimmed = hint.trim();
    return hasInlineSecretSyntax(trimmed) || RAW_SECRET_VALUE_RE.test(trimmed);
}
function looksLikeEnvFilePointer(value) {
    return /[\\/]/.test(value)
        || /^[A-Za-z]:[\\/]/.test(value)
        || /^[.~$%]/.test(value)
        || /\.(?:env|dotenv)(?:$|[._-])/i.test(value);
}
function validatePointerValue(label, value) {
    const trimmed = value.trim();
    return hasInlineSecretSyntax(trimmed) || (!looksLikeEnvFilePointer(trimmed) && RAW_SECRET_VALUE_RE.test(trimmed))
        ? `--${PROFILE_DESCRIPTOR_FLAG}.${label} contains an inline secret-looking value; use an EVOLVER_ENV_FILE pointer path instead`
        : undefined;
}
function profileDescriptorFromFlag(f) {
    const rawPath = f[PROFILE_DESCRIPTOR_FLAG];
    if (rawPath === undefined)
        return { ok: true, descriptor: { manualHints: {} } };
    if (rawPath === true || rawPath.trim().length === 0) {
        return { ok: false, error: `missing value for --${PROFILE_DESCRIPTOR_FLAG}` };
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(rawPath, 'utf8'));
    }
    catch (error) {
        return { ok: false, error: `cannot read --${PROFILE_DESCRIPTOR_FLAG}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!isRecord(parsed)) {
        return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG} must be a JSON object` };
    }
    const envFileRaw = parsed['envFile'] ?? parsed['env_file'];
    let envFile;
    if (envFileRaw !== undefined) {
        if (typeof envFileRaw !== 'string' || envFileRaw.trim().length === 0) {
            return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG}.envFile must be a non-empty string` };
        }
        envFile = envFileRaw.trim();
        const error = validatePointerValue('envFile', envFile);
        if (error)
            return { ok: false, error };
    }
    const mcpServer = parseDescriptorServer(parsed['mcpServer'] ?? parsed['mcp_server'], 'mcpServer');
    if (!mcpServer.ok)
        return mcpServer;
    const serviceExec = parseDescriptorServer(parsed['serviceExec'] ?? parsed['service_exec'], 'serviceExec');
    if (!serviceExec.ok)
        return serviceExec;
    const hintsByRuntime = parsed['manualHints'] ?? parsed['manual_hints'];
    const manualHints = {};
    if (hintsByRuntime === undefined) {
        return {
            ok: true,
            descriptor: {
                ...(envFile !== undefined ? { envFile } : {}),
                ...(mcpServer.server ? { mcpServer: mcpServer.server } : {}),
                ...(serviceExec.server ? { serviceExec: serviceExec.server } : {}),
                manualHints,
            },
        };
    }
    if (!isRecord(hintsByRuntime)) {
        return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG}.manualHints must be an object keyed by runtime` };
    }
    for (const [runtime, runtimeHints] of Object.entries(hintsByRuntime)) {
        if (!Array.isArray(runtimeHints) || runtimeHints.some((hint) => typeof hint !== 'string')) {
            return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG}.manualHints.${runtime} must be an array of strings` };
        }
        const hints = runtimeHints.map((hint) => hint.trim()).filter(Boolean);
        const secretHint = hints.find(hasInlineSecretHint);
        if (secretHint) {
            return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG}.manualHints.${runtime} contains an inline secret-looking value; use an EVOLVER_ENV_FILE pointer instead` };
        }
        manualHints[runtime] = hints;
    }
    return {
        ok: true,
        descriptor: {
            ...(envFile !== undefined ? { envFile } : {}),
            ...(mcpServer.server ? { mcpServer: mcpServer.server } : {}),
            ...(serviceExec.server ? { serviceExec: serviceExec.server } : {}),
            manualHints,
        },
    };
}
function parseDescriptorServer(value, label) {
    if (value === undefined)
        return { ok: true };
    if (!isRecord(value)) {
        return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG}.${label} must be an object` };
    }
    if (typeof value['command'] !== 'string' || value['command'].trim().length === 0) {
        return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG}.${label}.command must be a non-empty string` };
    }
    const argsRaw = value['args'];
    if (argsRaw !== undefined && (!Array.isArray(argsRaw) || argsRaw.some((arg) => typeof arg !== 'string'))) {
        return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG}.${label}.args must be an array of strings` };
    }
    const command = value['command'].trim();
    const args = argsRaw;
    const commandLine = [command, ...(args ?? [])].join(' ');
    if (hasInlineSecretHint(commandLine)) {
        return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG}.${label}.command/args contain an inline secret-looking value; use an EVOLVER_ENV_FILE pointer instead` };
    }
    const envRaw = value['env'];
    let env;
    if (envRaw !== undefined) {
        if (!isRecord(envRaw))
            return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG}.${label}.env must be an object` };
        const keys = Object.keys(envRaw);
        const unsupported = keys.filter((key) => key !== 'EVOLVER_ENV_FILE');
        if (unsupported.length > 0) {
            return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG}.${label}.env may only contain EVOLVER_ENV_FILE` };
        }
        const envFile = envRaw['EVOLVER_ENV_FILE'];
        if (envFile !== undefined) {
            if (typeof envFile !== 'string' || envFile.trim().length === 0) {
                return { ok: false, error: `--${PROFILE_DESCRIPTOR_FLAG}.${label}.env.EVOLVER_ENV_FILE must be a non-empty string` };
            }
            const pointer = envFile.trim();
            const error = validatePointerValue(`${label}.env.EVOLVER_ENV_FILE`, pointer);
            if (error)
                return { ok: false, error };
            env = { EVOLVER_ENV_FILE: pointer };
        }
    }
    return {
        ok: true,
        server: {
            command,
            ...(args !== undefined ? { args } : {}),
            ...(env ? { env } : {}),
        },
    };
}
function argsFromFlag(value) {
    return typeof value === 'string' ? value.split(',').filter(Boolean) : undefined;
}
function defaultMcpServer() {
    let stdioPath;
    try {
        stdioPath = requireFromHere.resolve('@evomap/evolver-mcp/stdio');
    }
    catch {
        stdioPath = fileURLToPath(new URL('../../evolver-mcp/dist/stdio.js', import.meta.url));
    }
    return { command: process.execPath, args: [stdioPath] };
}
function defaultProxyDaemon() {
    return { command: resolveStableNodePath(), args: [resolveProxyBinPath() ?? '/ABSOLUTE/PATH/TO/evolver-proxy.js'] };
}
function withEnvFile(server, envFile) {
    if (typeof envFile !== 'string' || !envFile.trim())
        return server;
    return {
        ...server,
        env: {
            ...(server.env ?? {}),
            EVOLVER_ENV_FILE: envFile.trim(),
        },
    };
}
/** The evolver MCP stdio server command (default or --server-command/--server-args), with the --env-file pointer
 *  merged in. Shared by the installed path (registered into config) and the manual path (rendered into wiring text). */
function descriptorEnvFile(f, descriptor, descriptorServer) {
    if (typeof f['env-file'] === 'string' && f['env-file'].trim().length > 0)
        return f['env-file'];
    return descriptorServer?.env?.['EVOLVER_ENV_FILE'] ?? descriptor.envFile;
}
function buildServer(f, descriptor = { manualHints: {} }) {
    const serverArgs = argsFromFlag(f['server-args']);
    const serverBase = typeof f['server-command'] === 'string'
        ? {
            command: f['server-command'],
            ...(serverArgs !== undefined ? { args: serverArgs } : {}),
            ...(serverArgs === undefined && descriptor.mcpServer?.args ? { args: descriptor.mcpServer.args } : {}),
        }
        : descriptor.mcpServer
            ? {
                ...descriptor.mcpServer,
                ...(serverArgs !== undefined ? { args: serverArgs } : {}),
            }
            : {
                ...defaultMcpServer(),
                ...(serverArgs !== undefined ? { args: serverArgs } : {}),
            };
    return withEnvFile(serverBase, descriptorEnvFile(f, descriptor, descriptor.mcpServer));
}
function buildServiceExec(f, descriptor = { manualHints: {} }) {
    const serviceArgs = argsFromFlag(f['service-args']);
    const serviceBase = typeof f['service-command'] === 'string'
        ? {
            command: f['service-command'],
            ...(serviceArgs !== undefined ? { args: serviceArgs } : {}),
            ...(serviceArgs === undefined && descriptor.serviceExec?.args ? { args: descriptor.serviceExec.args } : {}),
        }
        : descriptor.serviceExec
            ? {
                ...descriptor.serviceExec,
                ...(serviceArgs !== undefined ? { args: serviceArgs } : {}),
            }
            : {
                ...defaultProxyDaemon(),
                ...(serviceArgs !== undefined ? { args: serviceArgs } : {}),
            };
    return withEnvFile(serviceBase, descriptorEnvFile(f, descriptor, descriptor.serviceExec));
}
function appendAdapterNotes(text, hints) {
    return hints && hints.length > 0
        ? `${text}\n\nAdapter notes:\n${hints.map((hint) => `  - ${hint}`).join('\n')}`
        : text;
}
const SETUP_VALUE_FLAGS = new Set([
    'runtime', 'platform', 'scope', 'root', 'env-file', 'profile-descriptor', 'service',
    'hook-command', 'server-command', 'server-args', 'service-command', 'service-args',
]);
function setupHelpRequested(argv) {
    if (argv.includes('--help'))
        return true;
    return argv.some((arg, index) => {
        if (arg !== '-h')
            return false;
        const previous = argv[index - 1];
        if (!previous?.startsWith('--') || previous.includes('='))
            return true;
        return !SETUP_VALUE_FLAGS.has(previous.slice(2));
    });
}
export async function runSetupHooks(argv, store, review, deps = {}) {
    if (setupHelpRequested(argv)) {
        process.stdout.write(USAGE);
        return 0;
    }
    const f = parseFlags(argv);
    const runtimeRaw = typeof f['runtime'] === 'string'
        ? f['runtime']
        : (typeof f['platform'] === 'string' ? f['platform'] : 'claude-code');
    const json = f['json'] === true;
    const emit = (obj) => { if (json)
        process.stdout.write(`${JSON.stringify(obj)}\n`); };
    const scopeResult = parseScope(f['scope']);
    if (!scopeResult.ok) {
        if (json)
            emit({ runtime: runtimeRaw, outcome: 'error', files: [], error: scopeResult.error });
        else
            process.stderr.write(`${scopeResult.error}\n${USAGE}`);
        return 1;
    }
    // Tri-state setup matrix (#217): classify BEFORE touching any config so a bootstrapper gets a deterministic
    // installed/manual/unsupported answer. Only the `installed` class proceeds to mutate runtime config; `manual`
    // prints the honest "do it by hand" reason without mutating, and `unsupported` refuses with a clear reason.
    const support = runtimeSupport(runtimeRaw);
    if (support.outcome === 'unsupported') {
        if (json)
            emit({ runtime: runtimeRaw, outcome: 'unsupported', files: [], reason: support.reason });
        else
            process.stderr.write(`${support.reason}\n${USAGE}`);
        return 1;
    }
    // Installed runtimes have a real config writer + uninstaller (including Antigravity MCP config).
    const runtime = runtimeRaw;
    const configRoot = typeof f['root'] === 'string' ? f['root'] : process.cwd();
    // claude-code: user scope targets ~/.claude.json regardless of --root; project scope uses configRoot.
    const scope = scopeResult.scope;
    // V1 exposed setup-hooks --verify as a read-only operation. Silently ignoring it is unsafe: the command then
    // falls through to installInjection and can rewrite runtime configuration while the operator asked only to
    // inspect it. V2's JSON MCP installers already have a transaction-free dry-run preflight, so use that as the
    // verifier for OpenCode and Kiro. Legacy installers do not have a proven read-only preflight and must refuse.
    if (f['verify'] !== undefined) {
        const verificationArgsValid = f['verify'] === true
            && f['uninstall'] === undefined
            && f['dry-run'] === undefined
            && f['force'] === undefined;
        if (!verificationArgsValid) {
            const error = '--verify is read-only and cannot take a value or be combined with --uninstall, --dry-run, or --force';
            if (json)
                emit({ runtime, action: 'verify', ok: false, verified: false, files: [], error });
            else
                process.stderr.write(`${error}\n${USAGE}`);
            return 2;
        }
        if (runtime !== 'opencode' && runtime !== 'kiro') {
            const error = `--verify is not available for ${runtime}; no config was written`;
            if (json)
                emit({ runtime, action: 'verify', ok: false, verified: false, files: [], error });
            else
                process.stderr.write(`${error}\n`);
            return 2;
        }
        const verifyDescriptor = profileDescriptorFromFlag(f);
        if (!verifyDescriptor.ok) {
            if (json)
                emit({ runtime, action: 'verify', ok: false, verified: false, files: [], error: verifyDescriptor.error });
            else
                process.stderr.write(`${verifyDescriptor.error}\n`);
            return 1;
        }
        let verification;
        try {
            const server = buildServer(f, verifyDescriptor.descriptor);
            verification = installInjection(planInjection(runtime, server), {
                configRoot,
                server,
                scope,
                dryRun: true,
                homeDir: configuredHomeDir(),
                kiroHome: process.env['KIRO_HOME'],
                xdgConfigHome: process.env['XDG_CONFIG_HOME'],
                opencodeConfig: process.env['OPENCODE_CONFIG'],
                opencodeConfigDir: process.env['OPENCODE_CONFIG_DIR'],
            });
        }
        catch (error) {
            const message = safeSetupOperationError(error);
            if (json)
                emit({ runtime, action: 'verify', ok: false, verified: false, files: [], error: message });
            else
                process.stderr.write(`${message}\n`);
            return 1;
        }
        if (!verification.ok) {
            const message = safeSetupResultError(verification.error);
            if (json)
                emit({ runtime, action: 'verify', ok: false, verified: false, files: [], error: message });
            else
                process.stderr.write(`${message}\n`);
            return 1;
        }
        const files = displayResultPaths(verification.files, configRoot, scope) ?? [];
        const verified = verification.alreadyInstalled === true && verification.verified === true;
        if (json)
            emit({ runtime, action: 'verify', ok: verified, verified, files });
        else
            process.stdout.write(verified
                ? `verified evolver setup for ${runtime}: ${files.join(', ')}\n`
                : `evolver setup for ${runtime} is missing or does not match the requested configuration\n`);
        return verified ? 0 : 1;
    }
    if (f['dry-run'] === true && runtime !== 'opencode' && runtime !== 'kiro') {
        const error = `--dry-run is currently supported for opencode and kiro setup only; no config was written.`;
        if (json)
            emit({ runtime, outcome: 'error', files: [], error });
        else
            process.stderr.write(`${error}\n`);
        return 1;
    }
    if (support.outcome === 'installed' && f['uninstall']) {
        let r;
        try {
            r = uninstallInjection(runtime, {
                configRoot,
                scope,
                homeDir: configuredHomeDir(),
                kiroHome: process.env['KIRO_HOME'],
                xdgConfigHome: process.env['XDG_CONFIG_HOME'],
                opencodeConfig: process.env['OPENCODE_CONFIG'],
                opencodeConfigDir: process.env['OPENCODE_CONFIG_DIR'],
                dryRun: f['dry-run'] === true,
            });
        }
        catch (error) {
            const message = safeSetupOperationError(error);
            if (json)
                emit({ runtime, action: 'uninstall', files: [], error: message });
            else
                process.stderr.write(`${message}\n`);
            return 1;
        }
        const files = displayResultPaths(r.files, configRoot, scope) ?? [];
        const backups = displayResultPaths(r.backups, configRoot, scope);
        if (!r.ok) {
            const message = safeSetupResultError(r.error);
            if (json)
                emit({ runtime, action: 'uninstall', files: [], error: message });
            else
                process.stderr.write(`${message}\n`);
            return 1;
        }
        if (r.dryRun) {
            if (json)
                emit({ runtime, action: 'uninstall', files, backups, dryRun: true });
            else
                process.stdout.write(files.length ? `dry-run: would remove evolver from: ${files.join(', ')}\n` : 'dry-run: nothing to remove\n');
            return 0;
        }
        if (json)
            emit({ runtime, action: 'uninstall', files, backups });
        else
            process.stdout.write(files.length ? `removed evolver from: ${files.join(', ')}\n` : 'nothing to remove\n');
        return 0;
    }
    const profileDescriptor = profileDescriptorFromFlag(f);
    if (!profileDescriptor.ok) {
        if (json)
            emit({ runtime: runtimeRaw, outcome: 'error', files: [], error: profileDescriptor.error });
        else
            process.stderr.write(`${profileDescriptor.error}\n`);
        return 1;
    }
    const descriptor = profileDescriptor.descriptor;
    if (support.outcome === 'manual') {
        const server = buildServer(f, descriptor);
        // server + --service=<target>: emit a ready service template (#217 slice 4). Print-only — evolver does NOT
        // manage service lifecycle; it just prints a template wiring the EVOLVER_ENV_FILE pointer (never a secret).
        if (runtimeRaw === 'server' && typeof f['service'] === 'string') {
            const target = f['service'];
            if (!SERVICE_TARGETS.includes(target)) {
                const msg = `unknown --service target '${target}' (supported: ${SERVICE_TARGETS.join('|')})`;
                if (json)
                    emit({ runtime: runtimeRaw, outcome: 'manual', files: [], error: msg });
                else
                    process.stderr.write(`${msg}\n`);
                return 1;
            }
            const template = appendAdapterNotes(renderServiceGuidance(target, { exec: buildServiceExec(f, descriptor) }), descriptor.manualHints[runtimeRaw]);
            if (json)
                emit({ runtime: runtimeRaw, outcome: 'manual', files: [], service: target, template });
            else
                process.stdout.write(`${template}\n`);
            return 0;
        }
        // Otherwise: PRECISE manual wiring (#217 slice 2) so manual is actionable, not a dead end.
        const instructions = renderManualWiring(runtimeRaw, { server, hints: descriptor.manualHints[runtimeRaw] ?? [] });
        if (json)
            emit({ runtime: runtimeRaw, outcome: 'manual', files: [], reason: support.reason, instructions });
        else
            process.stdout.write(`${instructions}\n`);
        return 0;
    }
    const server = buildServer(f, descriptor);
    if ((runtime === 'opencode' || runtime === 'kiro') && f['dry-run'] !== true) {
        let runtimeDetected;
        try {
            runtimeDetected = (deps.runtimeAvailable ?? defaultRuntimeAvailable)(runtime, configRoot, scope);
        }
        catch (error) {
            const message = safeSetupOperationError(error);
            if (json)
                emit({ runtime, outcome: 'error', files: [], error: message });
            else
                process.stderr.write(`${message}\n`);
            return 1;
        }
        if (!runtimeDetected) {
            const error = `${runtime} runtime was not detected; install or launch ${runtime === 'opencode' ? 'OpenCode' : 'Kiro'} first, then rerun. No config was written.`;
            if (json)
                emit({ runtime, outcome: 'error', files: [], error });
            else
                process.stderr.write(`${error}\n`);
            return 1;
        }
    }
    if (runtime === 'cursor')
        (deps.emitNonGitWorkspaceNotice ?? maybeEmitNonGitWorkspaceNotice)({ cwd: configRoot });
    // cursor seeds .cursor/rules/evolver.mdc with the CURRENT top REVIEW-APPROVED genes so the file is useful
    // immediately (before the first daemon rewrite) without seeding an unapproved draft (A2a). The renderer thus
    // has a real production caller even without the daemon running.
    const cursorStore = store ?? new assetstore.LocalJsonlProvider(events.assetsDir());
    const cursorGenes = runtime === 'cursor'
        ? await currentTopCursorGenes(cursorStore, review ?? reviewLedgerForStore(cursorStore))
        : undefined;
    let r;
    try {
        r = installInjection(planInjection(runtime, server), {
            configRoot, server, scope,
            ...(typeof f['hook-command'] === 'string' ? { hookCommand: f['hook-command'] } : {}),
            ...(cursorGenes ? { genes: cursorGenes } : {}),
            force: f['force'] === true,
            dryRun: f['dry-run'] === true,
            homeDir: configuredHomeDir(),
            kiroHome: process.env['KIRO_HOME'],
            xdgConfigHome: process.env['XDG_CONFIG_HOME'],
            opencodeConfig: process.env['OPENCODE_CONFIG'],
            opencodeConfigDir: process.env['OPENCODE_CONFIG_DIR'],
        });
    }
    catch (e) {
        // A SUPPORTED runtime whose install THROWS (symlinked adapter path, I/O error) is an install ERROR, not an
        // `unsupported` runtime. Reporting `unsupported` here would tell a bootstrapper the runtime isn't supported and
        // make it stop trying, when the real cause is operational. `error` is a CLI result status (the attempt failed),
        // distinct from the support-matrix `unsupported` (an unrecognized runtime id) (Bugbot #264).
        const msg = safeSetupOperationError(e);
        if (json)
            emit({ runtime, outcome: 'error', files: [], error: msg });
        else
            process.stderr.write(`${msg}\n`);
        return 1;
    }
    if (!r.ok) {
        // Same reasoning for an ok:false install result: a failed install of a supported runtime is `error`, not `unsupported`.
        const message = safeSetupResultError(r.error);
        if (json)
            emit({ runtime, outcome: 'error', files: [], error: message });
        else
            process.stderr.write(`${message}\n`);
        return 1;
    }
    const files = displayResultPaths(r.files, configRoot, scope) ?? [];
    const backups = displayResultPaths(r.backups, configRoot, scope);
    if (r.dryRun) {
        if (json) {
            emit({
                runtime,
                outcome: 'installed',
                files,
                backups,
                dryRun: true,
                ...(r.alreadyInstalled ? { alreadyInstalled: true } : {}),
            });
        }
        else if (r.alreadyInstalled) {
            process.stdout.write('dry-run: evolver already installed (no changes)\n');
        }
        else {
            process.stdout.write(`dry-run: would install evolver (${r.mode}) → ${files.join(', ')}\n`);
        }
        return 0;
    }
    if (r.alreadyInstalled) {
        if (json)
            emit({ runtime, outcome: 'installed', files, alreadyInstalled: true });
        else
            process.stdout.write('evolver already installed (use --force to reinstall)\n');
        return 0;
    }
    if (json)
        emit({ runtime, outcome: 'installed', files, backups, mode: r.mode, verified: r.verified });
    else
        process.stdout.write(`installed evolver (${r.mode}) → ${files.join(', ')}\n`);
    return 0;
}