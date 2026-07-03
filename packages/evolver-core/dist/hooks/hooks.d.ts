import { type ExtractedSignal, type SignalSourceTurn } from '../signals/extractor.js';
import { type ValueSummary } from '../ops/index.js';
export interface SessionStartConfig {
    tokenBudgetHardCap: number;
    injectGenes?: readonly string[];
    preamble?: string;
    /** Value-outreach recap line (#113): quiet metadata about injected memory/value context. Higher priority than
     *  the gene-list tail — when over budget the gene tail is cut FIRST and the recap is kept, so the agent keeps
     *  the context even in a tight budget. Empty/absent → no recap, no behavior change. */
    recap?: string;
}
export interface SessionStartInjection {
    systemPrompt: string;
    tokenBudget: number;
    genes: string[];
    /** Whether the recap line survived into the prompt (false only if it was absent). */
    recapIncluded: boolean;
}
/**
 * 构造 SessionStart 注入. token 预算钉在 hard cap, 注入内容超额则截断 gene 列表(预算优先).
 * Priority order (#113): preamble + recap are kept; only the GENE list is trimmed from its tail to fit the cap.
 * The recap is a fixed quiet-context line, so it sits above every gene in priority — a tight budget drops genes,
 * never the recap. The recap is assembled with the preamble (both retained as one head block).
 */
export declare function buildSessionStartInjection(cfg: SessionStartConfig, estimateTokens?: (s: string) => number): SessionStartInjection;
/** Inputs the SessionStart recap (#113) needs from real run state: the genes being injected, the past successes
 *  they were learned from, and the value summary for the recap window. */
export interface SessionStartRecapContext {
    /** Genes selected for this session's injection (N) — the rendered lines that go into the prompt. */
    injectGenes: readonly string[];
    /**
     * Stable gene IDs aligned POSITIONALLY with `injectGenes` (line[i] ↔ id[i]), for inject attribution (#123).
     * When present, the inject emission reports these IDs (mapped to the survivors of the budget trim) so the
     * value ledger attributes by a stable id, not a rendered line. When absent, the emission falls back to the
     * surviving line strings. Length should match `injectGenes`; a shorter array contributes no id past its end.
     */
    geneIds?: readonly string[];
    /** Past successes the injected genes were distilled from (M) — e.g. distinct solidified cycles. */
    successCount?: number;
    /** Value summary for the recap window (its measured total is X). */
    summary: ValueSummary;
}
/**
 * What the SessionStart inject emission seam (#123) reports — the value-ledger attribution anchors for a
 * `value.inject` root_event. This is an ATTRIBUTION-ONLY signal (the weakest in the ledger): it records WHICH
 * genes were actually injected (and, when known, the session outcome) and carries NO savings number. The genes
 * reported are the ones that survived the hard-cap budget trim — i.e. the genes the agent really saw, not the
 * pre-trim candidate list.
 */
export interface InjectInfo {
    /** The gene ids actually injected into the prompt (post budget-trim). */
    geneIds: readonly string[];
    /** The cycle this injection feeds, when there is one. */
    cycleId?: string;
    /**
     * The runtime's session id, when the hook delivers it (Claude Code passes it on SessionStart stdin). Recorded so
     * a later attribution pass (recall) can tie THIS inject to the exact session transcript it produced (#205),
     * instead of guessing "the most recent inject". Absent for runtimes that expose no per-session id (e.g. cursor).
     */
    sessionId?: string;
    /**
     * Session outcome, when observable. At SessionStart the session has not run yet, so this is normally absent;
     * the field exists so a later attribution pass can carry it. Never scored into a number (attribution only).
     */
    outcome?: string;
}
/** Options for the recap-composing SessionStart injection (#123): the optional inject emission seam. */
export interface ComposeSessionStartOptions {
    /** Token estimator (defaults to the char/4 heuristic inside buildSessionStartInjection). */
    estimateTokens?: (s: string) => number;
    /**
     * Inject emission seam (#123). Fired exactly once with the genes that ACTUALLY made it into the prompt (after
     * the hard-cap trim) so the value ledger can derive a source=inject record. Core stays sink-agnostic: the
     * composition layer wires this to a `value.inject` root_event. Best-effort + MUST NOT throw — injection is the
     * agent's critical path, so an emission error can never be allowed to break or delay it (fire-and-forget,
     * mirroring the reuse-hit seam). Not fired when nothing was injected (no genes survived the budget).
     */
    onInject?: (info: InjectInfo) => void;
    /** The cycle this injection feeds — carried into onInject so the event refs the SAME cycleId as the cycle. */
    cycleId?: string;
    /** The runtime session id — carried into onInject so the value.inject event can be tied back to its session (#205). */
    sessionId?: string;
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
export declare function composeSessionStartWithRecap(base: Omit<SessionStartConfig, 'recap'>, recapCtx: SessionStartRecapContext, estimateTokensOrOpts?: ((s: string) => number) | ComposeSessionStartOptions): SessionStartInjection;
export interface ToolUseEvent {
    toolName: string;
    toolResult?: string;
    isError?: boolean;
    text?: string;
}
/** PostToolUse 钩子: 把一次 tool 调用结果转成信号(复用三条腿提取). */
export declare function signalsFromToolUse(event: ToolUseEvent): ExtractedSignal[];
export interface StopMemoryEntry {
    kind: 'session_summary';
    summary: string;
    signalCount: number;
    signals: string[];
    outcome: 'productive' | 'idle';
    ts: number;
}
/** Stop 钩子: 把本 session 的信号沉淀成一条 memory(批注#6). idle(无信号)也记, 但标 idle. */
export declare function buildStopMemory(turns: readonly SignalSourceTurn[], now: number): StopMemoryEntry;