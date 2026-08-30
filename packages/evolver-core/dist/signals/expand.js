import { createHash } from 'node:crypto';
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
const SUCCESS_OUTCOME_TAGS = ['signal:success', 'action:optimize', 'action:innovate'];
const EXPLICIT_SUCCESS_SIGNALS = new Set([
    'issue_already_resolved',
    'issue_resolved',
    'openclaw_self_healed',
    'resolved',
    'self_healed',
    'stable_success_plateau',
    'success_prose',
    'verified-success',
    'verified_success',
]);
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
    { re: /(task|worker|heartbeat|hub|commitment|assignment|orchestration)/, tags: ['area:orchestration'] },
    // Tool-integrity (ported from v1 #99 gene_tool_integrity): bypassing a registered tool or looping on raw
    // shell is an orchestration-discipline / validation risk. CN/JA/KO aliases included for recall parity.
    { re: /(tool_bypass|tool_loop|工具绕过|工具循环|ツール迂回|ツールループ|도구우회|도구반복)/, tags: ['area:orchestration', 'risk:validation'] },
    { re: /(memory|narrative|reflection)/, tags: ['area:memory'] },
    { re: /(skill|dashboard)/, tags: ['area:skills'] },
    // Harness context budget (v1 context-compression gene family port): an agent harness that injects large
    // tool/MCP schemas, long skill manuals, agent-type descriptions, a memory index, or a pasted transcript can
    // exhaust the model's context window before the task starts. That is a prompt-assembly (area:prompt) cost
    // problem, and shrinking it is an optimize action — NOT a reliability failure. v2 has no seed-gene catalog,
    // so these rules ARE the shared vocabulary that lets a context-bloat signal reach a compression strategy.
    { re: /(context_bloat|context_explosion|context window|token_budget|prompt_budget|上下文爆|上下文预算|token 超限|token超限)/, tags: ['problem:context_budget', 'action:optimize', 'area:prompt'] },
    // Tool/MCP schema weight is the always-on half of the budget; lazy-loading it is the corrective action.
    { re: /(tool_schema|schema_bloat|mcp_tool_schema|lazy_load_schema|just-in-time schema|工具 schema|工具schema)/, tags: ['problem:context_budget', 'action:optimize', 'area:prompt', 'area:orchestration'] },
    // Skill manuals / agent-type descriptions are the other always-on half (area:skills already exists above).
    { re: /(skill_list_bloat|skill_manual_bloat|agent type description|mcp server instructions|skill 列表太长|技能列表太长)/, tags: ['problem:context_budget', 'action:optimize', 'area:skills', 'area:prompt'] },
    // A pasted transcript / session handoff is the caller-supplied half — compressing it is a memory-shaped concern.
    { re: /(transcript_bloat|transcript_context_bloat|conversation_handoff|session handoff|pasted transcript|会话上下文就爆|完整转录)/, tags: ['problem:context_budget', 'action:optimize', 'area:memory'] },
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
    // #578 success markers are structured signals; prose inference accepts negated forms too easily.
    if (signals.some((signal) => EXPLICIT_SUCCESS_SIGNALS.has(String(signal).trim().toLowerCase().normalize('NFKC')))) {
        for (const tag of SUCCESS_OUTCOME_TAGS)
            tags.add(tag);
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
const SEMANTIC_IDF_DOCUMENT_LIMIT = 1_000;
const SEMANTIC_IDF_TEXT_CHARS_PER_DOCUMENT = 4_096;
const SEMANTIC_IDF_TAG_INPUTS_PER_DOCUMENT = 256;
const SEMANTIC_IDF_TAG_CHARS = 1_024;
const SEMANTIC_IDF_TAGS_PER_DOCUMENT = 64;
const SEMANTIC_IDF_TOKENS_PER_DOCUMENT = 128;
const SEMANTIC_IDF_TAG_VOCABULARY_LIMIT = 8_192;
const SEMANTIC_IDF_TOKEN_VOCABULARY_LIMIT = 32_768;
function normalizeSemanticTag(tag) {
    return tag.normalize('NFKC').trim().toLowerCase();
}
function inverseDocumentFrequency(documentCount, documentFrequency) {
    return Math.log(documentCount / documentFrequency);
}
function tokenFrequency(text) {
    const frequencies = new Map();
    for (const token of tokenize(text)) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    return frequencies;
}
function compareCodeUnits(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function boundedUnique(values, limit) {
    return [...new Set(values.filter(Boolean))].sort(compareCodeUnits).slice(0, limit);
}
function boundedVocabulary(valuesByDocument, limit) {
    const vocabulary = new Set();
    for (const values of valuesByDocument) {
        for (const value of values)
            vocabulary.add(value);
    }
    // Selecting by code-unit order makes the cap independent of corpus/document order. The source set is itself
    // bounded by the per-document and document-count limits above, so this sort cannot grow without bound.
    return new Set([...vocabulary].sort(compareCodeUnits).slice(0, limit));
}
function semanticProfileVersion(documentCount, tagDocumentFrequency, tokenDocumentFrequency) {
    // Hash only normalized document-frequency entries so decision telemetry never contains plaintext corpus data.
    // A 128-bit SHA-256 prefix keeps the identifier compact while avoiding the collision rate of a 32-bit checksum.
    const hash = createHash('sha256');
    hash.update(`documents:${documentCount};`, 'utf8');
    for (const [tag, frequency] of [...tagDocumentFrequency].sort(([left], [right]) => compareCodeUnits(left, right))) {
        hash.update(`tag:${tag.length}:${tag}:${frequency};`, 'utf8');
    }
    for (const [token, frequency] of [...tokenDocumentFrequency].sort(([left], [right]) => compareCodeUnits(left, right))) {
        hash.update(`token:${token.length}:${token}:${frequency};`, 'utf8');
    }
    return `idf-2:n=${documentCount};tags=${tagDocumentFrequency.size};tokens=${tokenDocumentFrequency.size};sha256=${hash.digest('hex').slice(0, 32)}`;
}
export function buildSemanticIdfProfile(documents) {
    const boundedDocuments = documents.slice(0, SEMANTIC_IDF_DOCUMENT_LIMIT).map((document) => ({
        tags: boundedUnique(document.tags
            .slice(0, SEMANTIC_IDF_TAG_INPUTS_PER_DOCUMENT)
            .map((tag) => normalizeSemanticTag(tag.slice(0, SEMANTIC_IDF_TAG_CHARS))), SEMANTIC_IDF_TAGS_PER_DOCUMENT),
        tokens: boundedUnique(tokenize(document.text.slice(0, SEMANTIC_IDF_TEXT_CHARS_PER_DOCUMENT)), SEMANTIC_IDF_TOKENS_PER_DOCUMENT),
    }));
    const tagVocabulary = boundedVocabulary(boundedDocuments.map((document) => document.tags), SEMANTIC_IDF_TAG_VOCABULARY_LIMIT);
    const tokenVocabulary = boundedVocabulary(boundedDocuments.map((document) => document.tokens), SEMANTIC_IDF_TOKEN_VOCABULARY_LIMIT);
    const tagDocumentFrequency = new Map();
    const tokenDocumentFrequency = new Map();
    for (const document of boundedDocuments) {
        for (const tag of document.tags) {
            if (!tagVocabulary.has(tag))
                continue;
            tagDocumentFrequency.set(tag, (tagDocumentFrequency.get(tag) ?? 0) + 1);
        }
        for (const token of document.tokens) {
            if (!tokenVocabulary.has(token))
                continue;
            tokenDocumentFrequency.set(token, (tokenDocumentFrequency.get(token) ?? 0) + 1);
        }
    }
    const documentCount = boundedDocuments.length;
    const tagIdf = new Map();
    const tokenIdf = new Map();
    for (const [tag, frequency] of tagDocumentFrequency) {
        tagIdf.set(tag, inverseDocumentFrequency(documentCount, frequency));
    }
    for (const [token, frequency] of tokenDocumentFrequency) {
        tokenIdf.set(token, inverseDocumentFrequency(documentCount, frequency));
    }
    return {
        documentCount,
        tagIdf,
        tokenIdf,
        version: semanticProfileVersion(documentCount, tagDocumentFrequency, tokenDocumentFrequency),
    };
}
export function idfTagOverlapScore(signals, gene, profile) {
    if (profile.documentCount <= 1)
        return tagOverlapScore(signals, gene);
    const signalTags = [...new Set(expandSignals(signals).map(normalizeSemanticTag))];
    const geneTagSet = new Set(geneTags(gene).map(normalizeSemanticTag));
    let matchedWeight = 0;
    let totalWeight = 0;
    for (const tag of signalTags) {
        const weight = profile.tagIdf.get(tag);
        if (weight === undefined)
            continue;
        totalWeight += weight;
        if (geneTagSet.has(tag))
            matchedWeight += weight;
    }
    return totalWeight > 0 ? matchedWeight / totalWeight : 0;
}
export function idfBagCosine(a, b, profile) {
    if (profile.documentCount <= 1)
        return bagCosine(a, b);
    const bagA = tokenFrequency(a);
    const bagB = tokenFrequency(b);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const [token, count] of bagA) {
        const weight = profile.tokenIdf.get(token);
        if (weight === undefined)
            continue;
        const weightedCount = count * weight;
        normA += weightedCount * weightedCount;
        const otherCount = bagB.get(token);
        if (otherCount !== undefined)
            dot += weightedCount * otherCount * weight;
    }
    for (const [token, count] of bagB) {
        const weight = profile.tokenIdf.get(token);
        if (weight === undefined)
            continue;
        const weightedCount = count * weight;
        normB += weightedCount * weightedCount;
    }
    if (normA === 0 || normB === 0)
        return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}