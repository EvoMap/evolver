// ingest、observer 和 material package 共用的确定性起草器；只提取原文，不执行命令或调用模型。
import { algo, hub } from '@evomap/evolver-core';
// Map a strong signal's free-text to a SHORT, matchable token (so a gene's signals_match stays a few
// keywords, not a dumped error blob). Deterministic + testable; unknown errors fall back to the tool name only.
const SIGNAL_ERROR_CLASSES = [
    [/exit code:?\s*[1-9]/i, 'exit-code'],
    [/ENOENT|no such file|does not exist|cannot access|did not match/i, 'file-not-found'],
    [/command not found/i, 'command-not-found'],
    [/Traceback|Exception|panic:/i, 'exception'],
    [/SyntaxError/i, 'syntax-error'],
    [/permission denied/i, 'permission-denied'],
    [/timed?\s?out/i, 'timeout'],
];
/** Short matchable signal tokens from STRONG signals (error classes) and SUCCESS signals (verified capabilities).
 *  Every strong signal yields ≥1 token: if it has no toolName and matches no known error class (e.g. `FAILED: …` or
 *  `Error: connection refused`), it falls back to its kind (`structured_error`/`error_result`) so a real strong
 *  signal is never silently tokenless — keeping `signals_match.length === 0` an honest "no strong signal" gate.
 *  Success signals (#578) also produce tokens so a purely successful session can yield a matchable gene.
 *  Deduped, ≤8. */
export function signalTokens(sigs) {
    const set = new Set();
    for (const s of sigs) {
        if (s.strength !== 'strong')
            continue;
        let matched = false;
        if (s.toolName) {
            set.add(s.toolName);
            matched = true;
        }
        for (const [re, tok] of SIGNAL_ERROR_CLASSES)
            if (re.test(s.text)) {
                set.add(tok);
                matched = true;
                break;
            }
        if (!matched)
            set.add(s.kind);
    }
    // A later failure invalidates an earlier successful intermediate command. Conversely, fail-then-pass remains a
    // valid repair history because the last deterministic outcome is the verified success.
    const lastOutcome = sigs.findLast((s) => s.strength === 'strong' || s.strength === 'weak' || (s.strength === 'success' && !s.needsAnalysis));
    const terminalSuccess = lastOutcome?.strength === 'success' && !lastOutcome.needsAnalysis;
    // Only confirmed terminal success enters the deterministic path. Prose marked needsAnalysis is left to transcript
    // LLM distillation instead of triggering a material cycle before analysis has happened.
    for (const s of terminalSuccess ? sigs : []) {
        if (s.strength !== 'success' || s.needsAnalysis)
            continue;
        if (s.toolName)
            set.add(s.toolName);
        if (s.kind === 'verified_success')
            set.add('verified-success');
        else
            set.add(s.kind);
    }
    return [...set].slice(0, 8);
}
const MAX_STRATEGY_STEPS = 6;
const MAX_STEP_CHARS = 200;
// 仅用于保留物理版面；不扩展下方Markdown fence、段落或切句语法，也不替换字符。
const LAYOUT_LINE_BREAK = /[\r\n\u2028\u2029]/u;
const PREFIXED_SINGLE_QUOTE = /(?:^|[^\p{L}\p{N}_])(?:[rubf]|br|rb|fr|rf)$/iu;
function* textUnits(text) {
    let start = 0;
    let quote = '';
    let fence = '';
    const brackets = [];
    const emit = (end, complete = true) => {
        let first = start;
        let firstLineStart = start;
        let startsLine = start === 0 || LAYOUT_LINE_BREAK.test(text[start - 1]);
        while (first < end && /\s/u.test(text[first])) {
            if (LAYOUT_LINE_BREAK.test(text[first])) {
                firstLineStart = first + 1;
                startsLine = true;
            }
            first++;
        }
        let last = end;
        while (last > first && /\s/u.test(text[last - 1]))
            last--;
        // 多行单元保留首行缩进；只剔除段落分隔，不改变代码各行的相对层级。
        if (startsLine && LAYOUT_LINE_BREAK.test(text.slice(first, last)))
            first = firstLineStart;
        start = end;
        return { start: first, end: last, complete };
    };
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        // fenced block 按整块保留，代码中的标点、空行和字符串不参与句子切分。
        if (index === 0 || text[index - 1] === '\n' || text[index - 1] === '\r') {
            const marker = /^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*/.exec(text.slice(index));
            if (marker && !quote) {
                const delimiter = marker[1];
                if (!fence)
                    fence = delimiter;
                else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && marker[0].trim() === delimiter) {
                    fence = '';
                    yield emit(index + marker[0].length);
                }
                index += marker[0].length - 1;
                continue;
            }
        }
        if (fence)
            continue;
        if (quote) {
            if (char === '\\') {
                index++;
                continue;
            }
            if (text.startsWith(quote, index)) {
                index += quote.length - 1;
                quote = '';
            }
            continue;
        }
        if (char === '`') {
            quote = /^`+/.exec(text.slice(index))[0];
            index += quote.length - 1;
            continue;
        }
        // 常见Python字符串前缀是quote的一部分；普通英文单词内的apostrophe仍不是字符串起点。
        const prefixedQuote = char === "'" && PREFIXED_SINGLE_QUOTE.test(text.slice(Math.max(0, index - 4), index));
        if (char === '"' || char === '“' || char === '‘'
            || (char === "'" && (prefixedQuote || !/[\p{L}\p{N}]/u.test(text[index - 1] ?? '')))) {
            quote = char === '“' ? '”' : char === '‘' ? '’' : char;
            continue;
        }
        if ('([{'.includes(char))
            brackets.push(char);
        else if (')]}'.includes(char) && brackets.length > 0) {
            if ('([{'.indexOf(brackets.at(-1)) === ')]}'.indexOf(char))
                brackets.pop();
        }
        if (brackets.length > 0)
            continue;
        const next = text.slice(index + 1);
        const listMarker = char === '.' && /^\s*\d{1,3}$/.test(text.slice(start, index));
        // A standalone '.' or '..' is a directory operand, not prose punctuation.
        // Inspect only the token boundary; executable names do not define sentence grammar.
        const dotStart = text[index - 1] === '.' ? index - 1 : index;
        const directoryOperand = char === '.' && (dotStart === 0 || /\s/u.test(text[dotStart - 1]));
        const sentenceEnd = /[。！？]/u.test(char)
            || (!listMarker && !directoryOperand && /[.!?]/u.test(char) && (next === '' || /^(?:\s|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/u.test(next)));
        const lineEnd = char === '\n' || (char === '\r' && text[index + 1] !== '\n');
        const paragraphEnd = lineEnd && /^(?:[ \t]*(?:\r\n?|\n)|[ \t]*(?:[-*+] |\d+[.)] |Exit code:))/i.test(next);
        if (sentenceEnd || paragraphEnd)
            yield emit(index + 1);
    }
    if (start < text.length)
        yield emit(text.length, quote === '' && fence === '' && brackets.length === 0);
}
const NARRATION_OPENER = /^(let me (take a (closer )?)?look|let me (check|see|inspect|investigate)|i'?ll (take a look|check|look|see)|let'?s (take a )?(look|see)|now,? let me (look|check|see))\b/i;
const HAS_SUBSTANCE = /\b(because|so that|root cause|the (issue|bug|problem|fix|error)|fix(ed|es|ing)?|add(ed|ing)?|remov(e|ed|ing)|delet(e|ed|ing)|chang(e|ed|ing)?|updat(e|ed|ing)?|replac(e|ed|ing)?|renam(e|ed|ing)?|implement(ed|ing)?|revert(ed)?|switch(ed|ing)?|configur(e|ed|ing)?|install(ed|ing)?|return(s|ed)?|throw(s|n)?|catch|wrap(ped)?|guard|import(ed|s)?|export(ed|s)?|re-?run|retry|set\s)\b/i;
const ACTION = /\b(use[ds]?|using|run|running|ran|read|open|write|render|call|preserv(e|ed)|reproduc(e|ed)|check|verify)\b|修复|修正|原因|根因|导致|添加|删除|替换|改为|改用|采用|设置|使用|读取|写入|打开|运行|重新|配置|检查|調べ|設定|変更|接続|수정|설정|변경|조사|원인/i;
const CAUSE_OR_FIX = /\b(root cause|because|fix(?:ed|es|ing)?)\b|根因|修复|原因|修正|원인|수정/i;
const CODE_TARGET = /`|(?:[\w/-]+\.[a-z]{2,5}\b)|(?:--[\w-]+(?:=|\s))|(?:\b[\w_]+\s*=)/i;
const COMPLETION = /\b(all correct|done|complete[ds]?|fixed|success(?:ful|fully)?|passed|verified|resolved)\b|全部完成|所有.*通过|全部通过|均通过|已经完成|已完成|成功|完了|완료/i;
const REUSABLE_WORKFLOW = /\b(reusable|repeatable|workflow|playbook|runbook|procedure|recipe)\b|复用|工作流|可重用/i;
const GENERIC_COMPLETION_WORDS = /\b(i|we|it|the|a|an|all|everything|has|have|been|is|are|was|were|and|now|already|fully|successfully|issue|issues|problem|problems|task|tasks|work|tests?|checks?|validation|done|completed?|finished|fixed|resolved|passed|verified)\b/gi;
const GENERIC_COMPLETION_CJK = /所有|全部|已经|已|问题|错误|任务|工作|测试|验证|检查|均|都|通过|修复|解决|完成|成功|了/g;
// These tokens are for classification only; extraction keeps the original text and offsets.
// Quoted filenames/code remain atoms, so punctuation and conjunctions inside them cannot
// masquerade as clause boundaries or verbs. The source unit has already passed textUnits.
const CLAUSE_TOKENS = /(`+)[\s\S]*?\1|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|“[^”]*”|‘[^’]*’|[^\s,;，；]+|[,;，；]/gu;
const NOMINAL_START = /^(?:the|this|that|these|those|my|our|your|their|its|an?)$/i;
const FILENAME_SUBJECT = /^[\p{L}\p{N}_./\\: -]+\.[A-Za-z0-9]{1,8}$/u;
const FINITE_AUXILIARY = /^(?:is|are|was|were|has|have|had)$/i;
/** 文件引用本身不是操作；带参数的命令、赋值及调用不能落入这个分类。 */
function isFilenameAtom(value, allowQuotedSpaces = false) {
    const token = value.trim().replace(/[.!?]$/u, '');
    const quoted = /^(`+|["'])(.*)\1$/u.exec(token);
    const curved = /^“(.*)”$|^‘(.*)’$/u.exec(token);
    const inner = quoted?.[2] ?? curved?.[1] ?? curved?.[2];
    const atom = inner ?? token;
    // 多词引号内容也可能是完整命令；仅在已有完成谓语的主语位置允许带空格文件名。
    if (/\s/u.test(atom) && !(allowQuotedSpaces && inner !== undefined))
        return false;
    return FILENAME_SUBJECT.test(atom);
}
function isCjkResultOnly(words, clause) {
    // Aspect markers inside quoted code/filenames are data, not result predicates.
    const visible = words.map(word => /^[`"'“‘]/u.test(word) ? ' '.repeat(word.length) : word).join(' ');
    const aspect = /已(?:经)?/u.exec(visible);
    if (!aspect)
        return false;
    const predicate = clause.slice(aspect.index + aspect[0].length)
        .replace(GENERIC_COMPLETION_CJK, '').replace(/[\s\p{P}]/gu, '');
    if (predicate)
        return false;
    // A filename or a generic result noun is not an operation. Keep specific verbs
    // and causes before the result marker (e.g. changing the encoding before finishing).
    const subject = visible.slice(0, aspect.index).replace(GENERIC_COMPLETION_CJK, '')
        .replace(new RegExp(CODE_TARGET.source, 'gi'), '');
    return !HAS_SUBSTANCE.test(subject) && !ACTION.test(subject);
}
function completionPredicates(text) {
    const clauses = [[]];
    for (const token of text.match(CLAUSE_TOKENS) ?? []) {
        if (/^(?:and|but|[,;，；])$/i.test(token))
            clauses.push([]);
        else
            clauses[clauses.length - 1].push(token);
    }
    return clauses.map(words => {
        const clause = words.join(' ');
        if (isCjkResultOnly(words, clause))
            return '';
        const subject = words[0] ?? '';
        const filenameSubject = isFilenameAtom(subject, true);
        if (!NOMINAL_START.test(subject) && !filenameSubject)
            return clause;
        const auxiliary = words.findIndex(word => FINITE_AUXILIARY.test(word));
        // A simple active completion has no auxiliary; retain its verb in the predicate.
        const predicateStart = auxiliary >= 0 ? auxiliary + 1
            : words.findIndex(word => filenameSubject
                ? /^(?:complete[ds]?|fixed|resolved|passed|verified)[.!?]?$/i.test(word)
                : /^complete[ds]?[.!?]?$/i.test(word));
        if (predicateStart < 0)
            return clause;
        const predicate = words.slice(predicateStart).join(' ');
        // Remove a result's subject, never an informative cause or an operative predicate.
        // Perfect active/passive clauses share their finite auxiliary boundary.
        return COMPLETION.test(predicate) ? predicate : clause;
    }).join(' ');
}
function hasActionableContent(text) {
    if (text.trim().length < 4 || /^[a-z]+[.!?]?$/i.test(text.trim()) || isFilenameAtom(text))
        return false;
    const completion = COMPLETION.test(text);
    const actionText = completion || text.includes('已') ? completionPredicates(text) : text;
    const withoutCompletion = actionText.replace(GENERIC_COMPLETION_WORDS, '').replace(GENERIC_COMPLETION_CJK, '').replace(/[\s\d.,!?;:，。！？；：、-]/gu, '');
    if (withoutCompletion.length === 0)
        return false;
    if (NARRATION_OPENER.test(text) && !CAUSE_OR_FIX.test(text))
        return false;
    const action = HAS_SUBSTANCE.test(actionText) || ACTION.test(actionText);
    if (completion && !action)
        return false;
    return action || CODE_TARGET.test(actionText);
}
function hasTruncatedSnapshotText(turn) {
    if (!turn.metadata || typeof turn.metadata !== 'object')
        return false;
    const snapshot = turn.metadata['evolverMaterialSnapshot'];
    return !!snapshot && typeof snapshot === 'object' && snapshot['textTruncated'] === true;
}
/** 最多六个完整且已脱敏的操作单元。拒绝信息只含位置/原因/计数，不保存秘密原文。 */
export function draftStrategyWithEvidence(turns, toolWorkflowsOnly = false) {
    const selected = [];
    const seen = new Set();
    const diagnostics = {
        status: 'insufficient', reason: 'no_actionable_units', evidence: [], rejected: [],
        omitted: { nonActionable: 0, duplicate: 0, overBudget: 0, incomplete: 0, sourceTruncated: 0, capacity: 0 },
    };
    for (const [turnIndex, turn] of turns.entries()) {
        if (turn.isMeta || (toolWorkflowsOnly ? turn.role !== 'tool' : turn.role !== 'assistant'))
            continue;
        const fields = toolWorkflowsOnly ? ['text', 'toolResult'] : ['text'];
        for (const field of fields) {
            const raw = turn[field] ?? '';
            for (const unit of textUnits(raw)) {
                const source = { turnIndex, field, start: unit.start, end: unit.end };
                const original = raw.slice(unit.start, unit.end);
                if (field === 'text' && hasTruncatedSnapshotText(turn) && unit.end === raw.trimEnd().length && original.length > 0) {
                    diagnostics.omitted.sourceTruncated++;
                    diagnostics.rejected.push({ ...source, reason: 'source_truncated' });
                    if (diagnostics.rejected.length > MAX_STRATEGY_STEPS)
                        diagnostics.rejected.shift();
                    continue;
                }
                if (!hasActionableContent(original) || (toolWorkflowsOnly && !REUSABLE_WORKFLOW.test(original))) {
                    diagnostics.omitted.nonActionable++;
                    continue;
                }
                const text = hub.redactString(original);
                if (!unit.complete || original.length > MAX_STEP_CHARS || text.length > MAX_STEP_CHARS) {
                    const reason = unit.complete ? 'unit_too_long' : 'incomplete_unit';
                    if (unit.complete)
                        diagnostics.omitted.overBudget++;
                    else
                        diagnostics.omitted.incomplete++;
                    diagnostics.rejected.push({ ...source, reason });
                    if (diagnostics.rejected.length > MAX_STRATEGY_STEPS)
                        diagnostics.rejected.shift();
                    continue;
                }
                if (!hasActionableContent(text)) {
                    diagnostics.omitted.nonActionable++;
                    continue;
                }
                const key = text.replace(/\r\n/g, '\n');
                if (seen.has(key)) {
                    diagnostics.omitted.duplicate++;
                    continue;
                }
                seen.add(key);
                selected.push({ text, source });
                if (selected.length > MAX_STRATEGY_STEPS) {
                    selected.shift();
                    diagnostics.omitted.capacity++;
                }
            }
        }
    }
    diagnostics.evidence = selected.map((step) => step.source);
    if (selected.length > 0) {
        diagnostics.status = 'ready';
        diagnostics.reason = 'complete_units';
    }
    else if (diagnostics.omitted.sourceTruncated > 0)
        diagnostics.reason = 'source_truncated';
    else if (diagnostics.omitted.incomplete > 0)
        diagnostics.reason = 'incomplete_unit';
    else if (diagnostics.omitted.overBudget > 0)
        diagnostics.reason = 'unit_too_long';
    return { strategy: selected.map((step) => step.text), diagnostics };
}
/** 兼容旧调用方；实际入口使用带位置和不足原因的同一实现。 */
export function draftStrategy(turns) {
    return draftStrategyWithEvidence(turns).strategy;
}
const GENERIC_SUCCESS_TOPICS = new Set([
    'added', 'adjusted', 'assistant', 'change', 'changed', 'changes', 'command', 'commands', 'complete',
    'completed', 'coverage', 'fixed', 'handling', 'implementation', 'passed', 'passing', 'regression', 'result',
    'results', 'successful', 'successfully', 'tests', 'updated', 'validation', 'verified',
]);
function successTopicSignals(strategy) {
    const text = strategy.join(' ');
    return hub.extractTopicKeywords(text, undefined, 24, { minOccurrences: 1, preserveSourceOrder: true })
        .filter((topic) => !GENERIC_SUCCESS_TOPICS.has(topic))
        .slice(0, 4);
}
/**
 * Assemble an UNPROVEN draft GeneCandidate from a parsed session, or null when too thin to distill (no strong
 * signal OR no substantive step). The single source of the "what makes a draftable session" gate + candidate
 * shape, shared by `evolver ingest --distill` and the distillObserver so the two never drift. `sigs` is passed in
 * (already extracted by the caller) to avoid a second extraction pass.
 */
export function draftGeneCandidate(turns, sigs, agent) {
    return assessGeneDraft(turns, sigs, agent).candidate;
}
/** 共享 caller 的实际入口；diagnostics 不进入 Gene 内容或 asset_id。 */
export function assessGeneDraft(turns, sigs, agent) {
    const signals_match = signalTokens(sigs);
    let drafted = draftStrategyWithEvidence(turns);
    const strategy = drafted.strategy;
    const finish = (candidate, reason) => ({
        candidate,
        diagnostics: {
            ...drafted.diagnostics,
            ...(!candidate ? { status: 'insufficient', reason: reason ?? drafted.diagnostics.reason } : {}),
        },
    });
    const hadVerifiedSuccess = sigs.some((s) => s.strength === 'success' && !s.needsAnalysis);
    const hasTerminalVerifiedSuccess = signals_match.includes('verified-success');
    // 当只有成功信号（没有错误信号）时，走 innovate 路径而非 repair (#578):
    // 一次成功的问题解决过程不应被分类为 repair —— 它是一个可复用的成功能力。
    const hasStrongError = sigs.some((s) => s.strength === 'strong');
    if (signals_match.length === 0 || strategy.length === 0 || !hasStrongError) {
        // Do not let the capability sniffer resurrect a success that a later unresolved outcome already superseded.
        if (hadVerifiedSuccess && !hasTerminalVerifiedSuccess && !hasStrongError)
            return finish(null, 'no_eligible_signal');
        const hit = algo.sniffConversationCapabilities(turns)[0];
        if (!hit) {
            // Sniffer 也未命中：如果有 success 信号和 strategy（仅当 hasStrongError 为 false 才走到这里且 signals_match 非空），
            // 仍然产出 gene，但标记为 innovate —— 这是一个被验证的能力，而非错误修复。
            if (signals_match.length > 0 && strategy.length > 0) {
                const topics = successTopicSignals(strategy);
                // Generic runner + success tokens are not a reusable capability identity. Let the optional transcript-LLM
                // path handle prose that has no safe discriminating topic instead of storing one global shell-success gene.
                if (topics.length === 0)
                    return finish(null, 'no_discriminating_topic');
                const successSignals = [...new Set([...signals_match, ...topics])].slice(0, 8);
                return finish({
                    category: 'innovate',
                    signals_match: successSignals,
                    strategy,
                    summary: `Auto-drafted from ${agent} session (UNPROVEN — curate via review): ${topics.slice(0, 3).join(', ')}`,
                    generation_meta: { source: 'distilled' },
                });
            }
            return finish(null, strategy.length > 0 ? 'no_eligible_signal' : undefined);
        }
        // sniffer 仍负责资格/信号，不使用它按前缀裁剪的 evidence 作为策略。
        // 仅在没有助手操作且已命中真实 workflow 时保留旧的 tool-only 回退。
        if (strategy.length === 0) {
            const fallback = draftStrategyWithEvidence(turns, true);
            if (fallback.strategy.length > 0 || fallback.diagnostics.rejected.length > 0) {
                for (const key of Object.keys(drafted.diagnostics.omitted)) {
                    fallback.diagnostics.omitted[key] += drafted.diagnostics.omitted[key];
                }
                fallback.diagnostics.rejected = [...drafted.diagnostics.rejected, ...fallback.diagnostics.rejected].slice(-MAX_STRATEGY_STEPS);
                drafted = fallback;
            }
        }
        if (drafted.strategy.length === 0)
            return finish(null);
        return finish({
            category: 'innovate',
            signals_match: hit.signals,
            strategy: drafted.strategy,
            summary: `Auto-drafted verified capability from ${agent} session (UNPROVEN — curate via review): ${hit.summary}`,
            preconditions: [
                'A live agent conversation explicitly described a reusable capability.',
                'The same conversation included validation or successful tool evidence.',
            ],
            validation: ['node --version'],
            generation_meta: { source: 'distilled' },
        });
    }
    return finish({
        category: 'repair',
        signals_match,
        strategy,
        summary: `Auto-drafted from ${agent} session (UNPROVEN — curate via review): ${signals_match.slice(0, 3).join(', ')}`,
        // A session-distilled gene has execution evidence (the session's turns) but no verified fail→pass-with-blast
        // trajectory → `distilled` per V1 #302 classifyProvenance. Tagged so future governance/selection can grade it
        // apart from evolved (solve→fail→mutate→pass) and manual (human-taught) genes.
        generation_meta: { source: 'distilled' },
    });
}
// Signals injected by the fallback itself, plus generic command runners, carry no domain identity. Including them
// in Jaccard makes unrelated capabilities (for example GitHub vs Playwright) look 60% identical even though their
// one discriminating signal differs. Keep them for exact-subset detection, but omit them from soft similarity.
const GENERIC_NOVELTY_SIGNALS = new Set([
    'reusable_capability',
    'verified_workflow',
    'shell_command',
    'bash',
    'powershell',
    'pwsh',
    'sh',
    'cmd',
    'command',
    'verified-success',
    'verified_success',
]);
function normalizeSignalSet(values) {
    return new Set((values ?? []).map((value) => String(value).trim().toLowerCase()).filter(Boolean));
}
function noveltySignalSet(signals) {
    const discriminating = [...signals].filter((signal) => !GENERIC_NOVELTY_SIGNALS.has(signal));
    return discriminating.length > 0 ? new Set(discriminating) : signals;
}
/**
 * Value/novelty gate run BEFORE a draft is quarantined (#117 improvement 3). `intakeGene` already rejects
 * empty/structurally-invalid candidates and EXACT signal subsets (fullyOverlaps). Admission mirrors that subset
 * check so a duplicate is a per-candidate skip instead of aborting a whole batch, then adds the two missing noise
 * controls: a substance floor and a SOFT near-duplicate comparison. Unattended auto-distill turns that trickle
 * into a flood, and a review gate nobody reads is no gate. Pure and deterministic; the caller decides what to do
 * with a non-admit (skip, never an error).
 */
export function assessDraftAdmission(candidate, existing = [], opts = {}) {
    const minSignals = opts.minSignals ?? 2;
    const minStrategy = opts.minStrategy ?? 1;
    const maxSimilarity = opts.maxSimilarity ?? 0.6;
    const sigs = [...normalizeSignalSet(candidate.signals_match)];
    const strategy = (candidate.strategy ?? []).filter((s) => String(s).trim());
    if (sigs.length < minSignals)
        return { admit: false, reason: `too few signals (${sigs.length} < ${minSignals})` };
    if (strategy.length < minStrategy)
        return { admit: false, reason: `strategy too thin (${strategy.length} < ${minStrategy} steps)` };
    const newSet = new Set(sigs);
    for (const eg of existing) {
        const egSet = normalizeSignalSet(eg.signals_match);
        if (egSet.size === 0)
            continue;
        if ([...newSet].every((signal) => egSet.has(signal))) {
            return { admit: false, reason: `near-duplicate of ${eg.id ?? '?'} (candidate signal subset)` };
        }
        const comparableNew = noveltySignalSet(newSet);
        const comparableExisting = noveltySignalSet(egSet);
        const inter = [...comparableNew].filter((s) => comparableExisting.has(s)).length;
        const union = new Set([...comparableNew, ...comparableExisting]).size;
        const jaccard = union ? inter / union : 0;
        if (jaccard >= maxSimilarity)
            return { admit: false, reason: `near-duplicate of ${eg.id ?? '?'} (similarity ${jaccard.toFixed(2)})` };
    }
    return { admit: true };
}