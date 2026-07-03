export interface EnvFingerprint {
    /** sha256(hostname)[:12] — stable per machine, not reversible. */
    device: string;
    node_version: string;
    platform: string;
    arch: string;
    os_release: string;
    /** EVOLVER_REGION (<=5 chars, lowercased). */
    region?: string;
    container: boolean;
    /**
     * Underlying LLM model (detectModelName()): explicit EVOLVER_MODEL_NAME, else a host CLI's model env var,
     * else the literal 'unknown'. Deliberately NOT folded into envFingerprintKey() — a node can swap models
     * without changing its environment class, so the grouping key stays model-independent; the model travels
     * as its own field (e.g. so the Hub can index assets by model / feed the by-model leaderboard).
     */
    model: string;
}
export interface EnvCaptureDeps {
    platform?: string;
    arch?: string;
    nodeVersion?: string;
    osRelease?: string;
    hostname?: string;
    env?: Record<string, string | undefined>;
    isContainer?: () => boolean;
}
/**
 * Resolve the underlying LLM model name powering this evolver node (ported from v1 PR #174). Until now the
 * only source was the explicit EVOLVER_MODEL_NAME, so nodes that never set it published assets with no model
 * at all — the Hub could not tell which model produced a Gene/Capsule, starving the by-model leaderboard and
 * depriving anti-sybil clustering of a strong signal. We now fall back to the model env vars the common host
 * CLIs expose. When nothing is discoverable we return the literal 'unknown' rather than null/'' so downstream
 * aggregation always has a stable, groupable value and can distinguish "ran but model undetectable" from
 * "field absent (old client)".
 */
export declare function detectModelName(env?: Record<string, string | undefined>): string;
/** Capture the current runtime environment fingerprint. */
export declare function captureEnvFingerprint(deps?: EnvCaptureDeps): EnvFingerprint;
/**
 * Stable "environment class" key for grouping — two nodes with the same key are the same environment class.
 * Used by epigenetics to bucket a gene's per-environment success/failure (e.g. a gene that only fails on
 * win32/arm64 is suppressed there, not globally).
 */
export declare function envFingerprintKey(fp: EnvFingerprint): string;