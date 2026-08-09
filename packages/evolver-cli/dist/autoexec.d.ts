import { events, assetstore, algo, exec, hooks, material as materialNs, util, verify, hub as hubNs } from '@evomap/evolver-core';
import { type Beat } from './daemonLoop.js';
import { connectPublicHub, ReuseCache } from '@evomap/evolver-adapter-public';
import type { FetchLike, MemoryGraphEventReceipt, MemoryGraphEventReport, OfflinePermitStore, OutcomeReport, OutcomeReceipt } from '@evomap/evolver-adapter-public';
import { type EvolverProxyClient } from '@evomap/evolver-mcp';
import { type MemoryEventMirrorWiring } from './memoryEventMirror.js';
import { resolveDistillObserver } from './distillObserver.js';
import { type AutoDistillLlmResult, type LlmDistillRunner } from './autoDistillLlm.js';
import { type AutoDistillAntiGeneMode, type AutoDistillAntiGeneResult } from './autoDistillAntiGene.js';
import { type AutoDistillTranscriptMode, type TranscriptDistillTickResult } from './autoDistillTranscript.js';
import { type SessionIngestTickResult } from './sessionIngest.js';
import { AtpAutoBuyer, type AtpAutoBuyerClient, type AtpAutoBuyerRequest } from './atpAutoBuyer.js';
import { type ConfiguredSelectionGuard } from './selectionPolicyConfig.js';
export { readAutoExecConfig, type AutoExecConfig } from './autoexecConfig.js';
export { semanticIdfEnabled } from './semanticIdfConfig.js';
export { selectionFloorFromEnv, selectionGuardFromEnv, selectionPolicyFromEnv, type ConfiguredSelectionGuard, } from './selectionPolicyConfig.js';
export declare function withAutoExecSelectionPolicy<T extends object>(deps: T, env?: NodeJS.ProcessEnv): T & {
    selectionPolicy?: exec.AutoExecDeps['selectionPolicy'];
};
export declare function withAutoExecSelectionConfig<T extends object>(deps: T, env?: NodeJS.ProcessEnv): T & {
    selectionPolicy?: exec.AutoExecDeps['selectionPolicy'];
    selectionGuard: ConfiguredSelectionGuard;
    selectionFloor?: number;
};
export interface AutoExecDirs {
    base: string;
    tasks: string;
    inflight: string;
    done: string;
    refused: string;
}
/** Create the queue layout under <home>/autoexec/{tasks,inflight,done,refused}. */
export declare function ensureAutoExecDirs(base: string): AutoExecDirs;
export declare function summarizeSandboxedValidation(result: verify.SandboxedValidationResult): string | null;
/**
 * One queue pass: atomically claim regular tasks/*.json into inflight/, then route each verdict to done/
 * (success or failure) or refused/ (deny-by-default). A claim is atomically marked started before runOne;
 * after a crash, started and legacy claims are ambiguous and fail closed instead of repeating side effects.
 * Unreadable or incomplete claimed tasks stay pending because the drop-directory has no atomic publish marker.
 */
export declare function autoExecPass(dirs: AutoExecDirs, runOne: (task: exec.AutoExecTask) => Promise<exec.AutoExecVerdict>, options?: {
    executePendingTasks?: boolean;
}): Promise<exec.AutoExecVerdict[]>;
/** Keep unsupported built-in runners away from the execution queue without stopping the resident daemon. */
export declare function runnerBoundAutoExecPass(runner: exec.RunnerName, dirs: AutoExecDirs, runOne: (task: exec.AutoExecTask) => Promise<exec.AutoExecVerdict>): () => Promise<exec.AutoExecVerdict[]>;
/**
 * Build the reuse-before-solve seam (#110) — THE real injection point. This is the public-repo composition
 * layer that owns BOTH core's autoexec kernel and the adapter's hub capability, so it is where the adapter's
 * `reuseBeforeSolve` is adapted into core's hub-agnostic `HubReuseSeam` (core never imports the adapter).
 * Flow: free hub search → core's pure score/decide → paid fetch for AT MOST ONE winner → the winner enters the
 * SAME selection pool as local genes (trust-first). The two-layer cache is owned HERE so it warms across passes
 * (a repeat signal set → zero hub calls). Off by default: only wired when EVOLVER_REUSE_BEFORE_SOLVE === '1'
 * AND a hub credential exists (no token → no seam → zero hub calls, exactly today's behavior).
 */
export type VerifiedHubSearchMissReason = 'no_results' | 'below_threshold';
export interface VerifiedHubSearchMiss {
    reason: VerifiedHubSearchMissReason;
    signals: readonly string[];
    cycleId?: string;
}
export type VerifiedHubSearchMissHandler = (miss: VerifiedHubSearchMiss) => void;
/** Minimal audit seam so autoexec tests never have to touch the operator's real asset-call log. */
export interface AssetCallLogger {
    append(entry: hubNs.AssetCallEntry): void;
    assetCostIndex?(): Record<string, number>;
}
interface HubSearchHitAudit {
    runId: string | null;
    assetId?: string;
    assetType?: string;
    sourceNodeId?: string;
    chainId?: string;
    score?: number;
    mode: 'direct' | 'reference';
    signals: readonly string[];
    tokensSaved: number;
    tokensSavedBasis: hubNs.TokensSavedBasis;
}
interface HubReuseAuditOptions {
    assetLog?: AssetCallLogger;
    onSearchHit?: (hit: HubSearchHitAudit) => void;
    env?: NodeJS.ProcessEnv;
}
/** Build the deliberately small, public-safe ATP request allowed to leave autoexec after a verified Hub miss. */
export declare function atpCapabilityGapRequest(signals: readonly string[]): AtpAutoBuyerRequest;
/** Schedule economic work outside the reuse/task critical path and contain all asynchronous failures. */
export declare function scheduleAtpAutoBuyForVerifiedMiss(miss: VerifiedHubSearchMiss, buyer: Pick<AtpAutoBuyer, 'consider'>): void;
/** Resolve an autonomous buyer only after an explicit env/ack consent check; the buyer checks consent again. */
export declare function resolveAtpAutoBuyer(env?: NodeJS.ProcessEnv, createClient?: (resolvedEnv: NodeJS.ProcessEnv) => AtpAutoBuyerClient): AtpAutoBuyer | undefined;
export declare function makeHubReuseSeam(cap: hubNs.HubCapability, cache: ReuseCache, ingestor?: events.Ingestor, onAssetReused?: (assetId: string) => void, onVerifiedSearchMiss?: VerifiedHubSearchMissHandler, audit?: HubReuseAuditOptions): exec.HubReuseSeam;
/**
 * Free search-only seam used by ATP auto-buy when reuse injection is disabled. It proves a capability miss with
 * the same dual-leg search and score threshold as reuse, but never performs the paid fetch or contributes a Hub
 * candidate.
 */
export declare function makeHubSearchMissProbe(cap: hubNs.HubCapability, cache: ReuseCache, onVerifiedSearchMiss: VerifiedHubSearchMissHandler, enabled: () => boolean, env?: NodeJS.ProcessEnv, assetLog?: AssetCallLogger): exec.HubReuseSeam;
/**
 * Append a `value.inject` root_event for a SessionStart gene injection (#123). Attribution-only — the payload
 * carries the injected gene ids (+ cycle/outcome when known) and NO savings number, exactly per the ledger's
 * weakest-signal contract. Never throws: injection is the agent's critical path, so a failed emission is
 * swallowed (the genes are still injected). Skips an empty gene set — there is nothing to attribute.
 */
export declare function emitInject(ingestor: events.Ingestor, info: hooks.InjectInfo): Promise<void>;
/**
 * Build the SessionStart inject emission seam (#123) — the public-repo composition point that connects core's
 * sink-agnostic `onInject` callback to the real `value.inject` root_event sink. Core (composeSessionStartWithRecap)
 * never imports the Ingestor; THIS is where the ingestor is wired in, mirroring makeHubReuseSeam for reuse. The
 * returned callback is synchronous (the seam core calls is sync) and fire-and-forget: it stashes the
 * error-swallowing emit promise so the caller can await durability without ever letting an ingest error surface.
 * Returns undefined when there is no ingestor (no sink → no emission, exactly today's behavior).
 */
export declare function makeInjectEmitter(ingestor?: events.Ingestor): {
    onInject: (info: hooks.InjectInfo) => void;
    flush: () => Promise<void>;
} | undefined;
/** A hub the link can report outcomes to. Structural (not the concrete class) so tests can fake it. */
export type OutcomeReportingHub = hubNs.HubCapability & {
    recordOutcome(report: OutcomeReport): Promise<OutcomeReceipt>;
    recordMemoryEvent?(report: MemoryGraphEventReport): Promise<MemoryGraphEventReceipt>;
    recordReuseResult?(report: hubNs.ReuseResultReport): Promise<hubNs.ReuseResultReceipt>;
};
/** The composed hub wiring: the reuse seam plus the matching outcome reporter that closes the loop. */
export interface HubLink {
    seam: exec.HubReuseSeam;
    /** Report a finished task's outcome (with the used-asset attribution claim) to the hub. Never throws. */
    reportOutcome: (task: exec.AutoExecTask, verdict: exec.AutoExecVerdict) => Promise<void>;
}
export interface HubQuestionLink {
    /** Submit optional proactive questions for a finished task. Never throws. */
    submitForTask: (task: exec.AutoExecTask) => Promise<HubQuestionSubmitResult>;
}
type HubQuestionSubmitStatus = 'disabled' | 'skipped' | 'submitted' | 'not_accepted' | 'timeout' | 'failed';
interface HubQuestionSubmitResult {
    status: HubQuestionSubmitStatus;
    questionCount: number;
}
type DistillTickQuestionSource = ({
    recorded: number;
} & Partial<Pick<SessionIngestTickResult, 'sourceAgents' | 'signalKinds' | 'signalStrengths'>>) | {
    skipped: true;
};
export interface HubQuestionLinkOptions {
    enabled?: boolean;
    statePath?: string;
    env?: Record<string, string | undefined>;
    now?: () => number;
    timeoutMs?: number;
}
type PublicHubConnectOptions = Parameters<typeof connectPublicHub>[0];
type PublicHubConnector = (opts: PublicHubConnectOptions) => {
    hub: OutcomeReportingHub;
};
type PublicHubPermitConnector = (opts: PublicHubConnectOptions) => {
    auth: hubNs.AuthProvider;
};
interface SolidifyPermitResolverOptions {
    fetchFn?: FetchLike;
    now?: () => number;
    store?: OfflinePermitStore;
}
/**
 * Map an autoexec verdict onto the hub outcome vocabulary (success | failed).
 * refused/skipped ran no cycle — there is nothing to attribute, so no report.
 */
export declare function verdictToOutcomeStatus(status: exec.AutoExecVerdict['status']): 'success' | 'failed' | null;
export declare function questionGeneratorStatePath(home?: string): string;
export declare function makeHubQuestionLink(cap: hubNs.HubCapability, options?: HubQuestionLinkOptions): HubQuestionLink;
export declare function shouldSubmitProactiveQuestionsForTask(task: exec.AutoExecTask): boolean;
export declare function autoexecLockFailureMessage(error: unknown): string;
export declare function autoexecLockReleaseFailureMessage(error: unknown): string;
export interface AutoexecLockReleaseDeps {
    releaseLock?: (path: string) => util.ReleaseLockResult | void;
    stderr?: (text: string) => void;
}
export declare function releaseAutoexecLock(lockPath: string, deps?: AutoexecLockReleaseDeps): boolean;
type AutoexecStreamErrorListener = (error: NodeJS.ErrnoException) => void;
export interface AutoexecErrorStream {
    on(event: 'error', listener: AutoexecStreamErrorListener): unknown;
    off?(event: 'error', listener: AutoexecStreamErrorListener): unknown;
    removeListener?(event: 'error', listener: AutoexecStreamErrorListener): unknown;
}
export interface AutoexecBrokenPipeGuardDeps {
    stdout?: AutoexecErrorStream;
    stderr?: AutoexecErrorStream;
}
/** Keep a detached daemon alive when its output consumer closes, without hiding other stream failures. */
export declare function installAutoexecBrokenPipeGuards(deps?: AutoexecBrokenPipeGuardDeps): () => void;
export type AutoexecProcessSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
type AutoexecSignalListener = () => void;
export interface AutoexecSignalSource {
    on(event: AutoexecProcessSignal, listener: AutoexecSignalListener): unknown;
    off?(event: AutoexecProcessSignal, listener: AutoexecSignalListener): unknown;
    removeListener?(event: AutoexecProcessSignal, listener: AutoexecSignalListener): unknown;
}
export interface AutoexecShutdownDeps {
    stop: () => Promise<void>;
    cleanup: () => void;
    signals?: AutoexecSignalSource;
    write?: (message: string) => void;
}
/**
 * Own autoexec's process-signal lifetime. V2 intentionally has no hot-reload seam: SIGHUP is informational and
 * keeps the current generation alive; SIGINT/SIGTERM drain the resident loop before cleanup and exit.
 */
export declare function waitForAutoexecShutdown(deps: AutoexecShutdownDeps): Promise<number>;
export declare function urgentQuestionRuntimeWiringStatus(): typeof hubNs.URGENT_QUESTION_RUNTIME_WIRING_STATUS;
export declare function submitDistillTickExplorationQuestion(questions: HubQuestionLink | undefined, source: DistillTickQuestionSource | undefined): Promise<HubQuestionSubmitResult>;
export declare function scheduleAutoExecHubSideEffects(task: exec.AutoExecTask, verdict: exec.AutoExecVerdict, links: {
    questions?: HubQuestionLink;
    outcome?: HubLink;
}): void;
/**
 * Compose the reuse seam and the outcome reporter. Reuse HITs still emit value-ledger observability, but the
 * Hub outcome `used_asset_ids` claim comes only from the finished verdict's selected/executed asset. A fetched
 * candidate can be withheld by trust/review gates or lose selection, so fetch-time attribution would overclaim.
 * Reporting never throws and never blocks the verdict.
 */
export declare function makeHubLink(cap: OutcomeReportingHub, ingestor?: events.Ingestor, reportEnabled?: boolean, onVerifiedSearchMiss?: VerifiedHubSearchMissHandler, assetLog?: AssetCallLogger, env?: NodeJS.ProcessEnv): HubLink;
/**
 * Resolve public/private reuse wiring. Reuse remains default-off. When a public ATP miss handler is supplied,
 * a consent-gated free search-only seam may still be composed so auto-buy can prove a miss independently of
 * reuse injection; that seam never fetches or injects Hub assets.
 */
export declare function resolveHubLink(env?: NodeJS.ProcessEnv, ingestor?: events.Ingestor, connectHub?: PublicHubConnector, onVerifiedSearchMiss?: VerifiedHubSearchMissHandler, assetLog?: AssetCallLogger): HubLink | undefined;
export declare function resolveHubQuestionLink(env?: NodeJS.ProcessEnv, connectHub?: PublicHubConnector): HubQuestionLink | undefined;
export declare function resolveMemoryEventMirror(env?: NodeJS.ProcessEnv, connectHub?: PublicHubConnector): MemoryEventMirrorWiring;
export declare function offlinePermitDir(env?: NodeJS.ProcessEnv): string;
export declare function makeOfflineSolidifyPermitGate(permits: Pick<OfflinePermitStore, 'consumeOfflinePermit'>): algo.SolidifyPermitGate;
export declare function resolveSolidifyPermitGate(env?: NodeJS.ProcessEnv, connectHub?: PublicHubPermitConnector, opts?: SolidifyPermitResolverOptions): algo.SolidifyPermitGate | undefined;
export declare function makeProxyHubCapability(proxy: Pick<EvolverProxyClient, 'search' | 'fetchAsset' | 'recordReuseResult'>): OutcomeReportingHub;
/** Session-log dirs the auto-distill producer scans: EVOLVER_SESSION_DIRS (comma-sep) overrides; else the
 *  standard agent homes. The scanner skips non-existent dirs, so listing cross-platform homes is always safe. */
export declare function defaultSessionDirs(env?: NodeJS.ProcessEnv): string[];
/**
 * Whether the cross-runtime reuse SIGNAL is folded into selection (#268/#274 soft re-order). **Default ON**: the
 * re-rank is a SMALL, bounded, clamped nudge (±REUSE_WEIGHT) that the controlled A/B (reuseSignalAb.test.ts)
 * proves flips only NEAR-TIES and can never override a gene's health/signal-match — so cross-AI reuse evidence
 * shapes selection by default, not only when an operator opts in. `EVOLVER_REUSE_SIGNAL=0` is the kill switch.
 */
export declare function reuseSignalEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * Whether the gene PROBATION loop is on (#306, phase 2). **Default OFF** — explicit opt-in (EVOLVER_GENE_PROBATION=1),
 * because it lets unproven auto-distilled genes be TRIED with their strategy embedded so the cross-AI reuse loop
 * self-closes (autoexec then also runs the evidence-based auto-promote tick). Unlike the bounded reuse soft re-order,
 * this drives the autonomous agent with an unreviewed strategy — contained by the proven exec hard gates + worktree
 * isolation (#309), but a real increase in what the loop attempts, so it stays opt-in until validated in production.
 */
export declare function geneProbationEnabled(env?: NodeJS.ProcessEnv): boolean;
export interface DistillProducerOptions {
    /** The daemon's bus Ingestor — REQUIRED, so the producer's `material.batch_ready` reaches the same ObserverBus
     *  the distillObserver is registered on. */
    ingestor: events.Ingestor;
    store?: assetstore.AssetStoreProvider;
    review?: assetstore.ReviewLedger;
    materialStore?: materialNs.MaterialStore;
    watermarkStore?: materialNs.WatermarkStore;
    consumer?: materialNs.ConsumerGroups;
    sessionDirs?: readonly string[];
    maxPerTick?: number;
}
export interface DistillProducerWiring {
    enabled: boolean;
    reason?: 'off';
    observer: ReturnType<typeof resolveDistillObserver> | null;
    /** One producer pass: scan the session dirs → record material on the bus Ingestor (emits material.batch_ready). */
    tick: () => Promise<SessionIngestTickResult>;
    sessionDirs: readonly string[];
}
/**
 * Wire the auto-distill producer+consumer for the resident daemon (#106 slice2): returns the distillObserver to
 * register on the bus + a `tick()` that scans the session dirs and records material onto the SAME bus Ingestor
 * (→ `material.batch_ready` → the observer auto-drafts a quarantined gene). Off via `EVOLVER_AUTO_DISTILL=0`.
 * All stores/paths are injectable for tests; production defaults to the live ~/.evomap substrate + agent homes.
 */
export declare function resolveDistillProducer(env: NodeJS.ProcessEnv, opts: DistillProducerOptions): DistillProducerWiring;
type LlmDistillTickResult = AutoDistillLlmResult | {
    skipped: true;
} | undefined;
type GuardedLlmDistill = () => Promise<LlmDistillTickResult>;
type AntiGeneDistillTickResult = AutoDistillAntiGeneResult | {
    skipped: true;
} | undefined;
type GuardedAntiGeneDistill = () => Promise<AntiGeneDistillTickResult>;
export declare function shouldRunIdleDistill(intensity: Beat['intensity']): boolean;
export declare function runIdleLlmDistillForBeat(beat: Pick<Beat, 'intensity'>, guardedLlmDistill: GuardedLlmDistill | null, write?: (message: string) => void): Promise<void>;
export declare function runIdleAntiGeneDistillForBeat(beat: Pick<Beat, 'intensity'>, guardedAntiGeneDistill: GuardedAntiGeneDistill | null, write?: (message: string) => void): Promise<void>;
type GuardedTranscriptDistill = () => Promise<TranscriptDistillTickResult | {
    skipped: true;
} | undefined>;
interface AutoDistillTranscriptWiring {
    enabled: boolean;
    mode: AutoDistillTranscriptMode;
    tick: () => Promise<TranscriptDistillTickResult>;
}
interface AutoDistillAntiGeneWiring {
    enabled: boolean;
    mode: AutoDistillAntiGeneMode;
    tick: () => Promise<AutoDistillAntiGeneResult>;
}
/**
 * Wire the LLM-over-transcript producer for the resident daemon (#319 slice 2). Default OFF
 * (EVOLVER_AUTO_DISTILL_TRANSCRIPT unset). When on, the tick scans the session dirs and LLM-distills prose-rich,
 * weak/zero-signal sessions (per-session dedup/cooldown + per-tick cap inside runTranscriptDistillTick). Runs in
 * the idle slot only (LLM cost), separate from the every-beat structural ingest.
 */
export declare function resolveAutoDistillTranscript(env: NodeJS.ProcessEnv, opts: {
    store: assetstore.AssetStoreProvider;
    review?: assetstore.ReviewLedger;
    ingestor?: events.Ingestor;
    sessionDirs?: readonly string[];
}): AutoDistillTranscriptWiring;
export declare function resolveAutoDistillAntiGene(env: NodeJS.ProcessEnv, opts: {
    store: assetstore.AssetStoreProvider;
    review?: assetstore.ReviewLedger;
    ingestor?: events.Ingestor;
    statePath?: string;
    cwd?: string;
    now?: () => number;
    runner?: LlmDistillRunner;
}): AutoDistillAntiGeneWiring;
export declare function runIdleTranscriptDistillForBeat(beat: Pick<Beat, 'intensity'>, guarded: GuardedTranscriptDistill | null, write?: (message: string) => void): Promise<void>;
/**
 * `evolver autoexec [home]`: resident daemon. Builds the safe deps from EVOLVER_HOME, then single-flight-guards
 * autoExecPass on an interval. Real agent execution only happens for repos the operator has allowlisted in
 * <home>/autoexec/config.json (allowedRoots) — empty by default = nothing runs.
 */
export declare function runAutoExec(argv: readonly string[]): Promise<number>;