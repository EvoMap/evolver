import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { assetstore, events, mailbox, ops, personality, workflow } from '@evomap/evolver-core';
import { loadPriceTable } from '@evomap/evolver-adapter-public';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { createGithubPrDiagnosticsProvider, readLogDiagnostics, readPersonalityDiagnostics, WebUIServer, } from '@evomap/evolver-webui';
import { lifecyclePaths } from './lifecycle.js';
import { formatMemoryGraphOperatorStatus, loadMemoryGraphOperatorStatus } from './localMemoryGraph.js';
const USAGE = 'usage: evolver dashboard [--port N] [--no-open]\n';
class DashboardEnvFileUnavailableError extends Error {
    constructor() {
        super('dashboard_env_file_unavailable');
        this.name = 'DashboardEnvFileUnavailableError';
    }
}
function resolveDashboardEnv(env) {
    const resolvedEnv = { ...env };
    const envFile = loadEnvFileFromEnv(resolvedEnv);
    if (envFile.error)
        throw new DashboardEnvFileUnavailableError();
    return resolvedEnv;
}
function dashboardStartupError(error) {
    return error instanceof DashboardEnvFileUnavailableError
        ? 'dashboard_env_file_unavailable'
        : 'dashboard_start_failed';
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}
function stringField(value) {
    return typeof value === 'string' ? value : null;
}
function runSummary(value) {
    const state = record(value);
    if (!state)
        return null;
    const runId = stringField(state['runId']);
    const workflowId = stringField(state['workflowId']);
    const status = stringField(state['status']);
    const createdAt = stringField(state['createdAt']);
    const updatedAt = stringField(state['updatedAt']);
    if (!runId || !workflowId || !status || !createdAt || !updatedAt)
        return null;
    const currentKey = stringField(state['currentStep']);
    const steps = record(state['steps']);
    const currentState = currentKey && steps ? record(steps[currentKey]) : null;
    const currentStep = currentState && currentState['status'] !== 'succeeded'
        ? stringField(currentState['executionId']) ?? stringField(currentState['stepId']) ?? currentKey
        : currentState ? null : currentKey;
    return {
        runId,
        workflowId,
        status,
        currentStep,
        createdAt,
        updatedAt,
        completedAt: stringField(state['completedAt']),
    };
}
function historyRows(value) {
    if (Array.isArray(value))
        return value;
    const envelope = record(value);
    if (!envelope)
        return [];
    if (Array.isArray(envelope['history']))
        return envelope['history'];
    if (Array.isArray(envelope['entries']))
        return envelope['entries'];
    return [];
}
function historyEntry(value, index) {
    const entry = record(value);
    if (!entry)
        return null;
    const actor = record(entry['actor']);
    const timestamp = stringField(entry['timestamp'])
        ?? stringField(entry['createdAt'])
        ?? stringField(entry['at'])
        ?? stringField(entry['ts']);
    const type = stringField(entry['type'])
        ?? stringField(entry['event'])
        ?? stringField(entry['operation'])
        ?? stringField(entry['kind']);
    if (!timestamp || !type)
        return null;
    const rawSequence = entry['sequence'] ?? entry['seq'];
    const sequence = typeof rawSequence === 'number' && Number.isSafeInteger(rawSequence) && rawSequence >= 0
        ? rawSequence
        : index;
    const status = stringField(entry['status']);
    const stepId = stringField(entry['stepId']);
    const executionId = stringField(entry['executionId']);
    const gateId = stringField(entry['gateId']);
    const attempt = typeof entry['attempt'] === 'number' && Number.isSafeInteger(entry['attempt']) && entry['attempt'] >= 0
        ? entry['attempt']
        : null;
    const actorId = stringField(entry['actorId']) ?? stringField(entry['actor']) ?? stringField(actor?.['id']);
    const errorClass = stringField(entry['errorClass']);
    return {
        sequence,
        timestamp,
        type,
        ...(status ? { status } : {}),
        ...(stepId ? { stepId } : {}),
        ...(executionId ? { executionId } : {}),
        ...(gateId ? { gateId } : {}),
        ...(attempt !== null ? { attempt } : {}),
        ...(actorId ? { actorId } : {}),
        ...(errorClass ? { errorClass } : {}),
    };
}
function readDurableHistory(store, runId, state) {
    const candidate = store;
    const reader = candidate.readHistory ?? candidate.listHistory ?? candidate.history;
    if (reader)
        return historyRows(reader.call(store, runId));
    return historyRows(record(state)?.['history']);
}
export function createWorkflowDashboardProvider(store) {
    const read = (runId) => {
        try {
            return store.read(runId);
        }
        catch (error) {
            if (error instanceof workflow.WorkflowStateError && error.code === 'STATE_NOT_FOUND')
                return null;
            throw error;
        }
    };
    return {
        listRuns: () => store.listRunIds()
            .map((runId) => runSummary(read(runId)))
            .filter((run) => run !== null)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.runId.localeCompare(b.runId)),
        getRun: (runId) => runSummary(read(runId)),
        getHistory: (runId) => {
            const state = read(runId);
            if (state === null)
                return null;
            return readDurableHistory(store, runId, state)
                .map(historyEntry)
                .filter((entry) => entry !== null);
        },
    };
}
export function createDashboardWorkflowProvider(env = process.env, defaultStateDir = workflow.defaultWorkflowStateDir) {
    const resolvedEnv = resolveDashboardEnv(env);
    const configuredStateDir = resolvedEnv['EVOLVER_WORKFLOW_STATE_DIR']?.trim();
    const stateDir = configuredStateDir || defaultStateDir();
    return createWorkflowDashboardProvider(new workflow.WorkflowStateStore(stateDir));
}
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
export function createDashboardServer(memoryGraphStatus, env = process.env) {
    const resolvedEnv = resolveDashboardEnv(env);
    const eventsPath = events.rootEventsPath(resolvedEnv);
    const tracesDir = events.tracesDir(resolvedEnv);
    const store = new assetstore.LocalJsonlProvider(events.assetsDir(resolvedEnv));
    const prices = loadPriceTable();
    const personalityStore = new personality.PersonalityStore({
        path: events.personalityStatePath(resolvedEnv),
    });
    const logFile = lifecyclePaths(resolvedEnv).logFile;
    const githubPrDiagnostics = createGithubPrDiagnosticsProvider({ cwd: process.cwd() });
    const mailboxStore = openDashboardMailbox(resolvedEnv);
    const server = new WebUIServer({
        eventsPath,
        store,
        ...(mailboxStore ? { mailbox: mailboxStore } : {}),
        valueSummary: (window, eventSnapshot) => ops.loadValueSummary({
            traces: ops.readTraceRecords(tracesDir),
            events: eventSnapshot,
            prices,
        }, window),
        retentionReport: () => events.buildRetentionReport({
            rootEventsPath: eventsPath,
            materialStorePath: events.materialStorePath(resolvedEnv),
            materialCursorPath: events.materialWatermarkPath(resolvedEnv),
        }),
        personalityDiagnostics: () => readPersonalityDiagnostics(() => personalityStore.load()),
        logDiagnostics: () => readLogDiagnostics(logFile),
        githubPrDiagnostics: () => githubPrDiagnostics.read(),
        memoryGraphStatus,
        workflow: createDashboardWorkflowProvider(resolvedEnv),
    });
    if (!mailboxStore)
        return server;
    let closed = false;
    return {
        token: server.token,
        launchTicket: server.launchTicket,
        listen: (port) => server.listen(port),
        close: async () => {
            if (closed)
                return;
            closed = true;
            try {
                await server.close();
            }
            catch (error) {
                if (error.code !== 'ERR_SERVER_NOT_RUNNING')
                    throw error;
            }
            finally {
                mailboxStore.close();
            }
        },
    };
}
function openDashboardMailbox(env) {
    const configured = env['EVOLVER_PROXY_STORE']?.trim();
    const path = configured || join(events.evomapHome(env), 'proxy', 'mailbox.db');
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink())
            return undefined;
        return new mailbox.MailboxStore({ path });
    }
    catch {
        return undefined;
    }
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
    let env;
    try {
        env = resolveDashboardEnv(deps.env ?? process.env);
    }
    catch (error) {
        stderr(`dashboard: ${dashboardStartupError(error)}\n`);
        return 1;
    }
    const memoryGraphStatus = deps.memoryGraphStatus ?? (() => loadMemoryGraphOperatorStatus(env));
    const openUrl = deps.openUrl ?? openDashboardUrl;
    const waitForShutdown = deps.waitForShutdown ?? waitForShutdownSignal;
    let server;
    try {
        server = createServer(memoryGraphStatus, env);
    }
    catch (error) {
        stderr(`dashboard: ${dashboardStartupError(error)}\n`);
        return 1;
    }
    let listening = false;
    try {
        const port = await listenWithPortFallback(server, parsed.options.port, options.eaddrinusePortAttempts ?? 1);
        listening = true;
        let graphStatus;
        try {
            graphStatus = memoryGraphStatus();
        }
        catch {
            graphStatus = { recovery: 'degraded', compactedRecords: 0, activeRecords: 0, corruptLines: 1, oversizedLines: 0, oversizedFiles: 0, archives: 0 };
        }
        stdout(`dashboard: memory-graph ${formatMemoryGraphOperatorStatus(graphStatus)}\n`);
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
        try {
            await server.close();
        }
        catch {
            // The command result takes precedence over a close race or an unbound HTTP server.
        }
    }
}