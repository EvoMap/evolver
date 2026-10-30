#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assetstore, events, exec as execCore, mailbox } from '@evomap/evolver-core';
import { buildEvolverTools } from './tools.js';
import { buildEvolverPrimer } from './primer.js';
import { EvolverMcpServer, UnknownToolError } from './server.js';
import { proxyClientFromEnv } from './proxyClient.js';
import { loadEnvFileFromEnvOrThrow } from './envFile.js';
import { bootstrap } from '@evomap/evolver-core';
try {
    loadEnvFileFromEnvOrThrow(process.env);
}
catch {
    process.stderr.write('[evolver-mcp] fatal: failed to load EVOLVER_ENV_FILE\n');
    process.exit(1);
}
// Emit deprecation warnings for any V1 env vars still present in the environment.
bootstrap.checkV1EnvCompat(process.env);
const store = new assetstore.LocalJsonlProvider(events.assetsDir());
const mailboxPath = process.env['EVOLVER_MCP_MAILBOX'] ?? join(events.evomapHome(), 'mailbox', 'mcp.db');
let box;
let closing = false;
const mailboxStore = () => {
    if (closing)
        throw new Error('MCP stdio is closing');
    if (!box) {
        // Protocol initialization and discovery do not need a SQLite mailbox.
        // Open the real store only when a mailbox handler actually uses it.
        mkdirSync(dirname(mailboxPath), { recursive: true });
        box = new mailbox.MailboxStore({ path: mailboxPath });
    }
    return box;
};
// A configured proxy is authoritative. Discovery may report an explicitly incomplete result
// during an outage, but must never silently switch to local mode or hide rejected credentials.
const proxy = proxyClientFromEnv(process.env);
// Reuse-feedback wiring (#268): a root_events writer + a per-connection correlation id so a SUCCESS reuse_result
// from THIS MCP agent credits the local experience loop (one stdio process ~ one MCP session).
// Initialization and discovery do not write root events. Admit the concrete
// writer only when a tool needs audit emission; its protected-service checks
// and the tool's existing failure semantics still apply to every write.
let eventWriter;
const ingestor = {
    ingest(raw) {
        eventWriter ??= new events.Ingestor({ path: events.rootEventsPath() });
        return eventWriter.ingest(raw);
    },
};
const connId = `mcp-${randomUUID()}`;
// clientInfo is a caller-supplied display label, never authenticated host identity.
let clientName = 'MCP client';
let initialized = false;
const experienceClient = () => ({ connectionId: connId, transport: 'mcp_stdio', clientName,
    ...(process.env['EVOLVER_ONBOARDING_RUNTIME'] ? { runtime: process.env['EVOLVER_ONBOARDING_RUNTIME'] } : {}),
});
const triggerFeedback = execCore.createTriggerFeedbackLocalFacade(process.env);
const server = new EvolverMcpServer(buildEvolverTools({ store, mailbox: mailboxStore, ingestor, cycleId: connId, experienceClient,
    ...(proxy ? { proxy } : {}), ...(triggerFeedback ? { triggerFeedback } : {}) }), { instructions: buildEvolverPrimer({ proxy: !!proxy }) });
function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
}
function ok(id, result) {
    send({ jsonrpc: '2.0', id, result });
}
function fail(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
async function handle(req) {
    const id = req.id ?? null;
    const method = req.method;
    if (!method)
        return fail(id, -32600, 'missing method');
    if (method === 'initialize') {
        // Initialize is a request, not a notification. Do not advance protocol state
        // or reply to an id-less notification with an uncorrelated null ID.
        if (req.id === undefined)
            return;
        if (typeof req.id !== 'string' && !Number.isSafeInteger(req.id)) {
            return fail(null, -32600, 'initialize requires a valid request ID');
        }
        if (initialized)
            return fail(id, -32600, 'MCP session already initialized');
        initialized = true;
        const params = asRecord(req.params);
        const info = asRecord(params['clientInfo']);
        clientName = typeof info['name'] === 'string' ? info['name'] : 'MCP client';
        ok(id, {
            protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'evolver-mcp', version: '0.0.0' },
            // Quiet mechanism primer (#mcp-onboarding): keep tool workflow available without encouraging user-visible
            // narration of routine Evolver checks.
            ...(server.instructions ? { instructions: server.instructions } : {}),
        });
        return;
    }
    if (method === 'notifications/initialized')
        return;
    if (method === 'ping')
        return ok(id, {});
    if (!initialized)
        return fail(id, -32002, 'MCP session must initialize before calling tools');
    if (method === 'tools/list')
        return ok(id, { tools: server.listTools() });
    if (method === 'tools/call') {
        const params = asRecord(req.params);
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        const args = asRecord(params['arguments']);
        try {
            const r = await server.callTool(name, args);
            ok(id, {
                content: [{ type: 'text', text: r.ok ? JSON.stringify(r.result, null, 2) : r.code ? JSON.stringify({ error: r.error, code: r.code, status: r.status, retryAfterMs: r.retryAfterMs }) : (r.error ?? 'tool failed') }],
                isError: !r.ok,
            });
        }
        catch (err) {
            const message = err instanceof UnknownToolError ? err.message : (err instanceof Error ? err.message : String(err));
            fail(id, err instanceof UnknownToolError ? -32601 : -32603, message);
        }
        return;
    }
    fail(id, -32601, `unknown method: ${method}`);
}
let resolveStdioLifetime;
export const stdioLifetime = new Promise((resolve) => { resolveStdioLifetime = resolve; });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let requestQueue = Promise.resolve();
async function processLine(line) {
    const raw = line.trim();
    if (!raw)
        return;
    let req;
    try {
        req = JSON.parse(raw);
    }
    catch (err) {
        fail(null, -32700, err instanceof Error ? err.message : String(err));
        return;
    }
    try {
        await handle(req);
    }
    catch (err) {
        fail(req.id ?? null, -32603, err instanceof Error ? err.message : String(err));
    }
}
rl.on('line', (line) => {
    const next = requestQueue.then(() => processLine(line), () => processLine(line));
    requestQueue = next.catch(() => undefined);
});
function finishStdio() {
    if (closing)
        return;
    closing = true;
    box?.close();
    resolveStdioLifetime();
    setImmediate(() => process.exit(0));
}
rl.on('close', () => { void requestQueue.finally(finishStdio); });
process.on('SIGINT', finishStdio);
process.on('SIGTERM', finishStdio);