import { createHash } from 'node:crypto';
import { JsonlShadowSink, NullShadowSink } from './jsonlSink.js';
/** 脱敏(M8-5): 敏感文本(prompt/reasoning)截断 + sha256 短指纹, 不存全文. */
export function redactText(s, keep = 80) {
    if (s.length <= keep)
        return s;
    const h = createHash('sha256').update(s).digest('hex').slice(0, 12);
    return `${s.slice(0, keep)}…[+${s.length - keep}chars sha:${h}]`;
}
/**
 * 按 env 选 shadow sink(M8-5 默认最小披露可关):
 * EVOLVER_SHADOW_TELEMETRY=off → NullShadowSink(完全不落账本); 否则 JsonlShadowSink(只存 payloadSize 不存全文).
 */
export function shadowSinkFromEnv(env, ledgerPath, now) {
    if ((env.EVOLVER_SHADOW_TELEMETRY ?? '').toLowerCase() === 'off')
        return new NullShadowSink(now);
    return new JsonlShadowSink(ledgerPath, now);
}