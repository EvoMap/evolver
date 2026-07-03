const ENV_FILE_KEY = 'EVOLVER_ENV_FILE';
/** The `.mcp.json`-shaped registration block a generic MCP client needs — the same shape planInjection writes for
 *  claude-code, rendered as a copyable JSON snippet. Only the EVOLVER_ENV_FILE pointer ever appears under env. */
function mcpServerSnippet(server) {
    const reg = { command: server.command, args: server.args ?? [] };
    if (server.env && Object.keys(server.env).length > 0)
        reg['env'] = server.env;
    return JSON.stringify({ mcpServers: { evolver: reg } }, null, 2);
}
/** A one-line note about how credentials are referenced — either "already pointed at <path>" or a tip to pass
 *  --env-file. Never prints a secret, only the pointer key / path. */
function envNote(server) {
    // Wording is snippet-agnostic: http-agent / server render NO MCP snippet, so the note must not say "the snippet"
    // (Bugbot #266). It only states how credentials are referenced — via the EVOLVER_ENV_FILE pointer, never a token.
    const path = server.env?.[ENV_FILE_KEY];
    return path
        ? `Credentials are referenced via ${ENV_FILE_KEY}=${path} (a pointer; the secret value is never exposed here).`
        : `Tip: pass --env-file=<path> to reference your private credential store via ${ENV_FILE_KEY} (never inline tokens).`;
}
function hintBlock(hints) {
    return hints && hints.length > 0 ? `\nAdapter notes:\n${hints.map((h) => `  - ${h}`).join('\n')}` : '';
}
/**
 * Render the manual wiring instructions for a `manual`-class runtime. Returns a multi-line, copy-pasteable block.
 * Pure given its inputs. The caller (setup-hooks) only invokes this when runtimeSupport(...) === 'manual'.
 */
export function renderManualWiring(runtime, ctx) {
    const snippet = mcpServerSnippet(ctx.server);
    const env = envNote(ctx.server);
    const hints = hintBlock(ctx.hints);
    switch (runtime) {
        case 'mcp-generic':
            return [
                'manual: mcp-generic — evolver does not write this client config. Two steps wire the FULL self-learning loop:',
                '',
                "1. TOOLS. Add the evolver server to your MCP client's server map (exposes evolver_recall / search / distill / reuse-result):",
                snippet,
                '',
                '2. LOOP. So evolver also LEARNS from this agent (not just serves it), close the observe side:',
                '   - point the evolver daemon at a transcript dir and run it:',
                '       EVOLVER_SESSION_DIRS=<dir> EVOLVER_AUTO_RECALL=1 evolver autoexec',
                '   - have the agent write its session transcript into <dir> as <name>.chat.jsonl (standard OpenAI/Anthropic',
                '     messages — the generic-chat adapter reads it; auto-distill turns it into reusable genes);',
                '   - when approved local memory is likely to help, call evolver_recall with sessionId set to the transcript filename WITHOUT the .jsonl suffix',
                '     (e.g. "run-1.chat" for run-1.chat.jsonl — the basename evolver derives), so the primed genes tie to that',
                '     transcript and auto-recall can observe which ones you actually used.',
                '',
                env,
                hints,
            ].filter(Boolean).join('\n');
        case 'opencode':
        case 'kiro':
            return [
                `manual: ${runtime} — evolver consumes ${runtime} sessions passively today and does not write its config.`,
                'For MCP tool discovery, register the evolver MCP server by hand:',
                snippet,
                '',
                `${runtime} has no SessionStart-hook hybrid, so this wires tool discovery only (no automatic memory injection).`,
                env,
                hints,
            ].filter(Boolean).join('\n');
        case 'openclaw':
            return [
                'manual: openclaw — no v2 auto-installer yet. Preferred: register the evolver MCP server:',
                snippet,
                '',
                'Alternatively, point an HTTP/A2A client at PrivateHub (endpoint supplied by your enterprise adapter).',
                env,
                hints,
            ].filter(Boolean).join('\n');
        case 'http-agent':
            return [
                'manual: http-agent — evolver does not configure an HTTP/API-only agent. Wire it to evolver/PrivateHub over HTTP/A2A.',
                `Keep credentials in your private env file and reference them via ${ENV_FILE_KEY}; never inline tokens in the agent config.`,
                ctx.hints && ctx.hints.length > 0 ? '' : 'The specific endpoint/headers are supplied by your enterprise adapter.',
                env,
                hints,
            ].filter(Boolean).join('\n');
        case 'server':
            return [
                'manual: server — evolver does not manage service lifecycle.',
                `Run the evolver process under your service manager with ${ENV_FILE_KEY} set to your credential store.`,
                'For a ready-to-edit template, run: evolver setup-hooks --runtime=server --service=launchd|systemd|windows|compose|k8s',
                env,
                hints,
            ].filter(Boolean).join('\n');
        default:
            // claude-code / codex / cursor are installed-class — they should never reach here, but stay honest if they do.
            return `manual wiring is not applicable to ${runtime} (it is auto-installed; run setup-hooks without treating it as manual).`;
    }
}