// Signal expansion & tag classification (ported from v1 src/gep/learningSignals.js).
// Raw signals (e.g. '429') are expanded into broader semantic tags (e.g. 'problem:reliability',
// 'action:repair') so gene selection can match by MEANING, not just literal string intersection —
// closing the recall gap where a '429' signal could not reach a gene tagged for 'repair'.
// Regex → semantic tags. A rule fires if its pattern matches anywhere in the lowercased signal text.
// The reliability / protocol / performance / capability families also carry CN/JA/KO synonyms so a
// non-Latin signal ('错误' / 'エラー' / '오류') expands to the same tags an English one would and can
// reach an English-keyworded gene through tagOverlapScore. This is the v2-native port of v1 #99's
// multilingual signals_match aliases: v1 attached `|`-pipe synonyms to shipped seed genes, but v2 has
// no seed-gene catalog and no pipe-alias parsing — its expansion rules ARE the shared signal vocabulary.
const EXPANSION_RULES = [
    { re: /(error|exception|failed|unstable|log_error|runtime|429|错误|异常|エラー|오류|例外|예외|失败|失敗|실패|不稳定|不安定|불안정)/, tags: ['problem:reliability', 'action:repair'] },
    // Korean 감사 alone is a homograph (audit == "thank you"), so it is matched only via compounds / audit-context
    // phrases (감사로그 / 감사추적 / 감사 로그 / 감사 추적 / 코드 감사) — never bare 감사, so benign gratitude text like
    // '감사합니다' cannot fire. Bare CN 提示 (= hint/notice) is likewise omitted; only the unambiguous 提示词 (= prompt)
    // is matched. The 'reusable' cluster (可复用 / 再利用 / 재사용) recalls the optimize/protocol family (v1 #99).
    { re: /(protocol|prompt|audit|gep|schema|drift|reusable|协议|プロトコル|프로토콜|提示词|プロンプト|프롬프트|审计|監査|可复用|再利用|재사용|감사로그|감사추적|감사 로그|감사 추적|코드 감사)/, tags: ['problem:protocol', 'action:optimize', 'area:prompt'] },
    { re: /(perf|performance|bottleneck|latency|slow|throughput|性能|瓶颈|パフォーマンス|성능|병목)/, tags: ['problem:performance', 'action:optimize'] },
    // 功能/機能/기능 alone are too broad: as unanchored substrings they match the malfunction vocabulary
    // (機能不全 / 기능장애 / 功能障碍), which are reliability problems — use the v1 #99 feature-request compounds.
    { re: /(feature|capability_gap|user_feature_request|external_opportunity|stagnation recommendation|功能请求|機能リクエスト|기능요청|能力缺口|機能ギャップ|역량공백|改进建议|改善提案|개선제안|外部机会|外部機会|외부기회)/, tags: ['problem:capability', 'action:innovate'] },
    // Negative lookbehind on `plateau`: `stable_success_plateau` contains the substring `plateau`, but it is a
    // SUCCESS signal (#578), not a stagnation signal. Without (?<!success_) the stagnation rule would fire on it,
    // producing contradictory tags (problem:stagnation + signal:success) in a single expandSignals pass.
    { re: /(stagnation|(?<!success_)plateau|steady_state|saturation|empty_cycle_loop|loop_detected|recurring)/, tags: ['problem:stagnation', 'action:innovate'] },
    // Success signals (v2-native, #578): a stable success plateau or resolved issue expands to
    // signal:success + action:optimize/action:innovate so a gene tagged for optimization/innovation can be selected
    // when the loop is succeeding — enabling "learn from what works" rather than only "fix what's broken".
    // `verified[-_]success` matches both the underscore form (meta-signal naming) and the hyphen form
    // (distillPrimitives signalTokens token) so success genes distilled from sessions are also expanded.
    { re: /(stable_success_plateau|issue_already_resolved|openclaw_self_healed|self_healed|resolved|verified[-_]success|success_prose)/, tags: ['signal:success', 'action:optimize', 'action:innovate'] },
    { re: /(task|worker|heartbeat|hub|commitment|assignment|orchestration)/, tags: ['area:orchestration'] },
    // Tool-integrity (ported from v1 #99 gene_tool_integrity): bypassing a registered tool or looping on raw
    // shell is an orchestration-discipline / validation risk. CN/JA/KO aliases included for recall parity.
    { re: /(tool_bypass|tool_loop|工具绕过|工具循环|ツール迂回|ツールループ|도구우회|도구반복)/, tags: ['area:orchestration', 'risk:validation'] },
    { re: /(memory|narrative|reflection)/, tags: ['area:memory'] },
    { re: /(skill|dashboard)/, tags: ['area:skills'] },
    { re: /(validation|canary|rollback|constraint|blast radius|destructive)/, tags: ['risk:validation'] },
];
/**
 * Expand a signal list into literal signals + namespace prefixes + semantic category tags.
 * e.g. ['429', 'auth:token'] → ['429', 'auth:token', 'auth', 'problem:reliability', 'action:repair'].
 */
export function expandSignals(signals, extraText = '') {
    const tags = new Set();
    for (const s of signals) {
        const str = String(s);
        tags.add(str);
        const base = str.split(':')[0];
        if (base && base !== str)
            tags.add(base); // namespace prefix (e.g. 'auth:token' → 'auth')
    }
    const text = (signals.join(' ') + ' ' + extraText).toLowerCase().normalize('NFKC');
    for (const rule of EXPANSION_RULES) {
        if (rule.re.test(text))
            for (const t of rule.tags)
                tags.add(t);
    }
    return [...tags];
}
/**
 * Tokenize free text into a lowercased bag of words (letter/number runs of length >= 2).
 * Unicode-aware (`\p{L}\p{N}`): a Latin-only `[^a-z0-9]+` split silently dropped CJK / Cyrillic /
 * Arabic content, so CN/JA/KO signals like '错误' / 'タスク失敗' / '오류' tokenized to [] and the
 * {@link bagCosine} recall path scored 0 on every cycle for non-Latin users (ported from v1 #99,
 * which fixed the same Latin-only regex in selector.tokenize). Lowercased then NFKC-normalized before splitting (the established house idiom in
 * signatures.ts), so full-width / half-width IME forms ('４２９' / 'ＥＲＲＯＲ' / 'ｴﾗｰ') fold to the
 * normal forms the rules and gene text already use, and punctuation/symbols are stripped so
 * 'error.' and 'error' tokenize identically.
 */
function tokenize(text) {
    return text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
}
/**
 * Bag-of-words cosine similarity (0..1) between two free-text strings (ported from v1 scoreGeneSemantic).
 * Term-frequency vectors, cosine of the angle. Returns 0 when either side has no tokens or they share none.
 * This is the lexical-similarity recall path that complements {@link tagOverlapScore}'s curated tags:
 * a signal 'timeout_slow' and a gene summarized "fix the slow timeout" share the 'timeout'/'slow' tokens
 * even when neither the literal signal nor the expansion rules connect them.
 */
export function bagCosine(a, b) {
    const av = new Map();
    const bv = new Map();
    for (const t of tokenize(a))
        av.set(t, (av.get(t) ?? 0) + 1);
    for (const t of tokenize(b))
        bv.set(t, (bv.get(t) ?? 0) + 1);
    if (av.size === 0 || bv.size === 0)
        return 0;
    let dot = 0;
    for (const [t, c] of av)
        dot += c * (bv.get(t) ?? 0);
    if (dot === 0)
        return 0;
    const mag = (m) => Math.sqrt([...m.values()].reduce((s, c) => s + c * c, 0));
    return dot / (mag(av) * mag(bv));
}
/** Expand a gene's category + signals_match + id + summary into its semantic tag set. */
export function geneTags(gene) {
    const inputs = [];
    if (gene.category)
        inputs.push('action:' + gene.category.toLowerCase());
    if (gene.signalsMatch)
        inputs.push(...gene.signalsMatch);
    if (gene.geneId)
        inputs.push(gene.geneId);
    if (gene.summary)
        inputs.push(gene.summary);
    return expandSignals(inputs, '');
}
/**
 * Semantic tag overlap (0..1): fraction of the expanded SIGNAL tags that the gene's expanded tags cover.
 * Normalized on the signal (query) side so a gene with a long id/summary is not penalized by noise.
 * This is the recall component: '429' and a gene tagged 'error'/'repair' both expand to
 * 'problem:reliability'/'action:repair', so they overlap even with zero literal string match.
 *
 * Known v1→v2 fidelity delta: a lone non-Latin signal caps near ~2/3 here — its raw token ('错误') is in the
 * signal tag-set but never on the English-keyworded gene side, while an exact English signal short-circuits to
 * literal=1.0 upstream in expandedMatchScore. v1 #99 gave CJK full literal credit via pipe-aliases; v2 reaches
 * the right gene at ~2/3 strength. Lifting this to parity is a scoring-design change beyond this signal port.
 */
export function tagOverlapScore(signals, gene) {
    const sigTags = expandSignals(signals);
    if (sigTags.length === 0)
        return 0;
    const geneTagSet = new Set(geneTags(gene));
    if (geneTagSet.size === 0)
        return 0;
    let hits = 0;
    for (const t of sigTags)
        if (geneTagSet.has(t))
            hits++;
    return hits / sigTags.length;
}