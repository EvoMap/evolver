// The runner for a node with no coding-agent CLI installed. Every other runner in the
// registry spawns a vendor binary; this one speaks to a model over HTTP and edits the
// workspace itself through a small, bounded tool set. It is the difference between a
// daemon that can take a task and one that can only watch tasks go by.
//
// Wire protocol is OpenAI-compatible chat completions with tool calls — the one shape
// nearly every vendor and gateway exposes, including Anthropic's compatibility endpoint.
// Point EVOLVER_LLM_BASE_URL at whichever serves the model.
import { existsSync, readFileSync, readdirSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
export const LLM_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const LLM_DEFAULT_MODEL = 'gpt-4.1';
const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const DEFAULT_MAX_LISTING = 200;
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
    };
}
function positiveInt(raw, fallback) {
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
/** Paths the model has no business in: repository plumbing and installed dependencies. */
const OFF_LIMITS = new Set(['.git', 'node_modules']);
/**
 * The real path of `target`, following symlinks. A file that does not exist yet resolves
 * through its nearest existing ancestor, so a link planted as a parent directory is caught
 * before anything is written through it.
 */
function realPathOf(target) {
    let existing = target;
    const tail = [];
    while (!existsSync(existing)) {
        const parent = dirname(existing);
        if (parent === existing)
            return target;
        tail.unshift(existing.slice(parent.length + 1));
        existing = parent;
    }
    return resolve(realpathSync(existing), ...tail);
}
export function workspaceAt(root, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
    const base = existsSync(root) ? realpathSync(resolve(root)) : resolve(root);
    const original = new Map();
    const contains = (path, raw) => {
        const rel = relative(base, path);
        if (rel.startsWith('..') || rel.split(sep).includes('..'))
            throw new Error(`path escapes the workspace: ${String(raw)}`);
        if (rel.split(sep).some((segment) => OFF_LIMITS.has(segment)))
            throw new Error(`path is off limits: ${String(raw)}`);
    };
    const inside = (raw) => {
        const target = resolve(base, String(raw ?? '.'));
        contains(target, raw);
        // Lexical containment is not containment: a symlink inside the workspace can point
        // anywhere, and read/write follow it. The resolved path has to be inside too.
        contains(realPathOf(target), raw);
        return target;
    };
    return {
        list(dir) {
            const target = inside(dir);
            const entries = readdirSync(target, { withFileTypes: true })
                .filter((entry) => !OFF_LIMITS.has(entry.name))
                .slice(0, DEFAULT_MAX_LISTING)
                .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
            return entries.length > 0 ? entries.join('\n') : '(empty)';
        },
        read(path) {
            const target = inside(path);
            if (statSync(target).size > maxFileBytes)
                throw new Error(`file is larger than ${maxFileBytes} bytes`);
            return readFileSync(target, 'utf8');
        },
        write(path, content) {
            const target = inside(path);
            const body = String(content ?? '');
            if (Buffer.byteLength(body, 'utf8') > maxFileBytes)
                throw new Error(`refusing to write more than ${maxFileBytes} bytes`);
            // Remember what was there before the first change to each file, so a run that ends
            // badly can put the workspace back exactly as it found it.
            if (!original.has(target))
                original.set(target, existsSync(target) ? readFileSync(target, 'utf8') : null);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, body, 'utf8');
            return `wrote ${Buffer.byteLength(body, 'utf8')} bytes`;
        },
        touched: () => [...original.keys()].map((path) => relative(base, path) || '.'),
        undo() {
            for (const [path, before] of original) {
                try {
                    if (before === null)
                        rmSync(path, { force: true });
                    else
                        writeFileSync(path, before, 'utf8');
                }
                catch {
                    // Best effort: a file we cannot put back is reported through the run's verdict.
                }
            }
            original.clear();
        },
    };
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
        config = deps.config ?? readLlmRunnerConfig(ctx.env ?? process.env);
    }
    catch (error) {
        // Nothing was launched and nothing can be: the same shape as a missing CLI binary.
        return { ok: false, output: '', error: messageOf(error), failureKind: 'spawn_failed' };
    }
    const workspace = (deps.workspace ?? ((cwd) => workspaceAt(cwd, config.maxFileBytes)))(ctx.cwd);
    const fetchFn = deps.fetchFn ?? globalThis.fetch;
    const deadline = abortAt(ctx);
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }];
    // Whatever the run touched belongs to a finished task or to nobody: anything short of
    // success puts the workspace back, so a cancelled or broken run leaves no half-done edit
    // for the next attempt to build on.
    const abandon = (result) => {
        const touched = workspace.touched();
        workspace.undo();
        return touched.length > 0 ? { ...result, output: `${result.output}\n(reverted ${touched.join(', ')})`.trim() } : result;
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
                    return { ok: false, output, error: 'the model finished without changing any file', failureKind: 'invalid_output' };
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
async function complete(fetchFn, config, messages, signal) {
    const response = await fetchFn(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, tools: TOOLS, tool_choice: 'auto' }),
        signal,
    });
    const text = await response.text();
    if (!response.ok)
        throw new Error(`llm ${response.status}: ${text.slice(0, 300)}`);
    const choice = JSON.parse(text).choices?.[0];
    if (!choice?.message)
        throw new Error('llm returned no message');
    // A reply cut off by the token limit or by a content filter is not an answer, however
    // complete it reads. Saying so beats reporting the truncated half as finished work.
    const reason = choice.finish_reason;
    if (reason && reason !== 'stop' && reason !== 'tool_calls')
        throw new Error(`llm stopped early: ${reason}`);
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