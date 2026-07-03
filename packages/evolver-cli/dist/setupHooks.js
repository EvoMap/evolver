// `evolver setup-hooks` — wire (or remove) evolver into an agent runtime. Drives the evolver-mcp installer:
// for Claude Code it registers the evolver MCP server AND merges a SessionStart hook so memory is injected at
// session start (the hybrid). `--scope=user` registers into ~/.claude.json so evolver loads in EVERY project
// (the real device-wide scope); `--scope=project` (default) writes the project's own .mcp.json. Deny-nothing:
// it only writes the runtime's own config, is idempotent, refuses symlinked adapter paths, and `--uninstall`
// cleanly removes only evolver's entries.
import { planInjection, installInjection, uninstallInjection, runtimeSupport, renderManualWiring, renderServiceGuidance, SETUP_RUNTIMES, SERVICE_TARGETS } from '@evomap/evolver-mcp';
import { assetstore, events } from '@evomap/evolver-core';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { currentTopCursorGenes } from './cursorRewrite.js';
import { resolveProxyBinPath, resolveStableNodePath } from './lifecycle.js';
import { reviewLedgerForStore } from './reviewFilter.js';
const requireFromHere = createRequire(import.meta.url);
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
const USAGE = `usage: evolver setup-hooks [--runtime=${SETUP_RUNTIMES.join('|')}] [--scope=user|project|global] [--root=<dir>] [--env-file=<path>] [--profile-descriptor=<json>] [--service=${SERVICE_TARGETS.join('|')}] [--uninstall] [--force] [--json] [--hook-command="evolver inject session-start"] [--server-command=<cmd>] [--server-args=a,b] [--service-command=<cmd>] [--service-args=a,b]\n`;
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
export async function runSetupHooks(argv, store, review) {
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
    // installed class: claude-code / codex / cursor: v2 owns a real config writer + uninstaller for these.
    const runtime = runtimeRaw;
    const configRoot = typeof f['root'] === 'string' ? f['root'] : process.cwd();
    // claude-code: user scope targets ~/.claude.json regardless of --root; project scope uses configRoot.
    const scope = scopeResult.scope;
    if (support.outcome === 'installed' && f['uninstall']) {
        const r = uninstallInjection(runtime, { configRoot, scope });
        if (!r.ok) {
            if (json)
                emit({ runtime, action: 'uninstall', files: [], error: r.error ?? 'uninstall failed' });
            else
                process.stderr.write(`${r.error ?? 'uninstall failed'}\n`);
            return 1;
        }
        if (json)
            emit({ runtime, action: 'uninstall', files: r.files });
        else
            process.stdout.write(r.files.length ? `removed evolver from: ${r.files.join(', ')}\n` : 'nothing to remove\n');
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
        });
    }
    catch (e) {
        // A SUPPORTED runtime whose install THROWS (symlinked adapter path, I/O error) is an install ERROR, not an
        // `unsupported` runtime. Reporting `unsupported` here would tell a bootstrapper the runtime isn't supported and
        // make it stop trying, when the real cause is operational. `error` is a CLI result status (the attempt failed),
        // distinct from the support-matrix `unsupported` (an unrecognized runtime id) (Bugbot #264).
        const msg = e instanceof Error ? e.message : String(e);
        if (json)
            emit({ runtime, outcome: 'error', files: [], error: msg });
        else
            process.stderr.write(`${msg}\n`);
        return 1;
    }
    if (!r.ok) {
        // Same reasoning for an ok:false install result: a failed install of a supported runtime is `error`, not `unsupported`.
        if (json)
            emit({ runtime, outcome: 'error', files: [], error: r.error ?? 'install failed' });
        else
            process.stderr.write(`${r.error ?? 'install failed'}\n`);
        return 1;
    }
    if (r.alreadyInstalled) {
        if (json)
            emit({ runtime, outcome: 'installed', files: r.files, alreadyInstalled: true });
        else
            process.stdout.write('evolver already installed (use --force to reinstall)\n');
        return 0;
    }
    if (json)
        emit({ runtime, outcome: 'installed', files: r.files, mode: r.mode });
    else
        process.stdout.write(`installed evolver (${r.mode}) → ${r.files.join(', ')}\n`);
    return 0;
}