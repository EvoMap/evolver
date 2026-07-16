import { isAbsolute, relative, resolve } from 'node:path';
import { runAutoExec } from './autoexec.js';
import { runDashboardCommand } from './dashboard.js';
export const V1_COMPAT_LIFECYCLE = {
    supportedThrough: '2.x',
    earliestRemoval: '3.0.0',
    removalNotice: 'at least one public 2.x release',
};
const RUN_USAGE = 'usage: evolver run [-v | --verbose] [--loop | --mad-dog] [--json]\n';
const SOLIDIFY_USAGE = 'usage: evolver solidify [--dry-run] [--json]\n';
const FETCH_USAGE = 'usage: evolver fetch (--skill <id> | -s <id> | <id>) [--out <dir>] [--force] [--json]\n';
const WEBUI_USAGE = 'usage: evolver webui [--port N] [--no-open]\n';
const V1_WEBUI_DEFAULT_PORT = 19_821;
const V1_WEBUI_PORT_ATTEMPTS = 50;
function io(deps) {
    return {
        stdout: deps.stdout ?? ((text) => { process.stdout.write(text); }),
        stderr: deps.stderr ?? ((text) => { process.stderr.write(text); }),
    };
}
function lifecycleNotice() {
    return `supported through ${V1_COMPAT_LIFECYCLE.supportedThrough}; earliest removal ${V1_COMPAT_LIFECYCLE.earliestRemoval} after warning in ${V1_COMPAT_LIFECYCLE.removalNotice}`;
}
function humanDeprecation(command, replacement, deps) {
    io(deps).stderr(`[deprecated] evolver ${command} is a V1 compatibility shim; migrate to ${replacement} (${lifecycleNotice()}).\n`);
}
function migrationEnvelope(command, replacement, details = {}) {
    return `${JSON.stringify({
        ok: false,
        group: 'cli.compat.v1',
        command,
        reason: 'migration_required',
        deprecated: true,
        replacement,
        lifecycle: V1_COMPAT_LIFECYCLE,
        ...details,
    })}\n`;
}
function safeArgumentLabel(raw) {
    const flag = raw.split('=', 1)[0] ?? '';
    if (/^--[A-Za-z0-9][A-Za-z0-9-]*$/.test(flag))
        return flag;
    if (/^-[A-Za-z0-9]$/.test(flag))
        return flag;
    return '[redacted]';
}
function unsupportedArgumentMessage(raw, replacement) {
    return `unsupported V1 argument ${safeArgumentLabel(raw)}; ${replacement}`;
}
function fail(command, message, usage, json, deps) {
    const output = io(deps);
    if (json) {
        output.stdout(`${JSON.stringify({
            ok: false,
            group: 'cli.compat.v1',
            command,
            reason: 'unsupported_argument',
            deprecated: true,
            lifecycle: V1_COMPAT_LIFECYCLE,
            message,
        })}\n`);
    }
    else {
        output.stderr(`${command}: ${message}\n${usage}`);
    }
    return 2;
}
function migrationRequired(command, replacement, message, json, deps, details = {}) {
    const output = io(deps);
    if (json) {
        output.stdout(migrationEnvelope(command, replacement, { message, ...details }));
    }
    else {
        humanDeprecation(command, `\`${replacement}\``, deps);
        output.stderr(`${command}: ${message}\nNo compatibility action was performed.\n`);
    }
    return 2;
}
export async function runV1RunCompat(argv, deps = {}) {
    const json = argv.includes('--json');
    if (argv.includes('--help') || argv.includes('-h')) {
        io(deps).stdout(RUN_USAGE);
        return 0;
    }
    const allowed = new Set(['-v', '--verbose', '--loop', '--mad-dog', '--json']);
    const unsupported = argv.find((arg) => !allowed.has(arg));
    if (unsupported) {
        return fail('run', unsupportedArgumentMessage(unsupported, 'use `evolver autoexec [home]` and configure allowedRoots'), RUN_USAGE, json, deps);
    }
    if (argv.includes('--mad-dog')) {
        return migrationRequired('run', 'evolver autoexec --solo (explicit opt-in after reviewing its rollback semantics)', 'V1 mad-dog has no safe automatic V2 equivalent; V2 autoexec --solo may discard working-tree changes with git reset --hard and git clean -fd after a failed cycle; review the V2 solo contract and invoke it explicitly only from a clean, backed-up worktree', json, deps, { mode: 'no_action', requestedMode: 'mad_dog' });
    }
    const verbosity = argv.includes('-v') || argv.includes('--verbose');
    if (argv.includes('--loop') && json) {
        return fail('run', unsupportedArgumentMessage('--json', 'JSON output is only available for fail-closed V1 migration results'), RUN_USAGE, true, deps);
    }
    const modeArgs = argv.filter((arg) => arg !== '-v' && arg !== '--verbose' && arg !== '--json');
    if (modeArgs.length === 0) {
        return migrationRequired('run', 'evolver autoexec', 'V1 one-shot run has no safe V2 equivalent; autoexec is a resident daemon and cannot preserve one-shot lifecycle semantics', json, deps, { mode: 'one_shot' });
    }
    humanDeprecation('run', '`evolver autoexec`', deps);
    if (verbosity) {
        io(deps).stderr('run: V1 verbosity maps to V2 standard logging; exact V1 verbose output is not preserved.\n');
    }
    return (deps.autoexec ?? runAutoExec)([]);
}
export async function runV1SolidifyCompat(argv, deps = {}) {
    const json = argv.includes('--json');
    if (argv.includes('--help') || argv.includes('-h')) {
        io(deps).stdout(SOLIDIFY_USAGE);
        return 0;
    }
    const allowed = new Set(['--dry-run', '--json']);
    const unsupported = argv.find((arg) => !allowed.has(arg));
    if (unsupported) {
        return fail('solidify', unsupportedArgumentMessage(unsupported, 'use `evolver cycle`, `evolver review`, and `evolver publish` explicitly'), SOLIDIFY_USAGE, json, deps);
    }
    return migrationRequired('solidify', 'evolver cycle; evolver review; evolver publish', 'V1 solidify cannot be mapped safely; no cycle, review, validation, or publish action was performed', json, deps, { mode: 'read_only' });
}
function readValue(argv, index, flag) {
    const token = argv[index] ?? '';
    if (token.startsWith(`${flag}=`)) {
        const value = token.slice(flag.length + 1);
        return value && !value.startsWith('-')
            ? { value, next: index }
            : { next: index, error: `${flag} requires a value` };
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('-'))
        return { next: index, error: `${flag} requires a value` };
    return { value, next: index + 1 };
}
function resolveContainedOutDir(rawOut, cwd) {
    const root = resolve(cwd);
    const candidate = resolve(root, rawOut);
    const fromRoot = relative(root, candidate);
    if (fromRoot === '..' || fromRoot.startsWith('../') || fromRoot.startsWith('..\\') || isAbsolute(fromRoot)) {
        return { ok: false, message: '--out must resolve to a path inside the current working directory' };
    }
    return { ok: true, requestedOut: fromRoot === '' ? '.' : '<inside-cwd>' };
}
function parseFetch(argv, cwd) {
    let skillId;
    let rawOutDir = '.';
    let force = false;
    const json = argv.includes('--json');
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index] ?? '';
        if (token === '--json')
            continue;
        if (token === '--force') {
            force = true;
            continue;
        }
        if (token === '--skill' || token === '-s') {
            const read = readValue(argv, index, token);
            if (read.error)
                return { ok: false, message: read.error, json };
            if (skillId)
                return { ok: false, message: 'skill id may be provided only once', json };
            skillId = read.value;
            index = read.next;
            continue;
        }
        if (token.startsWith('--skill=') || token.startsWith('-s=')) {
            const flag = token.startsWith('--skill=') ? '--skill' : '-s';
            const read = readValue(argv, index, flag);
            if (read.error)
                return { ok: false, message: read.error, json };
            if (skillId)
                return { ok: false, message: 'skill id may be provided only once', json };
            skillId = read.value;
            continue;
        }
        if (token === '--out' || token.startsWith('--out=')) {
            const read = readValue(argv, index, '--out');
            if (read.error)
                return { ok: false, message: read.error, json };
            rawOutDir = read.value;
            index = read.next;
            continue;
        }
        if (!token.startsWith('-') && !skillId) {
            skillId = token;
            continue;
        }
        return {
            ok: false,
            message: unsupportedArgumentMessage(token, 'use `evolver skill fetch --asset <gene-id> --write --out <dir>`'),
            json,
        };
    }
    if (!skillId)
        return { ok: false, message: 'missing skill id', json };
    const outDir = resolveContainedOutDir(rawOutDir, cwd);
    if (!outDir.ok)
        return { ok: false, message: outDir.message, json };
    return { ok: true, value: { skillId, requestedOut: outDir.requestedOut, force, json } };
}
export async function runV1FetchCompat(argv, deps = {}) {
    if (argv.includes('--help') || argv.includes('-h')) {
        io(deps).stdout(FETCH_USAGE);
        return 0;
    }
    const parsed = parseFetch(argv, (deps.cwd ?? process.cwd)());
    if (!parsed.ok)
        return fail('fetch', parsed.message, FETCH_USAGE, parsed.json, deps);
    const options = parsed.value;
    return migrationRequired('fetch', 'evolver skill fetch --asset <gene-id> --write --out <dir>', 'V1 Skill Store IDs and bundled-files installs cannot be mapped to the V2 Gene-only fetch contract; provide a V2 Gene asset id and migrate explicitly', options.json, deps, {
        mode: 'no_write',
        requestedOut: options.requestedOut,
        forceRequested: options.force,
    });
}
export async function runV1WebuiCompat(argv, deps = {}) {
    if (argv.includes('--help') || argv.includes('-h')) {
        io(deps).stdout(WEBUI_USAGE);
        return 0;
    }
    let explicitPort;
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index] ?? '';
        if (token === '--no-open')
            continue;
        if (token === '--port' || token.startsWith('--port=')) {
            const read = readValue(argv, index, '--port');
            if (read.error)
                return fail('webui', read.error, WEBUI_USAGE, false, deps);
            explicitPort = read.value;
            index = read.next;
            continue;
        }
        return fail('webui', unsupportedArgumentMessage(token, 'use `evolver dashboard --help`'), WEBUI_USAGE, false, deps);
    }
    const configuredPort = (deps.env ?? process.env)['EVOLVER_WEBUI_PORT'];
    const envPort = configuredPort && /^\d+$/.test(configuredPort)
        ? Number(configuredPort)
        : Number.NaN;
    const port = explicitPort
        ?? (Number.isSafeInteger(envPort) && envPort > 0 && envPort <= 65_535
            ? String(envPort)
            : String(V1_WEBUI_DEFAULT_PORT));
    const mapped = ['--port', port, '--no-open'];
    const dashboardOptions = { eaddrinusePortAttempts: V1_WEBUI_PORT_ATTEMPTS };
    humanDeprecation('webui', '`evolver dashboard`', deps);
    if (deps.dashboard)
        return deps.dashboard(mapped, dashboardOptions);
    return runDashboardCommand(mapped, {}, dashboardOptions);
}