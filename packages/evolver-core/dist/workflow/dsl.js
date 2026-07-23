/**
 * Dynamic workflow DSL(M4B, 轨B 孵化). 声明式 + 受限表达式, **无任意 JS**(从语言层消除一类风险).
 * 表达式表示为**结构化对象**(非字符串解析): 引用 Ref + 白名单 core 调用, 安全 by-construction.
 */
export function isRef(v) { return typeof v === 'object' && v !== null && 'ref' in v; }
const WORKFLOW_SENSITIVE_TEXT_RE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\b(?:gh[oprsu]|npm)_[A-Za-z0-9_-]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|passwd|secret|token|api[_-]?key|accountkey)\s*[:=]\s*\S+)/i;
export function containsWorkflowSensitiveText(value) {
    return WORKFLOW_SENSITIVE_TEXT_RE.test(value);
}
export const CORE_WHITELIST = {
    list_len: (a) => (Array.isArray(a) ? a.length : 0),
    filter_by_mask: (items, mask) => (Array.isArray(items) && Array.isArray(mask) ? items.filter((_, i) => Boolean(mask[i])) : []),
    contains: (hay, needle) => String(hay).includes(String(needle)),
    concat: (...xs) => xs.flat(),
    upper: (s) => String(s).toUpperCase(),
    eq: (a, b) => a === b,
    not: (a) => !a,
    identity: (a) => a,
};