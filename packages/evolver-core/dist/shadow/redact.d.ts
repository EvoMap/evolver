import type { ShadowSink } from './sink.js';
/** 脱敏(M8-5): 敏感文本(prompt/reasoning)截断 + sha256 短指纹, 不存全文. */
export declare function redactText(s: string, keep?: number): string;
export interface ShadowTelemetryEnv {
    EVOLVER_SHADOW_TELEMETRY?: string;
}
/**
 * 按 env 选 shadow sink(M8-5 默认最小披露可关):
 * EVOLVER_SHADOW_TELEMETRY=off → NullShadowSink(完全不落账本); 否则 JsonlShadowSink(只存 payloadSize 不存全文).
 */
export declare function shadowSinkFromEnv(env: ShadowTelemetryEnv, ledgerPath: string, now?: () => number): ShadowSink;