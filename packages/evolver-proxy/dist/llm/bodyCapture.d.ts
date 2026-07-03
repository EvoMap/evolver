/** Bump when the redaction ruleset changes so downstream can tell which scrub a row went through. */
export declare const REDACTION_VERSION = "evolver-redact-v2";
export declare function legacyProxyTraceFullEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * Native body capture switch. Defaults to the v1-compatible full trace mode, but explicit v2 capture flags win so
 * operators can disable body capture without also setting the legacy EVOMAP_PROXY_TRACE knob.
 */
export declare function captureBodiesEnabled(env?: NodeJS.ProcessEnv): boolean;
/** Default per-body cap (bytes), aligned with the public Hub mailbox outbound envelope limit. A single trace may
 * still exceed the final encrypted outbound envelope when it carries multiple large bodies; in that case the row
 * is explicitly marked incomplete rather than silently downgraded to a preview. */
export declare const DEFAULT_TRACE_ENVELOPE_MAX_CHARS: number;
export declare function bodyMaxChars(env?: NodeJS.ProcessEnv): number;
export declare function traceEnvelopeMaxChars(env?: NodeJS.ProcessEnv): number;
export declare function positiveIntegerFromEnv(env: NodeJS.ProcessEnv, names: readonly string[], fallback: number): number;
/** Apply the redaction ruleset to a string. Pure; safe on arbitrary text. */
export declare function redactText(input: string): string;
export interface CapturedBody {
    /** Redacted JSON string of the native payload, or an explicit incomplete envelope when it exceeds the cap. */
    body: string;
    /** True when the full body could not fit in the trace envelope cap. */
    truncated: boolean;
    /** Redaction ruleset marker, so a consumer can tell the row actually went through a scrub. */
    redaction: string;
}
export declare function stableUserIdHash(value: unknown): string;
/**
 * Serialize a native request/response payload, run it through redaction, and cap its size. Never throws — capture
 * must never break serving — returning a small error envelope instead. Returns undefined for empty/absent input.
 */
export declare function captureBody(value: unknown, env?: NodeJS.ProcessEnv): CapturedBody | undefined;