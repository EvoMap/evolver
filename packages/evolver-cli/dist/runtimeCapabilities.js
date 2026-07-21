const supported = (evidence) => ({ status: 'supported', evidence });
const experimental = (evidence) => ({ status: 'experimental', evidence });
const unsupported = (evidence) => ({ status: 'unsupported', evidence });
/** Product-level runtime matrix. A transcript parser never implies execution, verification, or resumability. */
export const RUNTIME_CAPABILITY_MATRIX = {
    'claude-code': {
        runtime: 'claude-code',
        ingest: supported('normalized Claude Code JSONL adapter'),
        inject: supported('MCP registration plus SessionStart hook'),
        execute: supported('run-verified claude -p runner'),
        verify: supported('git diff proof plus external validation hook'),
        resume: unsupported('cycle runner does not bind ingested session ids to claude resume'),
    },
    codex: {
        runtime: 'codex',
        ingest: supported('normalized Codex rollout adapter'),
        inject: supported('project MCP config plus SessionStart hook'),
        execute: supported('run-verified codex exec runner'),
        verify: supported('git diff proof plus external validation hook'),
        resume: unsupported('cycle runner starts a new codex exec session'),
    },
    cursor: {
        runtime: 'cursor',
        ingest: supported('Cursor transcript and state.vscdb adapters'),
        inject: supported('always-on project rules injection'),
        execute: experimental('CLI flags are contract-tested but the repository still treats the runner as a scaffold'),
        verify: supported('git diff proof plus external validation hook'),
        resume: unsupported('no verified headless session resume mapping'),
    },
    gemini: {
        runtime: 'gemini',
        ingest: supported('normalized Gemini CLI session adapter'),
        inject: unsupported('no Evolver Gemini injection installer'),
        execute: experimental('hermetic Gemini CLI 0.46.0 headless JSON contract exists, but provider-backed live E2E smoke is not complete'),
        verify: experimental('hermetic structured-result and git-diff proof contract exists, but provider-backed live E2E verification is not complete'),
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
        ingest: supported('normalized Kimi session adapter'),
        inject: unsupported('no Evolver Kimi injection installer'),
        execute: unsupported('no verified Kimi runner contract'),
        verify: unsupported('no Kimi execution runner exists'),
        resume: unsupported('no verified Kimi resume contract'),
    },
    kiro: {
        runtime: 'kiro',
        ingest: supported('normalized Kiro session adapter'),
        inject: unsupported('automatic Kiro setup is not available on the current main branch'),
        execute: unsupported('no verified Kiro runner contract'),
        verify: unsupported('no Kiro execution runner exists'),
        resume: unsupported('no verified Kiro resume contract'),
    },
    opencode: {
        runtime: 'opencode',
        ingest: supported('normalized OpenCode session adapter'),
        inject: unsupported('automatic OpenCode setup is not available on the current main branch'),
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