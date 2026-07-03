import { extractSignals } from '../signals/extractor.js';
import { buildValueRecap } from '../ops/index.js';
/**
 * 构造 SessionStart 注入. token 预算钉在 hard cap, 注入内容超额则截断 gene 列表(预算优先).
 * Priority order (#113): preamble + recap are kept; only the GENE list is trimmed from its tail to fit the cap.
 * The recap is a fixed quiet-context line, so it sits above every gene in priority — a tight budget drops genes,
 * never the recap. The recap is assembled with the preamble (both retained as one head block).
 */
export function buildSessionStartInjection(cfg, estimateTokens = (s) => Math.ceil(s.length / 4)) {
    const genes = [...(cfg.injectGenes ?? [])];
    const recap = (cfg.recap ?? '').trim();
    // The head block (preamble + recap) is never trimmed — only the gene tail is.
    const head = [cfg.preamble ?? '', recap].filter(Boolean);
    const compose = () => [...head, ...genes].filter(Boolean).join('\n');
    let prompt = compose();
    // hard cap: 注入超预算就从尾部砍 gene(保 preamble + recap, 预算优先且 recap 优先级高于 gene 尾部)
    while (genes.length > 0 && estimateTokens(prompt) > cfg.tokenBudgetHardCap) {
        genes.pop();
        prompt = compose();
    }
    return { systemPrompt: prompt, tokenBudget: cfg.tokenBudgetHardCap, genes, recapIncluded: recap.length > 0 };
}
/**
 * Compose a SessionStart injection WITH a value-outreach recap (#113), end to end. This is the real integration
 * seam: it derives a quiet context line from live run state (N injected genes, M past successes, X measured
 * tokens saved — all from the passed summary + counts, never invented) and threads it through the same hard-cap
 * budget as `buildSessionStartInjection`, where the recap outranks the gene tail. The recap is omitted (no line
 * added) when there is nothing honest to say. Pure given its inputs (+ the injected token estimator).
 *
 * Inject emission (#123): when an `onInject` seam is wired (via the options object form of the third argument),
 * it fires ONCE with the genes that actually survived the budget trim (`inj.genes`) so the value ledger can feed
 * its source=inject rail with REAL data. The emission is best-effort and fire-and-forget: a thrown error from the
 * seam is swallowed and never propagates, so an attribution side-effect can never break the agent's injection.
 *
 * The third argument is overloaded for back-compat: a bare function is the token estimator (the original
 * signature); an options object carries the estimator plus the optional inject seam.
 */
export function composeSessionStartWithRecap(base, recapCtx, estimateTokensOrOpts) {
    const opts = typeof estimateTokensOrOpts === 'function' ? { estimateTokens: estimateTokensOrOpts } : (estimateTokensOrOpts ?? {});
    const recap = buildValueRecap({
        injectedCount: recapCtx.injectGenes.length,
        ...(recapCtx.successCount !== undefined ? { successCount: recapCtx.successCount } : {}),
        summary: recapCtx.summary,
    });
    const inj = buildSessionStartInjection({ ...base, injectGenes: recapCtx.injectGenes, recap }, opts.estimateTokens);
    // Inject emission (#123): record the genes that ACTUALLY landed in the prompt (post budget-trim), not the
    // pre-trim candidate list — the ledger should attribute only what the agent really saw. The trim drops from the
    // TAIL, so the survivors are the FIRST inj.genes.length entries; map them to the aligned stable gene ids (when
    // provided) so attribution is by id, not by a rendered line. Fire-and-forget: skip when nothing was injected,
    // and never let a seam error escape into the injection path.
    if (opts.onInject && inj.genes.length > 0) {
        const geneIds = recapCtx.geneIds
            ? recapCtx.geneIds.slice(0, inj.genes.length).filter((id) => typeof id === 'string')
            : inj.genes;
        if (geneIds.length > 0) {
            try {
                opts.onInject({
                    geneIds,
                    ...(opts.cycleId ? { cycleId: opts.cycleId } : {}),
                    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
                });
            }
            catch { /* emission must never break the injection path */ }
        }
    }
    return inj;
}
/** PostToolUse 钩子: 把一次 tool 调用结果转成信号(复用三条腿提取). */
export function signalsFromToolUse(event) {
    const turn = {
        toolName: event.toolName,
        ...(event.isError && event.toolResult ? { errorMessage: event.toolResult } : {}),
        ...(event.text ? { text: event.text } : {}),
        isMeta: false,
    };
    return extractSignals([turn]);
}
/** Stop 钩子: 把本 session 的信号沉淀成一条 memory(批注#6). idle(无信号)也记, 但标 idle. */
export function buildStopMemory(turns, now) {
    const signals = extractSignals(turns);
    return {
        kind: 'session_summary',
        summary: signals.length > 0 ? `${signals.length} 个信号: ${signals.slice(0, 3).map((s) => s.kind).join(', ')}` : '无信号 session',
        signalCount: signals.length,
        signals: signals.slice(0, 20).map((s) => s.text.slice(0, 120)),
        outcome: signals.length > 0 ? 'productive' : 'idle',
        ts: now,
    };
}