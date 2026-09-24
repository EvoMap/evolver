// The runner for a node with no coding-agent CLI installed. Every other runner in the
// registry spawns a vendor binary; this one speaks to a model over HTTP and edits the
// workspace itself through a small, bounded tool set. It is the difference between a
// daemon that can take a task and one that can only watch tasks go by.
//
// Wire protocol is OpenAI-compatible chat completions with tool calls — the one shape
// nearly every vendor and gateway exposes, including Anthropic's compatibility endpoint.
// Point EVOLVER_LLM_BASE_URL at whichever serves the model.
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { workspaceAt } from './llmWorkspace.js';
export { workspaceAt } from './llmWorkspace.js';
export { reservePrivateWorkspace } from './workspaceLease.js';
export const LLM_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const LLM_DEFAULT_MODEL = 'gpt-4.1';
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
/** Why this node cannot run a model, in the words an operator needs to fix it. */
export class LlmRunnerNotConfiguredError extends Error {
    constructor(missing) {
        super(`llm runner needs ${missing}; set EVOLVER_LLM_API_KEY (or OPENAI_API_KEY) and optionally EVOLVER_LLM_BASE_URL / EVOLVER_LLM_MODEL`);
        this.name = 'LlmRunnerNotConfiguredError';
    }
}
export function readLlmRunnerConfig(env = process.env) {
    const apiKey = (env['EVOLVER_LLM_API_KEY'] ?? env['OPENAI_API_KEY'] ?? '').trim();
    if (!apiKey)
        throw new LlmRunnerNotConfiguredError('an API key');
    return {
        apiKey,
        baseUrl: (env['EVOLVER_LLM_BASE_URL'] ?? LLM_DEFAULT_BASE_URL).trim().replace(/\/+$/u, ''),
        model: (env['EVOLVER_LLM_MODEL'] ?? LLM_DEFAULT_MODEL).trim(),
        maxTurns: positiveInt(env['EVOLVER_LLM_MAX_TURNS'], DEFAULT_MAX_TURNS),
        maxFileBytes: positiveInt(env['EVOLVER_LLM_MAX_FILE_BYTES'], DEFAULT_MAX_FILE_BYTES),
        extraHeaders: readLlmRunnerHeaders(env['EVOLVER_LLM_HEADERS']),
    };
}
function invalidHeaders() {
    // Neither JSON.parse nor HTTP validation diagnostics are safe to echo: headers may contain credentials.
    return new Error('invalid EVOLVER_LLM_HEADERS; use one Name: value pair or a JSON object of string values with valid, unique HTTP header names');
}
function normalizeLlmRunnerHeaders(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw invalidHeaders();
    const headers = new Map();
    try {
        for (const [name, value] of Object.entries(input)) {
            validateHeaderName(name);
            if (typeof value !== 'string')
                throw invalidHeaders();
            validateHeaderValue(name, value);
            const key = name.toLowerCase();
            if (headers.has(key))
                throw invalidHeaders();
            headers.set(key, value.trim());
        }
    }
    catch {
        throw invalidHeaders();
    }
    return Object.fromEntries(headers);
}
function readLlmRunnerHeaders(raw) {
    if (!raw?.trim())
        return {};
    let input;
    if (raw.trimStart().startsWith('{')) {
        try {
            input = JSON.parse(raw);
        }
        catch {
            throw invalidHeaders();
        }
    }
    else {
        const colon = raw.indexOf(':');
        if (colon < 1 || /[\r\n]/u.test(raw))
            throw invalidHeaders();
        // A single value may itself contain colons or commas. Multiple headers use JSON.
        input = Object.fromEntries([[raw.slice(0, colon).trim(), raw.slice(colon + 1)]]);
    }
    return normalizeLlmRunnerHeaders(input);
}
function positiveInt(raw, fallback) {
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
const TOOLS = [
    { name: 'list_files', description: 'List the entries of a directory in the workspace.', properties: { path: { type: 'string', description: 'Directory relative to the workspace root. Defaults to the root.' } }, required: [] },
    { name: 'read_file', description: 'Read a UTF-8 file from the workspace.', properties: { path: { type: 'string', description: 'File relative to the workspace root.' } }, required: ['path'] },
    { name: 'write_file', description: 'Write a UTF-8 file in the workspace, creating directories as needed.', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
].map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: { type: 'object', properties: tool.properties, required: tool.required } },
}));
const SYSTEM_PROMPT = [
    'You are the execution engine of an autonomous evolution loop, working directly on a repository.',
    'Read before you write. Make the smallest change that accomplishes the task, and keep the surrounding style.',
    'Use write_file to apply every change — describing an edit is not making one.',
    'When the work is done, reply with a short plain-text summary of what you changed and why. Do not ask questions; there is no one to answer them.',
].join(' ');
/**
 * Build a runner that drives a model through the workspace tools. `opts` is accepted for
 * registry symmetry: this runner has no host permission prompts to bypass and no vendor
 * tool names to allowlist, because the tools are the three defined above.
 */
export function makeLlmHeadlessRunner(_opts = {}, deps = {}) {
    return async (prompt, ctx) => runLlmAgent(prompt, ctx, deps);
}
async function runLlmAgent(prompt, ctx, deps) {
    // A run that was cancelled before it started must not reach the model or the disk.
    // Adding a listener to an already-aborted signal never fires, so the state is checked.
    if (ctx.signal?.aborted)
        return { ok: false, output: '', error: 'cancelled', failureKind: 'cancelled' };
    let config;
    try {
        const supplied = deps.config ?? readLlmRunnerConfig(ctx.env ?? process.env);
        config = { ...supplied, extraHeaders: normalizeLlmRunnerHeaders(supplied.extraHeaders ?? {}) };
    }
    catch (error) {
        // Nothing was launched and nothing can be: the same shape as a missing CLI binary.
        return { ok: false, output: '', error: messageOf(error), failureKind: 'spawn_failed' };
    }
    let workspace;
    let ownedWorkspace;
    try {
        if (!ctx.workspaceLease)
            throw new Error('llm writes require a private workspace lease; use worktree isolation');
        ownedWorkspace = workspaceAt(ctx.cwd, config.maxFileBytes, ctx.workspaceLease);
        workspace = deps.workspace ? deps.workspace(ctx.cwd, ownedWorkspace) : ownedWorkspace;
    }
    catch {
        let recovery;
        if (ownedWorkspace) {
            try {
                recovery = ownedWorkspace.undo() ?? { status: 'failed', restored: [], conflicts: [], failed: [{ path: '.', reason: 'recovery_unconfirmed' }] };
            }
            catch {
                recovery = { status: 'failed', restored: [], conflicts: [], failed: [{ path: '.', reason: 'recovery_failed' }], workspace: ctx.cwd };
            }
        }
        ownedWorkspace?.close?.();
        return { ok: false, output: '', error: 'llm workspace unavailable; use an exclusively owned private workspace', failureKind: 'permission_denied', ...(recovery ? { workspaceRecovery: recovery } : {}) };
    }
    const fetchFn = deps.fetchFn ?? globalThis.fetch;
    const deadline = abortAt(ctx);
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }];
    const abandon = (result) => {
        let recovery;
        try {
            recovery = workspace.undo() ?? { status: 'failed', restored: [], conflicts: [], failed: [{ path: '.', reason: 'recovery_unconfirmed' }] };
        }
        catch {
            recovery = { status: 'failed', restored: [], conflicts: [], failed: [{ path: '.', reason: 'recovery_failed' }] };
        }
        const notes = [];
        if (recovery.restored.length)
            notes.push(`(reverted ${recovery.restored.join(', ')})`);
        if (recovery.conflicts.length || recovery.failed.length)
            notes.push('(workspace recovery incomplete; operator recovery required for retained workspace)');
        return { ...result, output: [result.output, ...notes].filter(Boolean).join('\n'), workspaceRecovery: recovery };
    };
    try {
        for (let turn = 0; turn < config.maxTurns; turn += 1) {
            const reply = await complete(fetchFn, config, messages, deadline.signal);
            messages.push(reply);
            if (!reply.tool_calls || reply.tool_calls.length === 0) {
                const output = (reply.content ?? '').trim();
                const touched = workspace.touched();
                // A turn that changed nothing is not a finished task, however well it reads.
                if (touched.length === 0)
                    return abandon({ ok: false, output, error: 'the model finished without changing any file', failureKind: 'invalid_output' });
                if (deadline.signal.aborted)
                    throw new Error('aborted');
                workspace.complete?.();
                if (workspace !== ownedWorkspace)
                    ownedWorkspace.complete?.();
                return { ok: true, output: output || `changed ${touched.join(', ')}` };
            }
            for (const call of reply.tool_calls) {
                // Cancellation between turns must stop the writes too, not just the requests.
                if (deadline.signal.aborted)
                    throw new Error('aborted');
                messages.push(runTool(workspace, call));
            }
        }
        return abandon({ ok: false, output: '', error: `gave up after ${config.maxTurns} turns without finishing`, failureKind: 'runtime_error' });
    }
    catch (error) {
        if (deadline.timedOut)
            return abandon({ ok: false, output: '', error: 'timed out', failureKind: 'timeout' });
        if (ctx.signal?.aborted)
            return abandon({ ok: false, output: '', error: 'cancelled', failureKind: 'cancelled' });
        return abandon({ ok: false, output: '', error: messageOf(error), failureKind: 'runtime_error' });
    }
    finally {
        deadline.dispose();
        try {
            workspace.close?.();
        }
        finally {
            ownedWorkspace.close?.();
        }
    }
}
function runTool(workspace, call) {
    const answer = (content) => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content });
    let args;
    try {
        args = JSON.parse(call.function.arguments || '{}');
    }
    catch {
        return answer('error: arguments were not valid JSON');
    }
    try {
        if (call.function.name === 'list_files')
            return answer(workspace.list(String(args['path'] ?? '.')));
        if (call.function.name === 'read_file')
            return answer(workspace.read(String(args['path'] ?? '')));
        if (call.function.name === 'write_file')
            return answer(workspace.write(String(args['path'] ?? ''), String(args['content'] ?? '')));
        return answer(`error: no such tool ${call.function.name}`);
    }
    catch (error) {
        // A refused path or an unreadable file is something the model can recover from, so it
        // comes back as a tool result rather than ending the run.
        return answer(`error: ${messageOf(error)}`);
    }
}
/** Reject the entire reply before any tool runs; rewriting generated code could silently change its meaning. */
function rejectHeaderEcho(message, headers) {
    const values = new Set();
    for (const [name, value] of Object.entries(headers)) {
        if (value)
            values.add(value);
        if (name === 'authorization' || name === 'proxy-authorization') {
            const token = /^(?:Bearer|Basic)\s+(.+)$/iu.exec(value)?.[1];
            if (token)
                values.add(token);
        }
    }
    if (values.size === 0)
        return;
    const protectedValues = [...values];
    const pending = [message];
    // Tool arguments are JSON inside a JSON string; inspect their decoded values too, including Unicode escapes.
    if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            if (typeof call?.function?.arguments !== 'string')
                continue;
            try {
                pending.push(JSON.parse(call.function.arguments));
            }
            catch { /* runTool reports malformed arguments safely */ }
        }
    }
    while (pending.length > 0) {
        const value = pending.pop();
        if (typeof value === 'string') {
            if (protectedValues.some((secret) => value.includes(secret))) {
                throw new Error('llm response contains an EVOLVER_LLM_HEADERS value; response rejected');
            }
        }
        else if (Array.isArray(value)) {
            for (const entry of value)
                pending.push(entry);
        }
        else if (value && typeof value === 'object') {
            for (const [key, entry] of Object.entries(value))
                pending.push(key, entry);
        }
    }
}
async function complete(fetchFn, config, messages, signal) {
    const hasExtraHeaders = Object.keys(config.extraHeaders ?? {}).length > 0;
    let response;
    let text;
    try {
        response = await fetchFn(`${config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, ...config.extraHeaders },
            body: JSON.stringify({ model: config.model, messages, tools: TOOLS, tool_choice: 'auto' }),
            signal,
            // Fetch may forward custom credentials across origins on redirects. Require the final endpoint instead.
            ...(hasExtraHeaders ? { redirect: 'error' } : {}),
        });
        text = await response.text();
    }
    catch (error) {
        if (hasExtraHeaders)
            throw new Error('llm request failed; check the endpoint and EVOLVER_LLM_HEADERS (transport details omitted)');
        throw error;
    }
    if (!response.ok)
        throw new Error(`llm ${response.status}: ${hasExtraHeaders ? 'request rejected (response body omitted because EVOLVER_LLM_HEADERS is configured)' : text.slice(0, 300)}`);
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new Error('llm returned invalid JSON');
    }
    const choice = parsed.choices?.[0];
    if (!choice?.message)
        throw new Error('llm returned no message');
    // A reply cut off by the token limit or by a content filter is not an answer, however
    // complete it reads. Saying so beats reporting the truncated half as finished work.
    const reason = choice.finish_reason;
    if (reason !== undefined && reason !== null && reason !== 'stop' && reason !== 'tool_calls') {
        // Only protocol constants are safe diagnostics; arbitrary upstream values may echo credentials.
        const diagnostic = reason === 'length' || reason === 'content_filter' || reason === 'function_call'
            ? reason : 'unrecognized finish_reason';
        throw new Error(`llm stopped early: ${diagnostic}`);
    }
    rejectHeaderEcho(choice.message, config.extraHeaders ?? {});
    return choice.message;
}
function abortAt(ctx) {
    const controller = new AbortController();
    const state = { signal: controller.signal, timedOut: false, dispose: () => { } };
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener('abort', onAbort);
    const timer = ctx.timeoutMs ? setTimeout(() => { state.timedOut = true; controller.abort(); }, ctx.timeoutMs) : null;
    state.dispose = () => {
        if (timer)
            clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
    };
    return state;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}