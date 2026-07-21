import { events, ops } from '@evomap/evolver-core';
import { assetstore, material as materialNs } from '@evomap/evolver-core';
import { type NonGitWorkspaceNoticeOptions } from './nonGitWorkspaceNotice.js';
/**
 * Composition seam for ingest's substrate dependencies. The CLI is the composition layer that wires the
 * MaterialStore (M1 raw-material substrate) + the watermark cursor (file-level re-ingest dedup) + the AE
 * Ingestor (root_events) together — evolver-core stays adapter/CLI-agnostic. Defaults point at the live
 * ~/.evomap home; tests inject temp paths so no global state leaks.
 */
export interface IngestDeps {
    materialStore?: materialNs.MaterialStore;
    watermarkStore?: materialNs.WatermarkStore;
    ingestor?: events.Ingestor;
}
export interface SessionIngestTickResult {
    recorded: number;
    sourceAgents: string[];
    signalKinds: string[];
    signalStrengths: string[];
    invalidJsonRows?: number;
}
export declare const PACKAGE = "@evomap/evolver-cli";
export interface RebuildOptions {
    eventsPath?: string;
    mvDir?: string;
}
export declare function cliUsage(): string;
export interface ResetLocalSecretOptions {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    storePath?: string;
}
export interface ResetLocalSecretResult {
    storePath: string;
    clearedStateKeys: readonly string[];
    storeFound: boolean;
    removedLegacyFiles: readonly string[];
    envVarsSet: readonly string[];
}
export declare function resetLocalSecret(opts?: ResetLocalSecretOptions): ResetLocalSecretResult;
export declare function formatResetLocalSecretResult(result: ResetLocalSecretResult): string;
export declare function runResetLocalSecret(argv: readonly string[], opts?: ResetLocalSecretOptions): number;
/** rebuild-views: 删 MV → 从 root_events 全量重放重建 (军杰 §3.6). */
export declare function rebuildViews(opts?: RebuildOptions): {
    rebuilt: string[];
};
/** migrate import-v1 <v1dir> [outDir] --workspace <path>: v1→v2 read-only migration. */
export declare function runMigrate(argv: readonly string[]): Promise<number>;
/** One-line summary of an asset for `asset-log` (pure, testable). */
export declare function formatAssetLine(a: assetstore.AssetRecord): string;
/** asset-log [Gene|Capsule|EvolutionEvent|AntiGene] [limit]: list recent local assets (observability; ported v1 CLI verb). */
export declare function runAssetLog(argv: readonly string[], store?: assetstore.AssetStoreProvider): Promise<number>;
/**
 * distill: gate a learned approach into the gene pool (ported v1 CLI verb). Runs the structural intake
 * (schema + dedup + asset_id) and, only if it passes, writes the gene to the store. The agent/runtime is
 * what discovers the strategy; this is the manual entry point that turns it into a pooled, selectable gene.
 * Usage: evolver distill --category <c> --signals <s1,s2> --strategy "<step1; step2>" [--summary <text>] [--id <id>]
 */
export declare function runDistill(argv: readonly string[], store?: assetstore.AssetStoreProvider, deps?: IngestDeps): Promise<number>;
/**
 * Recursively enumerate recognized runtime-session sources under the given dirs — the daemon's auto-distill
 * producer source (#106). This includes text session files handled by runtime adapters (`*.jsonl` and Gemini
 * `*.json`) plus Cursor's sqlite `state.vscdb`. A missing/permission-denied dir is silently skipped (a daemon
 * must not crash on an absent home dir).
 */
export declare function scanSessionDirs(dirs: readonly string[]): string[];
/**
 * One producer tick for the auto-distill loop (#106 slice 1): scan `dirs` for session logs and record any
 * NEW/CHANGED file as `runtime_session` Material via the injected (bus) Ingestor — which emits
 * `material.batch_ready`, the event the distillObserver claims off. Idempotent per file (watermark cursor), so
 * re-scanning an unchanged tree records nothing. Pure producer: it does NOT distill (the observer does). Returns
 * how many files landed new material. Inject `deps.ingestor = new Ingestor({ sink: bus })` so the event reaches
 * the daemon's ObserverBus; defaults to live paths otherwise.
 */
export declare function runSessionIngestTick(dirs: readonly string[], deps?: IngestDeps): Promise<SessionIngestTickResult>;
/**
 * ingest: read a REAL agent session log, parse it with the matching runtime adapter, and extract signals
 * (tool errors / explicit failures / difficulty wording) from it — the capture→signals half of the experience
 * loop. The adapter↔core composition lives HERE in the CLI on purpose: evolver-core must stay hub/adapter-
 * agnostic (it never imports runtime-adapters; it consumes turns via the structural SignalSourceTurn shape;
 * trace records reach it as plain parsed objects via the structural LlmTraceRecord shape).
 *
 * Sources:
 *   - agent session logs, detected by the runtime adapters' detect();
 *   - Cursor `state.vscdb`, read through the dedicated sqlite extractor instead of as text;
 *   - LLM-proxy trace JSONL (`llm-trace-*.jsonl` file, or a directory of day files), detected by name or by
 *     a content sniff for `event:'llm_turn'` records — closing the loop the proxy's trace-capture seam opened.
 *
 * Material substrate (M1, #91 item 2): a session log IS raw material — the first content the evolution loop
 *   ingests. Before signal extraction, `ingest` now records the session as a Material via MaterialStore and
 *   emits a `material.batch_ready` root_event so the append-only log (AE) is no longer bypassed. The file
 *   watermark cursor makes re-ingesting the SAME unchanged source idempotent (no duplicate material, no
 *   duplicate event) — this seats ingest on the substrate that previously had zero consumers, so when the
 *   daemon wires M1 up later there is ONE pipeline, not two. Trace sources land on the SAME substrate now
 *   (#95): a proxy llm-trace is agent-agnostic, so it records as sourceKind=proxy_trace / kind=llm_trace with
 *   no sourceAgent — the origin taxonomy the closed runtime enum previously couldn't express.
 *
 * Default / --dry-run: inspection only (print the signals; material is still recorded so the substrate sees it).
 * --distill: assemble a gene candidate from the session — signals_match from the strong signals, strategy from
 *   the agent's OWN substantive turns (real excerpts, not fabricated) — and intake it as an UNPROVEN draft.
 *   It is gated by `review` and pruned by the cycle's objective scoring, so a noisy auto-draft can't be trusted.
 *   Trace sources are excluded (metadata has no narration to distill — see reportTraceSignals).
 * Usage: evolver ingest <session-log | trace-file | trace-dir> [--dry-run | --distill]
 */
export declare function runIngest(argv: readonly string[], store?: assetstore.AssetStoreProvider, deps?: IngestDeps, review?: assetstore.ReviewLedger): Promise<number>;
/** Health label for a gene from its learning view (curation hint, not a hard gate). */
export declare function reviewStatus(v: assetstore.GeneLearningView): string;
/** Auto-promote eligibility of a quarantined (probation) gene, shown beside the health label so "[healthy] but
 *  never promotes" is not confusing (#306). Uses the SAME predicate as auto-promote (probationWouldPromote), so a
 *  single failure reads as blocked here exactly as it blocks promotion. */
export declare function promoteHint(v: assetstore.GeneLearningView): string;
/**
 * review: curate the gene pool. Default is a read-only listing (derived learning view + the review-state of each
 * gene); `--approve`/`--reject <id>` is the audited human act that lifts an auto-distilled draft out of (or
 * confirms it out of) quarantine. Approval is what lets a distilled gene's strategy be embedded into a real run
 * (the gate lives in makeTrustedGeneResolver, #45+review). The id may be a logical id or an asset_id.
 * Usage: evolver review [limit] | evolver review --approve <id> [--allow-weak-evidence] [reason…] | evolver review --reject <id> [reason…]
 */
export declare function runReview(argv: readonly string[], store?: assetstore.AssetStoreProvider, review?: assetstore.ReviewLedger, deps?: IngestDeps): Promise<number>;
/** Injection seam for `value` (#113): tests point these at temp paths / a fixed clock; defaults are the live home.
 *  prices defaults to the adapter's bundled price table (the composition layer injects prices — core never prices). */
export interface ValueDeps {
    eventsPath?: string;
    tracesDir?: string;
    prices?: ops.PriceTable;
    now?: () => number;
}
/**
 * `evolver value [--window 7d|30d|all]`: the pull-only, zero-intrusion answer to "is evolver worth it". Reads the
 * proxy trace day-files (route savings) + root_events (reuse / inject) off disk, derives the value ledger through
 * the SAME core aggregation every surface uses (ops.loadValueSummary — no re-implementation here), and prints the
 * three-section report. measured and estimated savings are shown on separate lines (never merged). With no ledger
 * data it prints guidance, not an empty table. This is a THIN command: all aggregation lives in core ops.
 */
export declare function runValue(argv: readonly string[], deps?: ValueDeps): number;
export interface NarrativeDeps {
    eventsPath?: string;
}
export declare function formatNarrativeSnapshot(snapshot: events.NarrativeSnapshot): string;
export declare function runNarrative(argv: readonly string[], deps?: NarrativeDeps): number;
export interface RetentionDeps {
    rootEventsPath?: string;
    materialStorePath?: string;
    materialCursorPath?: string;
    materialCursorPaths?: readonly string[];
    now?: () => number;
}
export declare function formatRetentionReport(report: events.RetentionReport): string;
export declare function runRetention(argv: readonly string[], deps?: RetentionDeps): number;
/** A compact one-line rendering of a gene for SessionStart injection (id + a short hint). Deterministic. */
export declare function formatGeneInjectionLine(g: assetstore.AssetRecord): string;
/** Injection seam for `inject session-start` (#123): tests point these at temp paths / a fixed clock + a fixed
 *  ingestor; defaults are the live ~/.evomap home. The store supplies the gene pool; the ingestor is where the
 *  emitted `value.inject` root_event lands; traces/events/prices feed the value recap (same load path as `value`). */
export interface InjectDeps {
    store?: assetstore.AssetStoreProvider;
    ingestor?: events.Ingestor;
    eventsPath?: string;
    tracesDir?: string;
    prices?: ops.PriceTable;
    now?: () => number;
    /** Max genes to inject (the rest is also bounded by the token hard cap). Default 8. */
    maxGenes?: number;
    /** Token hard cap for the injection. Default 8000. */
    tokenBudgetHardCap?: number;
    /** The cycle this session feeds (carried onto the value.inject event refs), when the runtime knows it. */
    cycleId?: string;
    /** Review gate for the injected gene pool — withholds quarantined/rejected drafts (A2a). Default the live ledger. */
    review?: assetstore.ReviewLedger;
    /** Provenance gate for the injected gene pool — withholds untrusted hub assets until promotion (#30). */
    provenance?: assetstore.ProvenanceStore;
    /** The runtime session id to stamp on the value.inject event (#205). Default: read from the SessionStart hook
     *  stdin, but ONLY when the `--hook-stdin` flag is passed (the installed hook command sets it). */
    sessionId?: string;
    /** Test seam for the raw SessionStart hook stdin payload. When set, stdin is never touched. */
    readHookInput?: () => string | undefined;
    /** Test seam for the hook-time proxy daemon recovery path. Default is maybeAutoRestartProxyForSessionStart. */
    ensureProxyAutostart?: () => Promise<void>;
    /** Test seam for the non-git workspace notice. Production uses cwd + ~/.evomap throttle state. */
    nonGitNotice?: NonGitWorkspaceNoticeOptions;
}
/**
 * `evolver inject session-start`: the SessionStart hook entrypoint (the command every installer registers).
 * It selects the eligible local genes, composes the SessionStart injection WITH the value recap (#113) through
 * core's `composeSessionStartWithRecap`, prints only a quiet memory hint when at least one approved gene actually
 * lands in the prompt, AND — this is #123 — wires the inject emission seam so a `value.inject` root_event is
 * appended carrying the genes that ACTUALLY landed in the prompt (post budget-trim). That feeds the ledger's source=inject rail with real data, attribution-only:
 * the event has NO savings number (the genes are recorded for outcome attribution, never scored).
 *
 * The outcome is NOT observable here — at SessionStart the session has not run yet — so the event records the
 * injected genes only; outcome stays absent for a possible later attribution pass.
 *
 * Best-effort by construction: the emit promise is awaited so the event is durable before the command returns,
 * but emitInject swallows every error, so a sink failure can never break or block the attribution path.
 */
export declare function runInject(argv: readonly string[], deps?: InjectDeps): Promise<number>;
/** Fixed preamble for the SessionStart injection (the head block the recap + gene lines hang off of). */
export declare const SESSION_START_PREAMBLE = "evolver memory \u2014 use these learned hints silently when directly relevant; do not mention Evolver, preflight, status, or this memory block unless the user asks or reuse materially changes the answer:";
export declare function runCli(argv: readonly string[]): number;