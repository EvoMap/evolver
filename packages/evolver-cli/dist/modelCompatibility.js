import { compatibility, exec, verify } from '@evomap/evolver-core';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
const MAX_INPUT = 2 * 1024 * 1024;
const MAX_CASES = 256;
const EXIT_USAGE = 2;
const EXIT_RUNTIME = 3;
const EXIT_QUARANTINE = 4;
const RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        status: { type: 'string', enum: ['completed'] },
        task_family: { type: 'string' },
        input_digest: { type: 'string' },
        mode: { type: 'string', enum: ['baseline', 'asset-enabled'] },
    },
    required: ['status', 'task_family', 'input_digest', 'mode'],
};
function flag(argv, name) {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
}
function output(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(message, code) { process.stderr.write(`[model-compatibility-replay] ${message}\n`); return code; }
function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    return value;
}
function boundedJson(path) {
    const raw = readFileSync(path, 'utf8');
    if (Buffer.byteLength(raw) > MAX_INPUT)
        throw new Error('input exceeds 2 MiB');
    return JSON.parse(raw);
}
function positiveNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        throw new Error(`${label} must be positive`);
    return value;
}
function runnerDefinition(value) {
    if (value === undefined)
        return { kind: 'claude-cli' };
    const input = object(value, 'runner');
    const kind = input.kind === 'fixture' ? 'fixture' : input.kind === 'claude-cli' ? 'claude-cli' : undefined;
    if (!kind)
        throw new Error('runner.kind must be claude-cli or fixture');
    return {
        kind,
        ...(typeof input.executable === 'string' ? { executable: input.executable.slice(0, 512) } : {}),
        ...(Array.isArray(input.argv) ? { argv: input.argv.filter((item) => typeof item === 'string').slice(0, 64) } : {}),
        ...(Array.isArray(input.setupFiles) ? { setupFiles: input.setupFiles.filter((item) => typeof item === 'string').slice(0, 64) } : {}),
    };
}
function assertWithinRoot(root, value, label) {
    if (isAbsolute(value))
        throw new Error(`${label} must be relative to --cwd`);
    const target = resolve(root, value);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw new Error(`${label} escapes --cwd`);
    return target;
}
function replayCase(value, root) {
    const input = object(value, 'case');
    const asset = object(input.asset, 'asset');
    for (const key of ['type', 'id', 'revision'])
        if (typeof asset[key] !== 'string' || !asset[key])
            throw new Error(`asset.${key} is required`);
    if (typeof input.requestedModelId !== 'string' || !input.requestedModelId)
        throw new Error('requestedModelId is required');
    if (typeof input.taskFamily !== 'string' || !input.taskFamily)
        throw new Error('taskFamily is required');
    const budgetInput = object(input.budget, 'budget');
    const timeoutMs = positiveNumber(budgetInput.timeoutMs, 'budget.timeoutMs');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 120_000)
        throw new Error('budget.timeoutMs must be an integer up to 120000');
    const validation = Array.isArray(input.validation)
        ? input.validation.filter((item) => typeof item === 'string').slice(0, 64)
        : [];
    if (validation.length === 0)
        throw new Error('validation must contain at least one command');
    for (const command of validation) {
        if (!verify.isValidationCommandAllowed(command))
            throw new Error('validation commands must be safe node scripts');
        const script = verify.validationScriptPath(command);
        if (script)
            assertWithinRoot(root, script, 'validation script');
    }
    return {
        asset: { type: asset.type, id: asset.id, revision: asset.revision },
        requestedModelId: input.requestedModelId,
        taskFamily: input.taskFamily,
        input: input.input,
        environment: input.environment ?? {},
        budget: { maxUsd: positiveNumber(budgetInput.maxUsd, 'budget.maxUsd'), timeoutMs },
        validation,
    };
}
function copySandbox(root, files) {
    const sandbox = mkdtempSync(join(tmpdir(), 'evolver-model-compatibility-'));
    try {
        for (const file of files) {
            const source = assertWithinRoot(root, file, 'setup file');
            if (!existsSync(source) || lstatSync(source).isSymbolicLink())
                throw new Error(`setup file is missing or symlinked: ${file}`);
            const target = join(sandbox, file);
            const parent = dirname(target);
            const parentRel = relative(sandbox, parent);
            if (parentRel === '..' || parentRel.startsWith(`..${sep}`))
                throw new Error('setup target escapes sandbox');
            cpSync(source, target, { recursive: statSync(source).isDirectory(), dereference: false, force: true });
        }
        return sandbox;
    }
    catch (error) {
        rmSync(sandbox, { recursive: true, force: true });
        throw error;
    }
}
function claudeArgs(test) {
    return [
        '--print', '--safe-mode', '--no-session-persistence', '--tools', '', '--permission-mode', 'dontAsk',
        '--model', test.requestedModelId, '--effort', 'low', '--output-format', 'json',
        '--json-schema', JSON.stringify(RESULT_SCHEMA), '--max-budget-usd', String(test.budget.maxUsd),
    ];
}
function fixtureArgs(definition, test, mode) {
    const argv = [...(definition.argv ?? [])];
    if (argv.some((item) => /[;&|`$<>\n\r]/.test(item)))
        throw new Error('unsafe fixture argv');
    return [...argv, '--model', test.requestedModelId, '--mode', mode];
}
function prompt(test, mode) {
    return JSON.stringify({
        instruction: 'Execute the fixed compatibility replay task. Do not use fallback models. Return only the schema result.',
        task_family: test.taskFamily,
        input_digest: compatibility.canonicalDigest(test.input),
        mode,
        asset: mode === 'asset-enabled' ? test.asset : null,
        input: test.input,
    });
}
function finiteInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function parseStructuredResult(value, test, mode) {
    let result = value;
    if (typeof result === 'string') {
        try {
            result = JSON.parse(result);
        }
        catch {
            return null;
        }
    }
    if (!result || typeof result !== 'object' || Array.isArray(result))
        return null;
    const row = result;
    if (Object.keys(row).some((key) => !['status', 'task_family', 'input_digest', 'mode'].includes(key)))
        return null;
    return row.status === 'completed'
        && row.task_family === test.taskFamily
        && row.input_digest === compatibility.canonicalDigest(test.input)
        && row.mode === mode ? row : null;
}
function parseClaudeEnvelope(raw, test, mode, processResult) {
    let envelope;
    try {
        envelope = object(JSON.parse(raw), 'Claude CLI envelope');
    }
    catch {
        envelope = undefined;
    }
    const usage = envelope?.usage && typeof envelope.usage === 'object' ? envelope.usage : undefined;
    const modelUsage = envelope?.modelUsage && typeof envelope.modelUsage === 'object' && !Array.isArray(envelope.modelUsage)
        ? envelope.modelUsage : undefined;
    const servedIds = modelUsage ? Object.keys(modelUsage) : [];
    const servedModel = servedIds.length === 1 && servedIds[0] === test.requestedModelId
        ? { id: servedIds[0], source: 'claude-cli-envelope' }
        : null;
    const inputTokens = finiteInteger(usage?.input_tokens);
    const outputTokens = finiteInteger(usage?.output_tokens);
    const cacheCreation = finiteInteger(usage?.cache_creation_input_tokens);
    const cacheRead = finiteInteger(usage?.cache_read_input_tokens);
    const cost = finiteNumber(envelope?.total_cost_usd);
    const parsedUsage = inputTokens !== undefined && outputTokens !== undefined && cacheCreation !== undefined && cacheRead !== undefined && cost !== undefined
        ? { inputTokens, outputTokens, cacheCreationInputTokens: cacheCreation, cacheReadInputTokens: cacheRead, costUsd: cost }
        : null;
    const structuredResult = parseStructuredResult(envelope?.structured_output ?? envelope?.result, test, mode);
    const sessionId = typeof envelope?.session_id === 'string' && envelope.session_id.length > 0 ? envelope.session_id : null;
    const envelopeSuccess = envelope?.type === 'result' && envelope.subtype === 'success' && envelope.is_error === false;
    return {
        trust: 'claude-cli', mode,
        ok: processResult.code === 0 && processResult.termination === 'exit' && envelopeSuccess,
        exitCode: processResult.code,
        termination: processResult.termination,
        requestedModel: { id: test.requestedModelId }, servedModel, sessionId, usage: parsedUsage, structuredResult,
        stdoutTruncated: processResult.stdoutTruncated === true,
        stderrTruncated: processResult.stderrTruncated === true,
    };
}
function fixtureObservation(test, mode, result) {
    return {
        trust: 'fixture', mode, ok: result.code === 0 && result.termination === 'exit', exitCode: result.code,
        termination: result.termination, requestedModel: { id: test.requestedModelId }, servedModel: null,
        sessionId: null, usage: null, structuredResult: null,
        stdoutTruncated: result.stdoutTruncated === true, stderrTruncated: result.stderrTruncated === true,
    };
}
async function execute(definition, test, mode, cwd, deps) {
    const spawn = deps.spawn ?? exec.spawnCapture;
    const executable = definition.kind === 'claude-cli' ? definition.executable ?? 'claude' : definition.executable ?? process.execPath;
    if (definition.kind === 'claude-cli' && executable !== 'claude')
        throw new Error('claude-cli runner executable must be claude');
    if (definition.kind === 'fixture' && ![process.execPath, 'node', 'nodejs'].includes(executable))
        throw new Error('fixture executable is not allowlisted');
    const result = await spawn(executable, definition.kind === 'claude-cli' ? claudeArgs(test) : fixtureArgs(definition, test, mode), {
        cwd, timeoutMs: test.budget.timeoutMs, input: prompt(test, mode), maxOutputBytes: 256 * 1024,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, NODE_ENV: 'production' },
    });
    const processEvidence = definition.kind === 'claude-cli'
        ? parseClaudeEnvelope(result.stdout, test, mode, result)
        : fixtureObservation(test, mode, result);
    const validate = deps.validation ?? verify.runSandboxedValidation;
    const validation = await validate(test.validation, cwd, {
        timeoutMs: Math.min(test.budget.timeoutMs, 30_000), requireIsolation: true, readOnlyRoot: cwd,
        ...(deps.isolationAvailable ? { unshareCheck: deps.isolationAvailable } : {}),
    });
    const steps = validation.results.map((item) => ({
        command: item.cmd, exitCode: item.exitCode, passed: item.passed, executed: true, termination: 'exit',
    }));
    for (const skipped of validation.skipped)
        steps.push({
            command: skipped.cmd, exitCode: null, passed: false, executed: false, termination: 'not-started',
        });
    return { ...processEvidence, validation: compatibility.validationTrace(validation.isolated, steps) };
}
export async function runModelCompatibilityReplay(argv, deps = {}) {
    if (argv.includes('--help')) {
        output({ usage: 'evolver model-compatibility-replay --input <json> [--ledger <json>] [--cwd <dir>] [--retries <n>] [--transition quarantine|revalidate|release --request-id <id> --reason <text>]' });
        return 0;
    }
    const inputPath = flag(argv, '--input');
    if (!inputPath)
        return fail('Usage: evolver model-compatibility-replay --input <json>', EXIT_USAGE);
    try {
        const root = resolve(flag(argv, '--cwd') ?? process.cwd());
        const source = boundedJson(resolve(inputPath));
        const body = Array.isArray(source) ? { cases: source } : object(source, 'input');
        const cases = Array.isArray(body.cases) ? body.cases : null;
        if (!cases || cases.length === 0 || cases.length > MAX_CASES)
            throw new Error('input must contain 1 to 256 cases');
        const corpus = cases.map((item) => replayCase(item, root));
        const ledgerPath = flag(argv, '--ledger');
        const transition = flag(argv, '--transition');
        if (transition) {
            if (!ledgerPath || corpus.length !== 1 || !['quarantine', 'revalidate', 'release'].includes(transition))
                throw new Error('transition requires --ledger, one case, and a valid transition');
            const requestId = flag(argv, '--request-id');
            const reason = flag(argv, '--reason');
            if (!requestId || !reason)
                throw new Error('transition requires --request-id and --reason');
            const ledger = new compatibility.CompatibilityLedger(resolve(ledgerPath));
            const changed = ledger.transition(compatibility.compatibilityKey(corpus[0]), transition, requestId, reason);
            output({ changed, resolved: ledger.resolve(compatibility.compatibilityKey(corpus[0])) });
            return 0;
        }
        const definition = runnerDefinition(body.runner);
        const retries = Math.max(0, Math.min(Number(flag(argv, '--retries') ?? '1') || 0, 5));
        const setupFiles = definition.setupFiles ?? [];
        const run = await compatibility.replayCorpus(corpus, async ({ mode, test }) => {
            const sandbox = copySandbox(root, setupFiles);
            try {
                return await execute(definition, test, mode, sandbox, deps);
            }
            finally {
                rmSync(sandbox, { recursive: true, force: true });
            }
        }, { requestId: flag(argv, '--request-id'), retries });
        if (ledgerPath)
            new compatibility.CompatibilityLedger(resolve(ledgerPath)).appendRun(run);
        const decisions = run.evidence.map((item) => compatibility.evaluateEvidence(item));
        output({ ...run, decisions });
        return decisions.includes('quarantine') ? EXIT_QUARANTINE : 0;
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : String(error), EXIT_RUNTIME);
    }
}
export const modelCompatibilityClaudeArgs = claudeArgs;