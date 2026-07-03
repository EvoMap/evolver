import type { AssetRecord } from '../assetstore/provider.js';
export declare const REDACTED = "[REDACTED]";
/** Apply every redaction pattern (secrets → [REDACTED]) then anonymize local paths (~/...) to a single string. */
export declare function redactString(s: string): string;
/** Deep redaction: recursively redact string values in objects/arrays (keys untouched). Returns a copy; does not mutate the input. */
export declare function redactDeep<T>(v: T): T;
/**
 * Redact a single asset and RECOMPUTE its asset_id (command point). When redaction changes content, the id must
 * change with it, otherwise the published body and id disagree. computeAssetId excludes the asset_id field by
 * default; on the rare null return we fall back to the original id.
 */
export declare function sanitizeAsset(asset: AssetRecord): AssetRecord;
export interface Leak {
    type: string;
    value: string;
    suggestion: string;
}
/** Pattern-scan content for sensitive info. Does not mutate content; returns a structured result. */
export declare function scanForLeaks(content: string): {
    found: boolean;
    leaks: Leak[];
};
/** Reverse detection: if any process.env value (>=8 chars) appears verbatim in content, an env value was hardcoded and should be replaced with the env reference. */
export declare function detectEnvValueLeaks(content: string, env: Record<string, string | undefined>): Leak[];
/** Full leak check: pattern scan + reverse env-value detection. */
export declare function fullLeakCheck(content: string, env: Record<string, string | undefined>): {
    found: boolean;
    leaks: Leak[];
};
export type LeakCheckMode = 'strict' | 'warn' | 'off';
/** Read the leak-check mode from env (EVOLVER_LEAK_CHECK, default strict, matching v1). */
export declare function leakCheckModeFromEnv(env: Record<string, string | undefined>): LeakCheckMode;
export interface SanitizeBundleResult {
    /** The redacted bundle (asset_id recomputed). Redaction always happens regardless of mode (the leak-proof floor). */
    bundle: AssetRecord[];
    /** strict mode + leak found → true: the chokepoint should refuse to publish (not retryable). */
    blocked: boolean;
    /** Leaks found (scanned on the original content, before redaction). */
    leaks: Leak[];
    mode: LeakCheckMode;
}
/**
 * Pre-publish sanitize of a bundle (pure, never throws):
 * 1) mode != off: scan the ORIGINAL (pre-redaction) content for leaks; strict + found → blocked=true (chokepoint refuses); warn → flag only.
 * 2) REGARDLESS of mode, always deep-redact every asset + recompute asset_id (the leak-proof floor; off only skips the scan, not the redaction).
 */
export declare function sanitizeBundle(bundle: readonly AssetRecord[], opts: {
    env: Record<string, string | undefined>;
    mode?: LeakCheckMode;
}): SanitizeBundleResult;
/** Collapse a leak list into a one-line human-readable summary (for logs / rejection reason). */
export declare function summarizeLeaks(leaks: readonly Leak[]): string;