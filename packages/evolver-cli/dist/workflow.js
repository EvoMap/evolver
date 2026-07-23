import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { workflow } from '@evomap/evolver-core';
import { loadEnvFileFromEnv } from '@evomap/evolver-mcp';
import { createProductionWorkflowRuntime } from './workflowRuntime.js';
const MAX_SPEC_BYTES = 1_048_576;
const MAX_REASON_LENGTH = 500;
const DEFAULT_ACTOR = 'local-operator';
export const WORKFLOW_SUBCOMMANDS = [
    'start', 'submit', 'list', 'status', 'history', 'pause', 'resume', 'cancel', 'approve', 'reject',
];
class WorkflowCliError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'WorkflowCliError';
    }
}
function usage(stderr) {
    stderr.write([
        'usage:',
        '  evolver workflow start|submit <spec-file> [--run-id <id>] [--state-dir <path>] [--autoexec-home <path>] [--json]',
        '  evolver workflow list [--state-dir <path>] [--autoexec-home <path>] [--json]',
        '  evolver workflow status|history <run-id> [--state-dir <path>] [--autoexec-home <path>] [--json]',
        '  evolver workflow pause|resume|cancel <run-id> [--actor <id>] [--reason <text>] [--state-dir <path>] [--autoexec-home <path>] [--json]',
        '  evolver workflow approve|reject <run-id> <gate-id> [--actor <id>] [--reason <text>] [--state-dir <path>] [--autoexec-home <path>] [--json]',
    ].join('\n') + '\n');
    return 1;
}
function isSubcommand(value) {
    return WORKFLOW_SUBCOMMANDS.includes(value);
}
function allowedValueFlags(command) {
    const flags = new Set(['--state-dir', '--autoexec-home']);
    if (command === 'start' || command === 'submit')
        flags.add('--run-id');
    if (['pause', 'resume', 'cancel', 'approve', 'reject'].includes(command)) {
        flags.add('--actor');
        flags.add('--reason');
    }
    return flags;
}
function expectedPositionals(command) {
    if (command === 'list')
        return 0;
    if (command === 'approve' || command === 'reject')
        return 2;
    return 1;
}
function parseArgs(argv) {
    const command = argv[0];
    if (!isSubcommand(command))
        return null;
    const valueFlags = allowedValueFlags(command);
    const values = new Map();
    const positionals = [];
    let json = false;
    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--json') {
            if (json)
                return null;
            json = true;
            continue;
        }
        if (arg?.startsWith('--')) {
            if (!valueFlags.has(arg) || values.has(arg))
                return null;
            const value = argv[index + 1];
            if (!value || value.startsWith('--'))
                return null;
            values.set(arg, value);
            index += 1;
            continue;
        }
        if (!arg || arg.startsWith('-'))
            return null;
        positionals.push(arg);
    }
    if (positionals.length !== expectedPositionals(command))
        return null;
    return {
        command,
        positionals,
        ...(values.get('--state-dir') ? { stateDir: values.get('--state-dir') } : {}),
        ...(values.get('--autoexec-home') ? { autoExecHome: values.get('--autoexec-home') } : {}),
        ...(values.get('--run-id') ? { runId: values.get('--run-id') } : {}),
        ...(values.get('--actor') ? { actor: values.get('--actor') } : {}),
        ...(values.has('--reason') ? { reason: values.get('--reason') } : {}),
        json,
    };
}
function validateId(value, label) {
    workflow.assertStableId(value, label);
    return value;
}
function validateReason(reason) {
    if (reason === undefined || reason.length === 0)
        return undefined;
    const hasControlCharacter = [...reason].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
    });
    if (reason.length > MAX_REASON_LENGTH || hasControlCharacter || workflow.containsWorkflowSensitiveText(reason)) {
        throw new WorkflowCliError('INVALID_REASON');
    }
    return reason;
}
function controlOptions(parsed) {
    const actor = validateId(parsed.actor ?? DEFAULT_ACTOR, 'actor');
    const reason = validateReason(parsed.reason);
    return { actor, ...(reason ? { reason } : {}) };
}
function parseWorkflowSpec(path) {
    const absolutePath = resolve(path);
    let stat;
    try {
        stat = lstatSync(absolutePath);
    }
    catch {
        throw new WorkflowCliError('SPEC_NOT_FOUND');
    }
    if (stat.isSymbolicLink() || !stat.isFile())
        throw new WorkflowCliError('INVALID_SPEC_PATH');
    if (stat.size > MAX_SPEC_BYTES)
        throw new WorkflowCliError('SPEC_TOO_LARGE');
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(absolutePath, 'utf8'));
    }
    catch {
        throw new WorkflowCliError('INVALID_SPEC_JSON');
    }
    try {
        workflow.assertValidWorkflowSpec(parsed);
    }
    catch {
        throw new WorkflowCliError('INVALID_WORKFLOW_SPEC');
    }
    return parsed;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function statusPayload(state) {
    const candidate = state.currentStep ? state.steps[state.currentStep] : undefined;
    const current = candidate?.status === 'succeeded' ? undefined : candidate;
    return {
        schemaVersion: state.schemaVersion,
        workflowId: state.workflowId,
        runId: state.runId,
        workflowName: safeString(state.workflowName, 256),
        status: state.status,
        currentStep: current?.executionId ?? null,
        currentStepId: current?.stepId ?? null,
        attempts: current?.attempts ?? 0,
        maxAttempts: current?.maxAttempts ?? 0,
        lastErrorClass: safeMetadataToken(state.lastErrorClass),
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        completedAt: state.completedAt ?? null,
    };
}
function safeString(value, maxLength = 500) {
    if (typeof value !== 'string' || value.length > maxLength || workflow.containsWorkflowSensitiveText(value))
        return null;
    const hasControlCharacter = [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
    });
    return hasControlCharacter ? null : value;
}
function safeMetadataToken(value) {
    const candidate = safeString(value, 64);
    return candidate !== null && /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : null;
}
function historyPayload(entry) {
    if (!isRecord(entry))
        return { type: 'unknown' };
    const output = {};
    const numberFields = ['sequence', 'seq', 'attempt'];
    for (const key of numberFields) {
        if (typeof entry[key] === 'number' && Number.isFinite(entry[key]))
            output[key] = entry[key];
    }
    const idFields = ['id', 'eventId', 'runId', 'workflowId', 'executionId', 'stepId', 'gateId'];
    for (const key of idFields) {
        const value = safeString(entry[key], 128);
        if (value !== null)
            output[key] = value;
    }
    const enumFields = ['type', 'event', 'operation', 'kind', 'action', 'status', 'previousStatus', 'nextStatus', 'errorClass'];
    for (const key of enumFields) {
        const value = safeString(entry[key], 64);
        if (value !== null)
            output[key] = value;
    }
    const actorRecord = isRecord(entry['actor']) ? entry['actor'] : null;
    const actor = safeString(entry['actorId'], 128) ?? safeString(entry['actor'], 128) ?? safeString(actorRecord?.['id'], 128);
    if (actor !== null)
        output['actor'] = actor;
    const reason = safeString(entry['reason'], MAX_REASON_LENGTH);
    if (reason !== null)
        output['reason'] = reason;
    for (const key of ['timestamp', 'at', 'ts', 'createdAt']) {
        const value = safeString(entry[key], 64);
        if (value !== null)
            output[key] = value;
    }
    return Object.keys(output).length > 0 ? output : { type: 'unknown' };
}
function historyRows(value) {
    if (Array.isArray(value))
        return value;
    if (!isRecord(value))
        return [];
    if (Array.isArray(value['history']))
        return value['history'];
    if (Array.isArray(value['entries']))
        return value['entries'];
    return [];
}
function readHistory(store, runId) {
    if (store.readHistory)
        return historyRows(store.readHistory(runId));
    if (store.listHistory)
        return historyRows(store.listHistory(runId));
    if (store.history)
        return historyRows(store.history(runId));
    const state = store.read(runId);
    if (isRecord(state) && Array.isArray(state['history']))
        return state['history'];
    throw new WorkflowCliError('HISTORY_NOT_SUPPORTED');
}
function errorCode(error, command) {
    if (error instanceof WorkflowCliError)
        return error.code;
    if (error instanceof workflow.WorkflowStateError || error instanceof workflow.WorkflowRuntimeError)
        return error.code;
    if (error instanceof workflow.WorkflowRunFailedError)
        return 'RUN_FAILED';
    return `WORKFLOW_${command.toUpperCase()}_FAILED`;
}
function createDefaultRuntime(stateDir, options = {}) {
    return createProductionWorkflowRuntime({ ...options, stateDir });
}
function writeJson(stream, payload) {
    stream.write(`${JSON.stringify(payload)}\n`);
}
function writeStatusText(stream, payload) {
    stream.write([
        `run=${String(payload['runId'])}`,
        `workflow=${String(payload['workflowId'])}`,
        `status=${String(payload['status'])}`,
        `step=${String(payload['currentStepId'] ?? '-')}`,
        `attempts=${String(payload['attempts'])}/${String(payload['maxAttempts'])}`,
        `error=${String(payload['lastErrorClass'] ?? '-')}`,
    ].join(' ') + '\n');
}
async function invokeControl(runtime, store, parsed) {
    const command = parsed.command;
    const runId = validateId(parsed.positionals[0] ?? '', 'runId');
    const options = controlOptions(parsed);
    if (command === 'approve' || command === 'reject') {
        const gateId = validateId(parsed.positionals[1] ?? '', 'gateId');
        const runtimeMethod = runtime[command];
        if (runtimeMethod) {
            await runtimeMethod.call(runtime, runId, gateId, options);
            return;
        }
        const storeMethod = store[command];
        if (!storeMethod)
            throw new WorkflowCliError('CONTROL_NOT_SUPPORTED');
        storeMethod.call(store, runId, gateId, options);
        return;
    }
    const runtimeMethod = runtime[command];
    if (runtimeMethod) {
        await runtimeMethod.call(runtime, runId, options);
        return;
    }
    if (command === 'pause' && store.requestPause) {
        store.requestPause(runId, options);
        return;
    }
    if (command === 'cancel' && store.requestCancel) {
        store.requestCancel(runId, options);
        return;
    }
    throw new WorkflowCliError('CONTROL_NOT_SUPPORTED');
}
export async function runWorkflowCommand(argv, deps = {}) {
    const stdout = deps.stdout ?? process.stdout;
    const stderr = deps.stderr ?? process.stderr;
    const parsed = parseArgs(argv);
    if (!parsed)
        return usage(stderr);
    const env = { ...(deps.productionRuntimeOptions?.env ?? process.env) };
    const envFile = loadEnvFileFromEnv(env);
    if (envFile.error) {
        if (parsed.json)
            writeJson(stdout, { ok: false, command: parsed.command, error: 'ENV_FILE_UNAVAILABLE' });
        else
            stderr.write(`workflow ${parsed.command} failed: ENV_FILE_UNAVAILABLE\n`);
        return 1;
    }
    const configuredStateDir = env['EVOLVER_WORKFLOW_STATE_DIR']?.trim();
    const stateDir = parsed.stateDir
        ?? deps.stateDir
        ?? (configuredStateDir || workflow.defaultWorkflowStateDir());
    const runtimeOptions = {
        ...deps.productionRuntimeOptions,
        env,
        ...(parsed.autoExecHome ? { autoExecHome: parsed.autoExecHome } : {}),
    };
    const createStore = deps.createStore ?? ((root) => new workflow.WorkflowStateStore(root));
    const createRuntime = deps.createRuntime
        ?? ((root) => createDefaultRuntime(root, runtimeOptions));
    let runId;
    try {
        if (parsed.command === 'start' || parsed.command === 'submit') {
            const spec = parseWorkflowSpec(parsed.positionals[0] ?? '');
            if (parsed.runId)
                runId = validateId(parsed.runId, 'runId');
            const result = await createRuntime(stateDir).start(spec, parsed.runId ? { runId: parsed.runId } : {});
            if (!isRecord(result) || typeof result['runId'] !== 'string')
                throw new WorkflowCliError('INVALID_RUNTIME_RESULT');
            runId = validateId(result['runId'], 'runId');
            const payload = {
                ok: true,
                runId,
                workflowId: safeString(result['workflowId'], 128),
                status: safeString(result['status'], 64),
            };
            if (parsed.json)
                writeJson(stdout, payload);
            else
                stdout.write(`run=${runId} workflow=${String(payload.workflowId ?? '-')} status=${String(payload.status ?? '-')}\n`);
            return 0;
        }
        const store = createStore(stateDir);
        if (parsed.command === 'list') {
            const runs = store.listRunIds().map((id) => statusPayload(store.read(validateId(id, 'runId'))));
            if (parsed.json)
                writeJson(stdout, { ok: true, runs });
            else
                for (const payload of runs)
                    writeStatusText(stdout, payload);
            return 0;
        }
        runId = validateId(parsed.positionals[0] ?? '', 'runId');
        if (parsed.command === 'status') {
            const payload = statusPayload(store.read(runId));
            if (parsed.json)
                writeJson(stdout, { ok: true, ...payload });
            else
                writeStatusText(stdout, payload);
            return 0;
        }
        if (parsed.command === 'history') {
            const history = readHistory(store, runId).map(historyPayload);
            if (parsed.json)
                writeJson(stdout, { ok: true, runId, history });
            else
                for (const entry of history)
                    stdout.write(`${JSON.stringify(entry)}\n`);
            return 0;
        }
        await invokeControl(createRuntime(stateDir), store, parsed);
        const payload = statusPayload(store.read(runId));
        if (parsed.json)
            writeJson(stdout, { ok: true, operation: parsed.command, ...payload });
        else
            stdout.write(`run=${runId} operation=${parsed.command} status=${String(payload['status'])}\n`);
        return 0;
    }
    catch (error) {
        const code = errorCode(error, parsed.command);
        if (parsed.json)
            writeJson(stdout, { ok: false, command: parsed.command, ...(runId ? { runId } : {}), error: code });
        else
            stderr.write(`workflow ${parsed.command} failed: ${code}\n`);
        return 1;
    }
}