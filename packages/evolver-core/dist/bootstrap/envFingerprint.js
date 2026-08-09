// Environment fingerprint capture (ported from v1 src/gep/envFingerprint.js). Captures the runtime
// environment (node/platform/arch/os/region/container/model) so an outcome can be attributed to an
// "environment class" — the prerequisite for epigenetic per-environment gene suppression and for GDI scoring.
// Privacy: hostname is sha256-truncated, never stored in clear. os/process reads are injectable for tests.
import { hostname as osHostname, release as osRelease } from 'node:os';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
export function normalizeEvolverVersion(value) {
    return value?.trim().slice(0, 64) || undefined;
}
/** Heuristic container detection (Docker / Kubernetes). */
function detectContainer(env) {
    if (env['KUBERNETES_SERVICE_HOST'])
        return true;
    try {
        if (existsSync('/.dockerenv'))
            return true;
    }
    catch { /* not on a filesystem with it */ }
    return false;
}
// Env vars that expose the underlying LLM model, in priority order. EVOLVER_MODEL_NAME is the explicit
// operator override; the rest are what the common host CLIs (Claude Code / Codex / Cursor / generic
// OpenAI-compatible runners) set. First non-empty wins.
const MODEL_ENV_VARS = [
    'EVOLVER_MODEL_NAME',
    'ANTHROPIC_MODEL',
    'CLAUDE_MODEL',
    'CLAUDE_CODE_MODEL',
    'OPENAI_MODEL',
    'CODEX_MODEL',
    'CURSOR_MODEL',
];
/**
 * Resolve the underlying LLM model name powering this evolver node (ported from v1 PR #174). Until now the
 * only source was the explicit EVOLVER_MODEL_NAME, so nodes that never set it published assets with no model
 * at all — the Hub could not tell which model produced a Gene/Capsule, starving the by-model leaderboard and
 * depriving anti-sybil clustering of a strong signal. We now fall back to the model env vars the common host
 * CLIs expose. When nothing is discoverable we return the literal 'unknown' rather than null/'' so downstream
 * aggregation always has a stable, groupable value and can distinguish "ran but model undetectable" from
 * "field absent (old client)".
 */
export function detectModelName(env = (typeof process !== 'undefined' ? process.env : {})) {
    for (const key of MODEL_ENV_VARS) {
        const v = (env[key] ?? '').trim();
        if (v)
            return v.slice(0, 100);
    }
    return 'unknown';
}
/** Capture the current runtime environment fingerprint. */
export function captureEnvFingerprint(deps = {}) {
    const env = deps.env ?? (typeof process !== 'undefined' ? process.env : {});
    const region = (env['EVOLVER_REGION'] ?? '').trim().toLowerCase().slice(0, 5) || undefined;
    const evolverVersion = normalizeEvolverVersion(deps.evolverVersion);
    return {
        device: sha12(deps.hostname ?? osHostname()),
        node_version: deps.nodeVersion ?? process.version,
        platform: deps.platform ?? process.platform,
        arch: deps.arch ?? process.arch,
        os_release: deps.osRelease ?? osRelease(),
        ...(region ? { region } : {}),
        container: deps.isContainer ? deps.isContainer() : detectContainer(env),
        model: detectModelName(env),
        ...(evolverVersion ? { evolver_version: evolverVersion } : {}),
    };
}
/**
 * Stable "environment class" key for grouping — two nodes with the same key are the same environment class.
 * Used by epigenetics to bucket a gene's per-environment success/failure (e.g. a gene that only fails on
 * win32/arm64 is suppressed there, not globally).
 */
export function envFingerprintKey(fp) {
    const nodeMajor = (fp.node_version || '').replace(/^v/, '').split('.')[0] ?? '';
    return [fp.platform, fp.arch, `node${nodeMajor}`, fp.region ?? '', fp.device].join('|');
}