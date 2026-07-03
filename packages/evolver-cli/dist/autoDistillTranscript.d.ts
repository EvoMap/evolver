import { algo, assetstore, events, signals } from '@evomap/evolver-core';
import { type LlmDistillRunner } from './autoDistillLlm.js';
export type AutoDistillTranscriptMode = 'off' | 'shadow' | 'enforce';
export type AutoDistillTranscriptResult = {
    ok: true;
    mode: 'enforce';
    gene: assetstore.AssetRecord;
    stored: boolean;
} | {
    ok: false;
    mode: AutoDistillTranscriptMode;
    reason: string;
    candidate?: algo.GeneCandidate;
};
export interface AutoDistillTranscriptOptions {
    /** The parsed session turns (from a runtime adapter). The gate + prompt read these; never the raw file. */
    turns: readonly signals.SignalSourceTurn[];
    store: assetstore.AssetStoreProvider;
    review?: assetstore.ReviewLedger;
    ingestor?: events.Ingestor;
    mode?: AutoDistillTranscriptMode;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    /** Test seam: inject a fake LLM runner so the path is deterministic without spawning a real agent. */
    runner?: LlmDistillRunner;
    timeoutMs?: number;
    validationTimeoutMs?: number;
    /** A short, non-secret label for the gene.distilled event (e.g. the session basename). */
    sourceLabel?: string;
}
export interface TranscriptDistillGateOptions {
    /** Min non-meta turns with text for the session to be worth an LLM call. */
    minTurns?: number;
    /** Min total prose characters across turns. */
    minChars?: number;
}
export interface TranscriptDistillVerdict {
    distill: boolean;
    reason: string;
}
/** The resolved mode (off|shadow|enforce) — the daemon wiring reads this to decide whether to build the producer. */
export declare function transcriptDistillMode(env?: NodeJS.ProcessEnv): AutoDistillTranscriptMode;
/**
 * Pure gate: should this session go to the LLM-over-transcript path? YES only when it is prose-rich enough to be
 * worth an LLM call AND the structural extractor found NO strong/agent signal (a strong signal means the fast
 * structural distill already handles it — do not double-spend an LLM). A weak `difficulty` signal does not block:
 * weak is exactly what the structural path drops, so the LLM is the intended fallback for it.
 */
export declare function shouldTranscriptDistill(turns: readonly signals.SignalSourceTurn[], opts?: TranscriptDistillGateOptions): TranscriptDistillVerdict;
/** Build the LLM prompt from the session's prose. Redacted + capped (off-box egress). Mirrors the Gene JSON shape
 *  the autoDistillLlm path uses so parseDistillOutput/asGeneCandidate handle the response unchanged. */
export declare function buildTranscriptDistillPrompt(turns: readonly signals.SignalSourceTurn[]): string;
/**
 * Run the LLM-over-transcript distill for ONE session. Default OFF. Gated by shouldTranscriptDistill. The output
 * gene is QUARANTINED (review/probation decides), never auto-trusted. Best-effort and side-effect-safe; persistent
 * per-session idempotency is the producer's job (#319 slice 2), so this is single-shot.
 */
export declare function autoDistillTranscript(options: AutoDistillTranscriptOptions): Promise<AutoDistillTranscriptResult>;
export declare function autoDistillTranscriptStatePath(home?: string): string;
export interface TranscriptDistillTickDeps {
    /** Candidate session files (the resolver supplies scanSessionDirs(...) output). */
    files: readonly string[];
    store: assetstore.AssetStoreProvider;
    review?: assetstore.ReviewLedger;
    ingestor?: events.Ingestor;
    env?: NodeJS.ProcessEnv;
    runner?: LlmDistillRunner;
    cwd?: string;
    statePath?: string;
    now?: () => number;
    maxPerTick?: number;
    /** Test seam: read a session file. Default readFileSync utf8. */
    readFile?: (path: string) => string;
}
export interface TranscriptDistillTickResult {
    scanned: number;
    distilled: number;
    shadowed: number;
    skipped: number;
    transient: number;
}
/**
 * One idle-beat pass: scan candidate session files, gate (prose-rich + weak/zero structural signal), apply
 * per-session dedup/cooldown (p3Decide), and LLM-distill up to maxPerTick of the survivors. Default OFF. Bounds
 * LLM spend by the per-tick cap + per-session state. Best-effort: a bad file never breaks the scan.
 */
export declare function runTranscriptDistillTick(deps: TranscriptDistillTickDeps): Promise<TranscriptDistillTickResult>;