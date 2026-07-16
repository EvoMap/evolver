import { spawn } from 'node:child_process';
import { assetstore, events, ops } from '@evomap/evolver-core';
import { loadPriceTable } from '@evomap/evolver-adapter-public';
import { WebUIServer } from '@evomap/evolver-webui';
const USAGE = 'usage: evolver dashboard [--port N] [--no-open]\n';
function parsePort(raw) {
    if (!/^\d+$/.test(raw))
        return null;
    const port = Number(raw);
    return Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : null;
}
function parseDashboardOptions(argv) {
    const options = { help: false, noOpen: false, port: 0 };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i] ?? '';
        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }
        if (arg === '--no-open') {
            options.noOpen = true;
            continue;
        }
        if (arg === '--port') {
            const raw = argv[i + 1];
            if (raw === undefined || raw.startsWith('--'))
                return { ok: false, error: 'missing_port' };
            const port = parsePort(raw);
            if (port === null)
                return { ok: false, error: 'invalid_port' };
            options.port = port;
            i += 1;
            continue;
        }
        if (arg.startsWith('--port=')) {
            const port = parsePort(arg.slice('--port='.length));
            if (port === null)
                return { ok: false, error: 'invalid_port' };
            options.port = port;
            continue;
        }
        return { ok: false, error: 'unknown_argument' };
    }
    return { ok: true, options };
}
function createDashboardServer() {
    const eventsPath = events.rootEventsPath();
    const tracesDir = events.tracesDir();
    const store = new assetstore.LocalJsonlProvider(events.assetsDir());
    const prices = loadPriceTable();
    return new WebUIServer({
        eventsPath,
        store,
        valueSummary: (window, eventSnapshot) => ops.loadValueSummary({
            traces: ops.readTraceRecords(tracesDir),
            events: eventSnapshot,
            prices,
        }, window),
        retentionReport: () => events.buildRetentionReport(),
    });
}
export function dashboardOpenCommand(url, platform = process.platform) {
    if (platform === 'win32')
        return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
    if (platform === 'darwin')
        return { command: 'open', args: [url] };
    return { command: 'xdg-open', args: [url] };
}
async function openDashboardUrl(url) {
    const command = dashboardOpenCommand(url);
    return new Promise((resolve) => {
        const child = spawn(command.command, command.args, {
            detached: true,
            shell: false,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.once('error', () => resolve(false));
        child.once('spawn', () => {
            child.unref();
            resolve(true);
        });
    });
}
function waitForShutdownSignal() {
    return new Promise((resolve) => {
        const finish = () => {
            process.removeListener('SIGINT', finish);
            process.removeListener('SIGTERM', finish);
            resolve();
        };
        process.once('SIGINT', finish);
        process.once('SIGTERM', finish);
    });
}
function isAddressInUse(error) {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'EADDRINUSE';
}
async function listenWithPortFallback(server, requestedPort, maxAttempts) {
    const attempts = requestedPort === 0
        ? 1
        : Math.min(Math.max(1, maxAttempts), 65_536 - requestedPort);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await server.listen(requestedPort + attempt);
        }
        catch (error) {
            if (!isAddressInUse(error) || attempt === attempts - 1)
                throw error;
        }
    }
    throw new Error('dashboard_start_failed');
}
export async function runDashboardCommand(argv, deps = {}, options = {}) {
    const stdout = deps.stdout ?? ((text) => { process.stdout.write(text); });
    const stderr = deps.stderr ?? ((text) => { process.stderr.write(text); });
    const parsed = parseDashboardOptions(argv);
    if (!parsed.ok) {
        stderr(`dashboard: ${parsed.error}\n${USAGE}`);
        return 2;
    }
    if (parsed.options.help) {
        stdout(USAGE);
        return 0;
    }
    const createServer = deps.createServer ?? createDashboardServer;
    const openUrl = deps.openUrl ?? openDashboardUrl;
    const waitForShutdown = deps.waitForShutdown ?? waitForShutdownSignal;
    let server;
    try {
        server = createServer();
    }
    catch {
        stderr('dashboard: dashboard_start_failed\n');
        return 1;
    }
    let listening = false;
    try {
        const port = await listenWithPortFallback(server, parsed.options.port, options.eaddrinusePortAttempts ?? 1);
        listening = true;
        const baseUrl = `http://127.0.0.1:${port}/`;
        const launchUrl = `${baseUrl}launch?ticket=${encodeURIComponent(server.launchTicket)}`;
        if (parsed.options.noOpen) {
            stdout(`dashboard: ${launchUrl}\n`);
        }
        else if (await openUrl(launchUrl)) {
            stdout(`dashboard: ${baseUrl}\n`);
        }
        else {
            stderr('dashboard: browser_open_failed\n');
            stdout(`dashboard: ${launchUrl}\n`);
        }
        await waitForShutdown();
        return 0;
    }
    catch {
        stderr(`dashboard: ${listening ? 'dashboard_runtime_failed' : 'dashboard_start_failed'}\n`);
        return 1;
    }
    finally {
        if (listening) {
            try {
                await server.close();
            }
            catch {
                // The process is already shutting down; avoid replacing the command result with a close race.
            }
        }
    }
}