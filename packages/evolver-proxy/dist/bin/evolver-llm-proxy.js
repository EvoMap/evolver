#!/usr/bin/env node
// Standalone LLM proxy entry: HTTP listen shell + tier router + trace capture. Deliberately independent of
// the mailbox/hub daemon (bin/evolver-proxy.ts) — capturing LLM traces must not require a hub credential.
//
// Client wiring:   export ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
//                  export ANTHROPIC_AUTH_TOKEN=<token printed below>
// Upstream creds:  ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in THIS process's env (read per request).
// Routing (opt-in):EVOMAP_ROUTER_ENABLED=1 + EVOMAP_MODEL_{CHEAP,MID,EXPENSIVE} (no IDs are ever hardcoded).
// Trace material:  NDJSON under EVOLVER_LLM_TRACE_DIR (default $EVOLVER_HOME/proxy/traces or ~/.evomap/proxy/traces);
//                  EVOLVER_LLM_TRACE=0 disables; legacy EVOMAP_PROXY_TRACE off values are also honored.
// Hub analysis:    EVOLVER_LLM_TRACE_PROFILE_ANALYSIS=1 requires EVOLVER_LLM_TRACE_HUB_PUBLIC_KEY and writes
//                  AES-GCM envelopes whose per-row DEK is RSA-OAEP-SHA256 wrapped for the Hub.
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { daemon, events, mailbox } from '@evomap/evolver-core';
import { buildMessagesHandler } from '../router/messagesRoute.js';
import { buildProviderRoutes } from '../router/providerRoutes.js';
import { makeAnthropicUpstream, makeGeminiUpstream, makeOllamaUpstream, makeOpenAIUpstream, makeVertexUpstream } from '../llm/upstream.js';
import { JsonlTraceSink } from '../llm/traceSink.js';
import { traceCollectionEnabled } from '../llm/traceConfig.js';
import { LlmProxyServer } from '../llm/server.js';
import { getCurrentVersion } from '../selfUpdate/version.js';
import { resolveProxyStorePath } from './proxyStorePath.js';
async function main(uninstallUnhandledRejectionGuard = () => undefined) {
    const env = process.env;
    const token = env['EVOLVER_LLM_TOKEN'] ?? randomBytes(24).toString('hex');
    const traceEnabled = traceCollectionEnabled(env);
    const traceDir = events.tracesDir();
    let traceMailboxStore = null;
    if (traceEnabled && env['EVOLVER_LLM_TRACE_MAILBOX'] !== '0') {
        try {
            const storePath = resolveProxyStorePath(env);
            traceMailboxStore = new mailbox.MailboxStore({ path: storePath });
        }
        catch (err) {
            process.stderr.write(`[evolver-llm-proxy] trace mailbox disabled: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }
    const sink = traceEnabled ? new JsonlTraceSink({
        dir: traceDir,
        producerVersion: getCurrentVersion(),
        ...(traceMailboxStore ? { mailboxStore: traceMailboxStore } : {}),
    }) : null;
    const anthropicProxy = makeAnthropicUpstream();
    const openAIProxy = makeOpenAIUpstream();
    const geminiProxy = makeGeminiUpstream();
    const ollamaProxy = makeOllamaUpstream();
    const vertexProxy = makeVertexUpstream();
    const handler = buildMessagesHandler({
        anthropicProxy,
        ...(sink ? { onTrace: sink.write } : {}),
    });
    const routes = buildProviderRoutes({
        anthropicProxy,
        openAIProxy,
        geminiProxy,
        ollamaProxy,
        vertexProxy,
        ...(sink ? { onTrace: sink.write } : {}),
    });
    const server = new LlmProxyServer({ handler, token, routes });
    const { url } = await server.start();
    process.stdout.write(`[evolver-llm-proxy] url=${url} token=${token} trace=${sink ? traceDir : 'off'}\n`);
    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        let exitCode = 0;
        void server.stop()
            .catch((err) => {
            exitCode = 1;
            process.stderr.write(`[evolver-llm-proxy] shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`);
        })
            .finally(() => {
            try {
                traceMailboxStore?.close();
            }
            catch (err) {
                exitCode = 1;
                process.stderr.write(`[evolver-llm-proxy] trace mailbox close failed: ${err instanceof Error ? err.message : String(err)}\n`);
            }
            uninstallUnhandledRejectionGuard();
            process.exit(exitCode);
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
export function runLlmProxyCli() {
    const uninstallUnhandledRejectionGuard = daemon.installUnhandledRejectionWindow();
    main(uninstallUnhandledRejectionGuard).catch((e) => {
        uninstallUnhandledRejectionGuard();
        process.stderr.write(`[evolver-llm-proxy] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(1);
    });
}
if (isDirectRun(import.meta.url, process.argv[1])) {
    runLlmProxyCli();
}
function isDirectRun(metaUrl, argv1) {
    if (!argv1)
        return false;
    try {
        return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
    }
    catch {
        return false;
    }
}