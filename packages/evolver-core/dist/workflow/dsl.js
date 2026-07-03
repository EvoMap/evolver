/**
 * Dynamic workflow DSL(M4B, 轨B 孵化). 声明式 + 受限表达式, **无任意 JS**(从语言层消除一类风险).
 * 表达式表示为**结构化对象**(非字符串解析): 引用 Ref + 白名单 core 调用, 安全 by-construction.
 */
export function isRef(v) { return typeof v === 'object' && v !== null && 'ref' in v; }
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