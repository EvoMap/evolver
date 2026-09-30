// The runner for a node with no coding-agent CLI installed. Every other runner in the
// registry spawns a vendor binary; this one speaks to a model over HTTP and edits the
// workspace itself through a small, bounded tool set. It is the difference between a
// daemon that can take a task and one that can only watch tasks go by.
//
// The operator chooses Chat Completions (default) or Responses explicitly. The base
// URL is used as configured; neither protocol, model nor version path is guessed.
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { workspaceAt } from './llmWorkspace.js';
export { workspaceAt } from './llmWorkspace.js';
export { reservePrivateWorkspace } from './workspaceLease.js';
export const LLM_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const LLM_DEFAULT_MODEL = 'gpt-4.1';
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const MAX_TURNS = 64;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_CALLS = 64;
const MAX_RESPONSE_ITEMS = 256;
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_TIMEOUT_MS = 600_000;
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
    return validatedConfig({
        apiKey,
        baseUrl: (env['EVOLVER_LLM_BASE_URL'] ?? LLM_DEFAULT_BASE_URL).trim().replace(/\/+$/u, ''),
        model: (env['EVOLVER_LLM_MODEL'] ?? LLM_DEFAULT_MODEL).trim(),
        apiBackend: env['EVOLVER_LLM_API_BACKEND'],
        maxTurns: configuredInt(env['EVOLVER_LLM_MAX_TURNS'], DEFAULT_MAX_TURNS),
        maxFileBytes: configuredInt(env['EVOLVER_LLM_MAX_FILE_BYTES'], DEFAULT_MAX_FILE_BYTES),
        extraHeaders: readLlmRunnerHeaders(env['EVOLVER_LLM_HEADERS']),
    });
}
function validatedConfig(config) {
    const fail = () => { throw new Error('invalid llm runner configuration; use a valid HTTPS endpoint (HTTP is allowed only for a loopback address), model, API key, bounded integer limits and API backend chat-completions or responses'); };
    const apiBackend = config.apiBackend === undefined ? 'chat-completions' : config.apiBackend;
    if (apiBackend !== 'chat-completions' && apiBackend !== 'responses')
        return fail();
    if (typeof config.baseUrl !== 'string' || config.baseUrl.length > 2048)
        return fail();
    let url;
    try {
        url = new URL(config.baseUrl);
    }
    catch {
        return fail();
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        || url.username || url.password || url.href.includes('?') || url.href.includes('#'))
        return fail();
    if (typeof config.model !== 'string' || !config.model.trim() || config.model.length > 256 || /\p{Cc}/u.test(config.model)
        || typeof config.apiKey !== 'string' || !config.apiKey.trim() || config.apiKey.length > 16_384 || /\p{Cc}/u.test(config.apiKey)
        || !Number.isSafeInteger(config.maxTurns) || config.maxTurns < 1 || config.maxTurns > MAX_TURNS
        || !Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 1 || config.maxFileBytes > MAX_FILE_BYTES)
        return fail();
    try {
        validateHeaderValue('authorization', `Bearer ${config.apiKey}`);
    }
    catch {
        return fail();
    }
    const extraHeaders = normalizeLlmRunnerHeaders(config.extraHeaders ?? {});
    if (Buffer.byteLength(JSON.stringify(extraHeaders)) > 16_384)
        return fail();
    return { ...config, apiBackend, baseUrl: url.href.replace(/\/+$/u, ''), model: config.model.trim(), apiKey: config.apiKey.trim(), extraHeaders };
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
function configuredInt(raw, fallback) {
    return raw === undefined ? fallback : Number(raw);
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
    const writePaths = deps.writePaths === undefined ? undefined : Object.freeze([...deps.writePaths]);
    if (writePaths && (writePaths.length === 0 || writePaths.length > 256 || new Set(writePaths).size !== writePaths.length
        || writePaths.some((path) => typeof path !== 'string' || !path || path.length > 4096 || /[\\:]|\p{Cc}/u.test(path)
            || path.split('/').some((part) => !part || part === '.' || part === '..')))) {
        throw new Error('invalid llm write paths; use unique canonical relative paths');
    }
    const captured = { ...deps, ...(writePaths ? { writePaths } : {}) };
    return async (prompt, ctx) => runLlmAgent(prompt, ctx, captured);
}
async function runLlmAgent(prompt, ctx, deps) {
    // A run that was cancelled before it started must not reach the model or the disk.
    // Adding a listener to an already-aborted signal never fires, so the state is checked.
    if (ctx.signal?.aborted)
        return { ok: false, output: '', error: 'cancelled', failureKind: 'cancelled' };
    if (ctx.timeoutMs === 0)
        return { ok: false, output: '', error: 'timed out', failureKind: 'timeout' };
    if (ctx.timeoutMs !== undefined && (!Number.isSafeInteger(ctx.timeoutMs) || ctx.timeoutMs < 0 || ctx.timeoutMs > MAX_TIMEOUT_MS)) {
        return { ok: false, output: '', error: 'invalid llm timeout; use a bounded non-negative integer', failureKind: 'spawn_failed' };
    }
    const startedAt = Date.now();
    let config;
    try {
        const supplied = deps.config ?? readLlmRunnerConfig(ctx.env ?? process.env);
        config = validatedConfig(supplied);
        if (typeof prompt !== 'string' || Buffer.byteLength(prompt) > MAX_REQUEST_BYTES)
            throw new Error('llm prompt exceeds request byte limit');
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
    const deadline = abortAt(ctx, startedAt);
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }];
    const responseInput = messages.map((message) => ({ ...message }));
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
            deadline.check();
            const completion = await complete(fetchFn, config, messages, responseInput, deadline.signal);
            deadline.check();
            const reply = completion.message;
            messages.push(reply);
            if (completion.responseOutput)
                responseInput.push(...completion.responseOutput);
            if (!reply.tool_calls || reply.tool_calls.length === 0) {
                const output = (reply.content ?? '').trim();
                const touched = workspace.touched();
                // A turn that changed nothing is not a finished task, however well it reads.
                if (touched.length === 0)
                    return abandon({ ok: false, output, error: 'the model finished without changing any file', failureKind: 'invalid_output' });
                deadline.check();
                workspace.complete?.();
                if (workspace !== ownedWorkspace)
                    ownedWorkspace.complete?.();
                return { ok: true, output: output || `changed ${touched.join(', ')}` };
            }
            for (const call of reply.tool_calls) {
                // Cancellation between turns must stop the writes too, not just the requests.
                deadline.check();
                const result = runTool(workspace, call, deps.writePaths);
                rejectHeaderEcho(result, config.extraHeaders ?? {}, config.apiKey);
                messages.push(result);
                if (config.apiBackend === 'responses')
                    responseInput.push({ type: 'function_call_output', call_id: call.id, output: result.content });
            }
        }
        return abandon({ ok: false, output: '', error: `gave up after ${config.maxTurns} turns without finishing`, failureKind: 'runtime_error' });
    }
    catch (error) {
        if (deadline.timedOut)
            return abandon({ ok: false, output: '', error: 'timed out', failureKind: 'timeout' });
        if (ctx.signal?.aborted)
            return abandon({ ok: false, output: '', error: 'cancelled', failureKind: 'cancelled' });
        return abandon({ ok: false, output: '', error: redactSecrets(messageOf(error), config), failureKind: 'runtime_error' });
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
function runTool(workspace, call, writePaths) {
    const answer = (content) => ({ role: 'tool', tool_call_id: call.id, name: call.function.name, content });
    // complete() validates the entire batch before the first tool can mutate the workspace.
    const args = JSON.parse(call.function.arguments);
    try {
        if (call.function.name === 'list_files')
            return answer(workspace.list(args['path'] ?? '.'));
        if (call.function.name === 'read_file')
            return answer(workspace.read(args['path']));
        if (call.function.name === 'write_file') {
            if (writePaths && !writePaths.includes(args['path']))
                return answer('error: write path is not authorized by the validation plan');
            return answer(workspace.write(args['path'], args['content']));
        }
        return answer(`error: no such tool ${call.function.name}`);
    }
    catch (error) {
        // A refused path or an unreadable file is something the model can recover from, so it
        // comes back as a tool result rather than ending the run.
        return answer(`error: ${messageOf(error)}`);
    }
}
/** Reject the entire reply before any tool runs; rewriting generated code could silently change its meaning. */
function credentialValues(config) {
    const values = new Set([config.apiKey]);
    for (const [name, value] of Object.entries(config.extraHeaders ?? {})) {
        if (value)
            values.add(value);
        if (name === 'authorization' || name === 'proxy-authorization') {
            const token = /^(?:Bearer|Basic)\s+(.+)$/iu.exec(value)?.[1];
            if (token)
                values.add(token);
        }
    }
    return [...values].filter(Boolean);
}
function redactSecrets(message, config) {
    return credentialValues(config).some((secret) => message.includes(secret)) ? 'llm operation failed (credential-bearing diagnostic omitted)' : message;
}
function rejectHeaderEcho(message, headers, apiKey) {
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
    if (apiKey)
        values.add(apiKey);
    const protectedValues = [...values];
    const pending = [message];
    while (pending.length > 0) {
        const value = pending.pop();
        if (typeof value === 'string') {
            if (protectedValues.some((secret) => value.includes(secret))) {
                throw new Error(Object.values(headers).some(Boolean)
                    ? 'llm response contains an EVOLVER_LLM_HEADERS value; response rejected'
                    : 'llm response contains a credential; response rejected');
            }
        }
        else if (Array.isArray(value)) {
            for (const entry of value)
                pending.push(entry);
        }
        else if (value && typeof value === 'object') {
            // Both wire formats embed tool arguments as JSON strings. Inspect decoded
            // values as well, so Unicode escaping cannot hide a credential in a write.
            const argumentsJson = value['arguments'];
            if (typeof argumentsJson === 'string') {
                try {
                    pending.push(JSON.parse(argumentsJson));
                }
                catch { /* message validation rejects malformed tool arguments */ }
            }
            for (const [key, entry] of Object.entries(value))
                pending.push(key, entry);
        }
    }
}
async function complete(fetchFn, config, messages, responseInput, signal) {
    const responses = config.apiBackend === 'responses';
    const body = JSON.stringify(responses
        ? { model: config.model, input: responseInput, tools: TOOLS.map((tool) => ({ type: tool.type, ...tool.function })), tool_choice: 'auto', store: false, include: ['reasoning.encrypted_content'] }
        : { model: config.model, messages, tools: TOOLS, tool_choice: 'auto' });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
        throw new Error('llm request exceeds byte limit');
    let response;
    let text;
    try {
        response = await awaitTransport(() => fetchFn(`${config.baseUrl}/${responses ? 'responses' : 'chat/completions'}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, ...config.extraHeaders },
            body,
            signal,
            // Fetch may forward custom credentials across origins on redirects. Require the final endpoint instead.
            redirect: 'error',
        }), signal, cancelResponseBody);
        if (signal.aborted) {
            cancelResponseBody(response);
            throw new Error('aborted');
        }
        if (!response.ok) {
            // Request cancellation, but an uncooperative stream must not prevent the
            // runner from reporting failure and recovering its owned workspace.
            cancelResponseBody(response);
            // An HTTP body or status text may contain the Authorization header, even with no custom headers.
            throw new Error(`llm ${Number.isInteger(response.status) ? response.status : 'request'}: request rejected (response body omitted)`);
        }
    }
    catch (error) {
        const message = messageOf(error);
        if (/^llm (?:\d{3}|request): request rejected \(response body omitted\)$/u.test(message))
            throw error;
        throw new Error('llm request failed; check endpoint and credentials (transport details omitted)');
    }
    try {
        text = await boundedResponseText(response, signal);
    }
    catch (error) {
        if (messageOf(error) === 'llm response exceeds byte limit')
            throw error;
        throw new Error('llm response could not be read (transport details omitted)');
    }
    if (signal.aborted)
        throw new Error('aborted');
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new Error('llm returned invalid JSON');
    }
    if (responses) {
        // Cover metadata, reasoning and every output item before accepting any tool.
        rejectHeaderEcho(parsed, config.extraHeaders ?? {}, config.apiKey);
        return validatedResponse(parsed, responseInput);
    }
    const choice = parsed?.choices?.[0];
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
    rejectHeaderEcho(choice.message, config.extraHeaders ?? {}, config.apiKey);
    return { message: validatedMessage(choice.message) };
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** Stateless Responses history is replayed verbatim, including opaque reasoning. */
function validatedResponse(input, history) {
    const invalid = () => { throw new Error('llm returned an incomplete, unsupported or malformed Responses response'); };
    if (!isRecord(input) || input['object'] !== 'response' || typeof input['id'] !== 'string' || !input['id'] || input['id'].length > 256
        || input['status'] !== 'completed' || input['error'] != null || input['incomplete_details'] != null
        || !Array.isArray(input['output']) || input['output'].length === 0 || input['output'].length > MAX_RESPONSE_ITEMS)
        return invalid();
    const output = [];
    const toolCalls = [];
    const content = [];
    const usedCalls = new Set(history.filter((item) => item['type'] === 'function_call').map((item) => item['call_id']));
    for (const item of input['output']) {
        if (!isRecord(item) || (item['status'] !== undefined && item['status'] !== 'completed')
            || (item['id'] !== undefined && (typeof item['id'] !== 'string' || item['id'].length > 256)))
            return invalid();
        if (item['type'] === 'function_call') {
            if (typeof item['call_id'] !== 'string' || usedCalls.has(item['call_id'])
                || typeof item['name'] !== 'string' || !TOOLS.some((tool) => tool.function.name === item['name'])
                || typeof item['arguments'] !== 'string')
                return invalid();
            usedCalls.add(item['call_id']);
            toolCalls.push({ id: item['call_id'], function: { name: item['name'], arguments: item['arguments'] } });
        }
        else if (item['type'] === 'message') {
            if (item['role'] !== 'assistant' || !Array.isArray(item['content']))
                return invalid();
            for (const part of item['content']) {
                if (!isRecord(part) || part['type'] !== 'output_text' || typeof part['text'] !== 'string')
                    return invalid();
                content.push(part['text']);
            }
        }
        else if (item['type'] === 'reasoning') {
            if (!Array.isArray(item['summary']) || (item['encrypted_content'] != null && typeof item['encrypted_content'] !== 'string'))
                return invalid();
            for (const part of item['summary']) {
                if (!isRecord(part) || part['type'] !== 'summary_text' || typeof part['text'] !== 'string')
                    return invalid();
            }
            if (item['content'] !== undefined) {
                if (!Array.isArray(item['content']))
                    return invalid();
                for (const part of item['content']) {
                    if (!isRecord(part) || part['type'] !== 'reasoning_text' || typeof part['text'] !== 'string')
                        return invalid();
                }
            }
        }
        else
            return invalid();
        output.push(item);
    }
    const text = content.join('\n');
    if (!toolCalls.length && !text.trim())
        return invalid();
    // Reuse the same complete-batch argument validation and limits as Chat.
    return { message: validatedMessage({ role: 'assistant', content: text, tool_calls: toolCalls }), responseOutput: output };
}
/** Stop awaiting an injected transport without claiming to undo its remote request. */
function awaitTransport(operation, signal, onLateValue) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(new Error('aborted'));
        };
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        // Both handlers remain attached after abort to consume late rejections and
        // cancel a response that becomes available only after local rollback.
        try {
            void Promise.resolve(operation()).then((value) => {
                if (settled) {
                    try {
                        onLateValue?.(value);
                    }
                    catch { /* Best-effort disposal must not create an unhandled rejection. */ }
                    return;
                }
                settled = true;
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            }, (error) => {
                if (settled)
                    return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                reject(error);
            });
        }
        catch (error) {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(error);
        }
    });
}
function cancelResponseBody(response) {
    try {
        void response.body?.cancel().catch(() => undefined);
    }
    catch { /* An injected transport may throw while cancelling. */ }
}
async function boundedResponseText(response, signal) {
    if (signal.aborted) {
        cancelResponseBody(response);
        throw new Error('aborted');
    }
    if (!response.body) {
        // Compatibility for trusted injected transports. The production fetch always exposes a byte stream.
        const text = await awaitTransport(() => response.text(), signal);
        if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
            throw new Error('llm response exceeds byte limit');
        return text;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        while (true) {
            if (signal.aborted)
                throw new Error('aborted');
            const chunk = await awaitTransport(() => reader.read(), signal);
            if (signal.aborted)
                throw new Error('aborted');
            if (chunk.done)
                break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES)
                throw new Error('llm response exceeds byte limit');
            chunks.push(chunk.value);
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    }
    finally {
        try {
            void reader.cancel().catch(() => undefined);
        }
        catch { /* Cancellation cannot hold local rollback. */ }
        try {
            reader.releaseLock();
        }
        catch { /* A custom reader may refuse release; its pending operation stays observed. */ }
    }
}
function validatedMessage(input) {
    const invalid = () => { throw new Error('llm returned malformed message or tool arguments'); };
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.role !== 'assistant'
        || (input.content !== undefined && input.content !== null && typeof input.content !== 'string')
        || (input.reasoning_content !== undefined && input.reasoning_content !== null && typeof input.reasoning_content !== 'string'))
        return invalid();
    if (input.tool_calls !== undefined && input.tool_calls !== null && (!Array.isArray(input.tool_calls) || input.tool_calls.length > MAX_TOOL_CALLS))
        return invalid();
    const ids = new Set();
    for (const call of input.tool_calls ?? []) {
        if (!call || typeof call.id !== 'string' || !call.id || call.id.length > 256 || ids.has(call.id)
            || !call.function || typeof call.function.name !== 'string' || !call.function.name || call.function.name.length > 128
            || typeof call.function.arguments !== 'string')
            return invalid();
        ids.add(call.id);
        let args;
        try {
            args = JSON.parse(call.function.arguments);
        }
        catch {
            return invalid();
        }
        if (!args || typeof args !== 'object' || Array.isArray(args))
            return invalid();
        const fields = args;
        if ((call.function.name === 'read_file' || call.function.name === 'write_file')
            && (typeof fields['path'] !== 'string' || !fields['path'] || fields['path'].length > 4096))
            return invalid();
        if (call.function.name === 'list_files' && fields['path'] !== undefined
            && (typeof fields['path'] !== 'string' || fields['path'].length > 4096))
            return invalid();
        if (call.function.name === 'write_file' && typeof fields['content'] !== 'string')
            return invalid();
    }
    // Preserve reasoning_content for providers that require it on later tool turns.
    return input;
}
function abortAt(ctx, startedAt) {
    const controller = new AbortController();
    const expiresAt = startedAt + (ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const state = { signal: controller.signal, timedOut: false, check: () => {
            if (Date.now() >= expiresAt) {
                state.timedOut = true;
                controller.abort();
            }
            if (controller.signal.aborted)
                throw new Error('aborted');
        }, dispose: () => { } };
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener('abort', onAbort);
    if (ctx.signal?.aborted)
        controller.abort();
    const timer = setTimeout(() => { state.timedOut = true; controller.abort(); }, Math.max(0, expiresAt - Date.now()));
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