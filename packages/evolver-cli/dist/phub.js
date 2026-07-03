import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { expandHomePath } from '@evomap/evolver-mcp';
import { runDoctor } from './doctor.js';
const USAGE = [
    'usage: evolver phub <doctor|status> [--root <dir>] [--json] [--env-catalog]',
    '       evolver phub init --env-file <path> [--hub <url>] [--subject <id>] [--adapter-module <module>] [--profile-descriptor <json>] [--force] [--json]',
    '',
].join('\n');
function parseFlags(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a?.startsWith('--'))
            continue;
        const key = a.slice(2);
        const eq = key.indexOf('=');
        if (eq >= 0)
            out[key.slice(0, eq)] = key.slice(eq + 1);
        else if (argv[i + 1] && !argv[i + 1].startsWith('--'))
            out[key] = argv[++i];
        else
            out[key] = true;
    }
    return out;
}
function stringFlag(flags, name) {
    const value = flags[name];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
function missingFlagValue(flags, name) {
    return flags[name] === true || (typeof flags[name] === 'string' && flags[name].trim().length === 0);
}
function resolveInitPath(raw, cwd) {
    const expanded = raw.startsWith('~') ? expandHomePath(raw) : raw;
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
function rejectControlValue(label, value) {
    return /[\0\r\n]/.test(value) ? `--${label} must be a single-line value` : undefined;
}
function validateHubUrl(value) {
    const control = rejectControlValue('hub', value);
    if (control)
        return control;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:')
            return '--hub must use http or https';
    }
    catch {
        return '--hub must be a valid URL';
    }
    return undefined;
}
function parseInitOptions(argv, cwd) {
    const flags = parseFlags(argv);
    const json = flags['json'] === true;
    if (flags['help'] === true || flags['h'] === true)
        return { ok: false, error: USAGE, json };
    if (missingFlagValue(flags, 'env-file'))
        return { ok: false, error: 'missing value for --env-file', json };
    if (missingFlagValue(flags, 'profile-descriptor'))
        return { ok: false, error: 'missing value for --profile-descriptor', json };
    const envFileRaw = stringFlag(flags, 'env-file');
    if (!envFileRaw)
        return { ok: false, error: 'phub init requires --env-file <path>', json };
    const hubUrl = stringFlag(flags, 'hub') ?? 'https://private-hub-test.example.com';
    const adapterModule = stringFlag(flags, 'adapter-module') ?? '@evomap/evolver-adapter-private';
    const subject = stringFlag(flags, 'subject');
    const profileRaw = stringFlag(flags, 'profile-descriptor');
    for (const [label, value] of [
        ['env-file', envFileRaw],
        ['adapter-module', adapterModule],
        ...(subject ? [['subject', subject]] : []),
        ...(profileRaw ? [['profile-descriptor', profileRaw]] : []),
    ]) {
        const error = rejectControlValue(label, value);
        if (error)
            return { ok: false, error, json };
    }
    const hubError = validateHubUrl(hubUrl);
    if (hubError)
        return { ok: false, error: hubError, json };
    return {
        ok: true,
        opts: {
            envFile: resolveInitPath(envFileRaw, cwd),
            hubUrl,
            ...(subject ? { subject } : {}),
            adapterModule,
            ...(profileRaw ? { profileDescriptor: resolveInitPath(profileRaw, cwd) } : {}),
            force: flags['force'] === true,
            json,
        },
    };
}
function renderEnvFile(opts) {
    return [
        '# PHub private runtime env file.',
        '# Keep real credentials here only; runtime configs should reference this file through EVOLVER_ENV_FILE.',
        'EVOMAP_HUB_MODE=private',
        `EVOMAP_HUB_URL=${opts.hubUrl}`,
        '# Fill exactly one enterprise token alias before running live smoke or evolver-proxy.',
        '# EVOMAP_ENTERPRISE_TOKEN=replace-with-enterprise-token',
        '# EVOMAP_PRIVATE_HUB_TOKEN=replace-with-enterprise-token',
        opts.subject ? `EVOMAP_ENTERPRISE_SUBJECT=${opts.subject}` : '# EVOMAP_ENTERPRISE_SUBJECT=alice@example.com',
        `EVOMAP_PRIVATE_ADAPTER_MODULE=${opts.adapterModule}`,
        '',
        '# Local loopback proxy settings. Replace the IPC token with a long random value before real use.',
        '# EVOLVER_IPC_TOKEN=replace-with-long-random-ipc-token',
        'EVOLVER_PROXY_URL=http://127.0.0.1:19820',
        'EVOLVER_REUSE_BEFORE_SOLVE=1',
        'NO_PROXY=127.0.0.1,localhost,::1',
        '',
    ].join('\n');
}
function renderProfileDescriptor(opts) {
    return `${JSON.stringify({
        envFile: opts.envFile,
        manualHints: {
            'http-agent': [
                'Use the PHub HTTP/A2A endpoint supplied by the enterprise adapter.',
                'Keep Authorization material in EVOLVER_ENV_FILE; do not inline bearer tokens in runtime config.',
            ],
            openclaw: [
                'Register the OpenClaw MCP bridge with the evolver MCP stdio server.',
            ],
        },
    }, null, 2)}\n`;
}
function writeChecked(path, content, deps, mode, overwrite) {
    deps.mkdir(dirname(path), { recursive: true });
    deps.writeFile(path, content, { encoding: 'utf8', mode, flag: overwrite ? 'w' : 'wx' });
}
function initTargetKey(path) {
    const key = resolve(path);
    return process.platform === 'win32' ? key.toLowerCase() : key;
}
function reportInitError(opts, error) {
    if (opts.json)
        process.stdout.write(`${JSON.stringify({ ok: false, error })}\n`);
    else
        process.stderr.write(`${error}\n`);
}
function backupInitTargets(targets, exists, readFile) {
    const backups = new Map();
    for (const path of targets) {
        if (!exists(path)) {
            backups.set(initTargetKey(path), { path, existed: false });
            continue;
        }
        try {
            backups.set(initTargetKey(path), { path, existed: true, content: readFile(path) });
        }
        catch (error) {
            return { ok: false, error: `phub init failed to read existing file before overwrite: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
    return { ok: true, backups };
}
function uniqueRollbackPaths(paths) {
    const seen = new Set();
    const unique = [];
    for (const path of paths) {
        const key = initTargetKey(path);
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(path);
    }
    return unique;
}
function rollbackInitWrites(paths, backups, writer) {
    for (const path of uniqueRollbackPaths(paths).reverse()) {
        const backup = backups.get(initTargetKey(path));
        try {
            if (backup?.existed)
                writeChecked(path, backup.content ?? '', writer, 0o600, true);
            else
                writer.removeFile(path);
        }
        catch {
            // Best-effort cleanup only. Preserve the original write error for the operator.
        }
    }
}
function runPhubInit(argv, deps = {}) {
    const parsed = parseInitOptions(argv, deps.cwd ?? process.cwd());
    if (!parsed.ok) {
        if (parsed.json)
            process.stdout.write(`${JSON.stringify({ ok: false, error: parsed.error })}\n`);
        else {
            const stream = parsed.error === USAGE ? process.stdout : process.stderr;
            stream.write(`${parsed.error}${parsed.error.endsWith('\n') ? '' : '\n'}${parsed.error === USAGE ? '' : USAGE}`);
        }
        return parsed.error === USAGE ? 0 : 1;
    }
    const opts = parsed.opts;
    if (opts.profileDescriptor && initTargetKey(opts.profileDescriptor) === initTargetKey(opts.envFile)) {
        reportInitError(opts, 'phub init requires --env-file and --profile-descriptor to point to different files');
        return 1;
    }
    const exists = deps.exists ?? existsSync;
    const targets = [opts.envFile, ...(opts.profileDescriptor ? [opts.profileDescriptor] : [])];
    const existing = targets.filter((path) => exists(path));
    if (existing.length > 0 && !opts.force) {
        reportInitError(opts, `phub init refused to overwrite existing file(s): ${existing.join(', ')} (use --force to overwrite)`);
        return 1;
    }
    const writer = {
        writeFile: deps.writeFile ?? ((path, content, options) => writeFileSync(path, content, options)),
        mkdir: deps.mkdir ?? ((path, options) => { mkdirSync(path, options); }),
        removeFile: deps.removeFile ?? ((path) => { rmSync(path, { force: true }); }),
    };
    const writes = [
        ...(opts.profileDescriptor ? [{ path: opts.profileDescriptor, content: renderProfileDescriptor(opts) }] : []),
        { path: opts.envFile, content: renderEnvFile(opts) },
    ];
    const reader = deps.readFile ?? ((path) => readFileSync(path, 'utf8'));
    const backup = backupInitTargets(writes.map((write) => write.path), exists, reader);
    if (!backup.ok) {
        reportInitError(opts, backup.error);
        return 1;
    }
    const created = [];
    let activePath;
    try {
        for (const write of writes) {
            activePath = write.path;
            writeChecked(write.path, write.content, writer, 0o600, opts.force);
            created.push(write.path);
            activePath = undefined;
        }
    }
    catch (error) {
        rollbackInitWrites([...created, ...(activePath ? [activePath] : [])], backup.backups, writer);
        const message = `phub init failed to write file: ${error instanceof Error ? error.message : String(error)}`;
        reportInitError(opts, message);
        return 1;
    }
    const next = [
        `edit ${opts.envFile} and set exactly one enterprise token alias`,
        `run evolver phub doctor --root <runtime-config-root> with EVOLVER_ENV_FILE=${opts.envFile}`,
        opts.profileDescriptor
            ? `run evolver setup-hooks --runtime=codex --profile-descriptor=${opts.profileDescriptor}`
            : `run evolver setup-hooks --runtime=codex --env-file=${opts.envFile}`,
        `start evolver-proxy with EVOLVER_ENV_FILE=${opts.envFile}`,
    ];
    const result = {
        envFile: opts.envFile,
        ...(opts.profileDescriptor ? { profileDescriptor: opts.profileDescriptor } : {}),
        created,
        next,
    };
    if (opts.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    }
    else {
        process.stdout.write([
            `created PHub env file: ${opts.envFile}`,
            ...(opts.profileDescriptor ? [`created PHub profile descriptor: ${opts.profileDescriptor}`] : []),
            '',
            'next:',
            ...next.map((line, i) => `  ${i + 1}. ${line}`),
            '',
        ].join('\n'));
    }
    return 0;
}
export async function runPhubCommand(argv, deps = {}) {
    const sub = argv[0];
    if (sub === 'init') {
        return runPhubInit(argv.slice(1), deps);
    }
    if (sub === 'doctor' || sub === 'status') {
        return runDoctor(['--private-runtime', ...argv.slice(1)], { ...deps, label: `evolver phub ${sub}` });
    }
    if (sub === undefined || sub === '--help' || sub === '-h') {
        process.stdout.write(USAGE);
        return 0;
    }
    process.stderr.write(USAGE);
    return 1;
}