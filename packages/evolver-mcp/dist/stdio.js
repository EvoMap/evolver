#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assetstore, events, mailbox } from '@evomap/evolver-core';
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
mkdirSync(dirname(mailboxPath), { recursive: true });
const box = new mailbox.MailboxStore({ path: mailboxPath });
// A configured proxy is authoritative. If it is temporarily unreachable or its Hub credential
// was revoked, tool calls must surface that failure instead of silently switching to local mode.
const proxy = proxyClientFromEnv(process.env);
// Reuse-feedback wiring (#268): a root_events writer + a per-connection correlation id so a SUCCESS reuse_result
// from THIS MCP agent credits the local experience loop (one stdio process ~ one MCP session).
const ingestor = new events.Ingestor({ path: events.rootEventsPath() });
const connId = `mcp-${randomUUID()}`;
const server = new EvolverMcpServer(buildEvolverTools({ store, mailbox: box, ingestor, cycleId: connId, ...(proxy ? { proxy } : {}) }), { instructions: buildEvolverPrimer({ proxy: !!proxy }) });
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
        const params = asRecord(req.params);
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
    if (method === 'tools/list')
        return ok(id, { tools: server.listTools() });
    if (method === 'tools/call') {
        const params = asRecord(req.params);
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        const args = asRecord(params['arguments']);
        try {
            const r = await server.callTool(name, args);
            ok(id, {
                content: [{ type: 'text', text: r.ok ? JSON.stringify(r.result, null, 2) : (r.error ?? 'tool failed') }],
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
rl.on('close', () => { void requestQueue.finally(() => { box.close(); process.exit(0); }); });
process.on('SIGINT', () => { box.close(); process.exit(0); });
process.on('SIGTERM', () => { box.close(); process.exit(0); });