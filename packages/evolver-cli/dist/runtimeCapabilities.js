const supported = (evidence) => ({ status: 'supported', evidence });
const experimental = (evidence) => ({ status: 'experimental', evidence });
const unsupported = (evidence) => ({ status: 'unsupported', evidence });
/** Product-level runtime matrix. A transcript parser never implies execution, verification, or resumability. */
export const RUNTIME_CAPABILITY_MATRIX = {
    'claude-code': {
        runtime: 'claude-code',
        ingest: supported('normalized Claude Code JSONL adapter'),
        inject: supported('MCP registration plus SessionStart hook'),
        execute: unsupported('built-in Claude is fail-closed until host filesystem and network containment is verified'),
        verify: unsupported('no safely runnable autonomous Claude verification path'),
        resume: unsupported('native session identity mapping is implemented, but built-in Claude execution is disabled until host containment is verified'),
    },
    codex: {
        runtime: 'codex',
        ingest: supported('normalized Codex rollout adapter'),
        inject: supported('project MCP config plus SessionStart hook'),
        execute: unsupported('built-in Codex is fail-closed because workspace-write does not contain host filesystem reads'),
        verify: unsupported('no safely runnable autonomous Codex verification path without external host containment'),
        resume: unsupported('cycle runner starts a new codex exec session'),
    },
    cursor: {
        runtime: 'cursor',
        ingest: supported('Cursor transcript and state.vscdb adapters'),
        inject: supported('always-on project rules injection'),
        execute: unsupported('headless Cursor workspace trust grants uncontained host filesystem and network access'),
        verify: unsupported('no safely runnable autonomous Cursor execution path'),
        resume: unsupported('native session identity mapping is implemented, but autonomous Cursor execution is disabled until host filesystem and network containment are verified'),
    },
    gemini: {
        runtime: 'gemini',
        ingest: supported('normalized Gemini CLI session adapter'),
        inject: unsupported('no Evolver Gemini injection installer'),
        execute: experimental('Gemini CLI 0.46.0 deterministic real-runtime cycle smoke passed; provider-backed live E2E smoke is not complete'),
        verify: experimental('real CLI edit, independent validation, Git patch proof, and cleanup passed with deterministic responses; provider-backed live E2E verification is not complete'),
        resume: unsupported('Gemini resume accepts latest/index; ingested UUIDs cannot be mapped reliably'),
    },
    antigravity: {
        runtime: 'antigravity',
        ingest: supported('strict Antigravity transcript adapter'),
        inject: supported('user-level MCP tool discovery only; no SessionStart hook'),
        execute: unsupported('agy is not installed or live-verified in the implementation environment'),
        verify: unsupported('no Antigravity runner result is wired to state proof'),
        resume: unsupported('no verified transcript-id to agy resume contract'),
    },
    kimi: {
        runtime: 'kimi',
        ingest: experimental('registered parser for the documented Kimi wire.jsonl shape; no sanitized real-log golden fixture'),
        inject: unsupported('no Evolver Kimi injection installer'),
        execute: unsupported('no verified Kimi runner contract'),
        verify: unsupported('no Kimi execution runner exists'),
        resume: unsupported('no verified Kimi resume contract'),
    },
    kiro: {
        runtime: 'kiro',
        ingest: unsupported('transcript adapter is not registered; no real-log golden fixture'),
        inject: supported('verified Kiro MCP config installer for tool discovery; no lifecycle prompt injection'),
        execute: unsupported('no verified Kiro runner contract'),
        verify: unsupported('no Kiro execution runner exists'),
        resume: unsupported('no verified Kiro resume contract'),
    },
    opencode: {
        runtime: 'opencode',
        ingest: unsupported('transcript adapter is not registered; no real-log golden fixture'),
        inject: supported('verified OpenCode MCP config installer for tool discovery; no lifecycle prompt injection'),
        execute: unsupported('no verified OpenCode runner contract'),
        verify: unsupported('no OpenCode execution runner exists'),
        resume: unsupported('no verified OpenCode resume contract'),
    },
    'generic-chat': {
        runtime: 'generic-chat',
        ingest: supported('normalized standard OpenAI and Anthropic message JSON/JSONL adapter'),
        inject: unsupported('generic transcript interchange has no Evolver injection installer'),
        execute: unsupported('generic chat transcripts do not identify a runnable provider or CLI contract'),
        verify: unsupported('no provider-backed execution runner exists for generic chat transcripts'),
        resume: unsupported('no provider or session identity contract exists for generic chat transcripts'),
    },
};
export function runtimeCapabilities() {
    return Object.values(RUNTIME_CAPABILITY_MATRIX);
}