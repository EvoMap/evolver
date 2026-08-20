export type CompatibilityDecision = 'compatible' | 'quarantine' | 'revalidate' | 'inconclusive' | 'unrecorded';
export type ReplayMode = 'baseline' | 'asset-enabled';
export type RunnerTrust = 'claude-cli' | 'fixture';
export type LedgerTransition = 'observation' | 'quarantine' | 'revalidate' | 'release';
export interface RequestedModelIdentity {
    id: string;
}
export interface ServedModelIdentity {
    id: string;
    source: 'claude-cli-envelope';
}
export interface AssetIdentity {
    type: string;
    id: string;
    revision: string;
}
export interface ReplayBudget {
    maxUsd: number;
    timeoutMs: number;
}
export interface ReplayTaskIdentity {
    family: string;
    inputDigest: string;
    budget: ReplayBudget;
    environmentFingerprint: string;
}
export interface CompatibilityKey extends AssetIdentity, ReplayTaskIdentity {
    requestedModelId: string;
}
export interface ValidationStepTrace {
    command: string;
    exitCode: number | null;
    passed: boolean;
    executed: boolean;
    termination: 'exit' | 'timeout' | 'cancelled' | 'not-started';
}
export interface ValidationTrace {
    schemaVersion: 1;
    isolated: boolean;
    complete: boolean;
    steps: readonly ValidationStepTrace[];
    digest: string;
}
export interface RunnerUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    costUsd: number;
}
export interface RunnerObservation {
    trust: RunnerTrust;
    mode: ReplayMode;
    ok: boolean;
    exitCode: number | null;
    termination: 'exit' | 'timeout' | 'cancelled' | 'spawn-error';
    requestedModel: RequestedModelIdentity;
    servedModel: ServedModelIdentity | null;
    sessionId: string | null;
    usage: RunnerUsage | null;
    structuredResult: unknown;
    validation: ValidationTrace;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
}
export interface ReplayCase {
    asset: AssetIdentity;
    requestedModelId: string;
    taskFamily: string;
    input: unknown;
    environment: unknown;
    budget: ReplayBudget;
    validation: readonly string[];
}
export interface ReplayExecutorInput {
    mode: ReplayMode;
    test: ReplayCase;
    attempt: number;
}
export type ReplayExecutor = (input: ReplayExecutorInput) => Promise<RunnerObservation>;
export interface ReplayEvidence {
    schemaVersion: 4;
    requestId: string;
    key: CompatibilityKey;
    baseline: RunnerObservation;
    enabled: RunnerObservation;
    observedAt: string;
    staleAfterMs: number;
}
export interface ReplayRun {
    schemaVersion: 4;
    requestId: string;
    startedAt: string;
    completedAt: string;
    evidence: readonly ReplayEvidence[];
    partial: boolean;
}
export interface LedgerEvent {
    schemaVersion: 4;
    sequence: number;
    eventId: string;
    requestId: string;
    transition: LedgerTransition;
    key: CompatibilityKey;
    at: string;
    evidence?: ReplayEvidence;
    reason?: string;
    legacyPayload?: unknown;
}
export interface ResolvedCompatibility {
    decision: CompatibilityDecision;
    key: CompatibilityKey;
    evidence?: ReplayEvidence;
    sequence?: number;
    reason: string;
}
export declare function canonicalDigest(value: unknown): string;
export declare function normalizeEnvironmentFingerprint(environment: unknown): string;
export declare function compatibilityKey(test: ReplayCase): CompatibilityKey;
export declare function compatibilityKeyString(key: CompatibilityKey): string;
export declare function validationTrace(isolated: boolean, steps: readonly ValidationStepTrace[]): ValidationTrace;
export declare function validationTracesComparable(baseline: ValidationTrace, enabled: ValidationTrace): boolean;
export declare function isStrictRunnerSuccess(observation: RunnerObservation): boolean;
export declare function evaluateEvidence(evidence: ReplayEvidence): CompatibilityDecision;
export declare function replayCorpus(corpus: readonly ReplayCase[], execute: ReplayExecutor, options?: {
    requestId?: string;
    retries?: number;
    staleAfterMs?: number;
    now?: () => number;
}): Promise<ReplayRun>;
export declare class CompatibilityLedger {
    readonly path: string;
    readonly lockPath: string;
    constructor(path: string);
    private state;
    read(): {
        events: LedgerEvent[];
        malformed: number;
        legacy: number;
    };
    private mutate;
    appendRun(run: ReplayRun): boolean;
    transition(key: CompatibilityKey, transition: Exclude<LedgerTransition, 'observation'>, requestId: string, reason: string, now?: number): boolean;
    resolve(key: CompatibilityKey, now?: number): ResolvedCompatibility;
}
export interface CompatibilityCandidateIdentity {
    assetType: string;
    assetId: string;
    revision: string;
}
export interface CompatibilityCandidate<T> {
    candidate: T;
    identity: CompatibilityCandidateIdentity;
}
export interface CompatibilityEvidenceIndex {
    decisionFor(identity: CompatibilityCandidateIdentity): ResolvedCompatibility;
}
export declare function makeCompatibilityEvidenceIndex(ledger: CompatibilityLedger, context: Omit<ReplayCase, 'asset' | 'validation'>, now?: () => number): CompatibilityEvidenceIndex;
export declare function checkAssetApplicability(identity: CompatibilityCandidateIdentity, evidence?: CompatibilityEvidenceIndex): {
    selectable: boolean;
    decision: CompatibilityDecision;
    reason: string;
};
export declare function isCompatibilityBlocked(identity: CompatibilityCandidateIdentity, evidence?: CompatibilityEvidenceIndex): boolean;