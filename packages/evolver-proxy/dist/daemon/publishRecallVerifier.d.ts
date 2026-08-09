import { assetstore, mailbox } from '@evomap/evolver-core';
export type PublishRecallOutcomeKind = 'ok' | 'missing' | 'mismatch' | 'error' | 'skipped';
export type PublishRecallSkipReason = 'feature_disabled' | 'sampled_out' | 'fetch_unavailable' | 'missing_asset_id' | 'invalid_asset_id' | 'already_queued' | 'queue_full';
export interface PublishRecallConfig {
    enabled: boolean;
    sampleRate: number;
    queueMax: number;
    outcomeMax: number;
    initialWaitMs: number;
    pollMs: number;
    fetchTimeoutMs: number;
    maxAttempts: number;
    backoffMs: readonly number[];
}
export interface PublishRecallQueueEntry {
    assetId: string;
    assetType?: assetstore.AssetKind;
    publishedAt: number;
    attempts: number;
    nextAttemptAt: number;
}
export interface PublishRecallOutcome {
    assetId: string;
    assetType?: assetstore.AssetKind;
    outcome: PublishRecallOutcomeKind;
    reason?: string;
    attempts: number;
    at: number;
    latencyMs: number;
    ageMs?: number;
    recalledAssetId?: string;
    computedAssetId?: string;
}
export interface PublishRecallState {
    version: 1;
    queue: PublishRecallQueueEntry[];
    outcomes: PublishRecallOutcome[];
    counts: Record<PublishRecallOutcomeKind, number>;
}
export interface PublishRecallStatus {
    enabled: boolean;
    fetchAvailable: boolean;
    queued: number;
    counts: Record<PublishRecallOutcomeKind, number>;
    lastOutcome: PublishRecallOutcome | null;
    persistenceHealthy: boolean;
}
export interface PublishRecallStateStore {
    getState(key: string): string | undefined;
    setState(key: string, value: string): void;
}
export interface PublishRecallTimers {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface PublishRecallVerifierPort {
    start(): void;
    stop(): void | Promise<void>;
    observeAcceptedPublish(envelope: mailbox.Envelope, result: unknown): number;
    status(): PublishRecallStatus;
}
export interface PublishRecallVerifierOptions {
    store: PublishRecallStateStore;
    fetchAssetById?: (assetId: string) => Promise<assetstore.AssetRecord | null>;
    config: PublishRecallConfig;
    now?: () => number;
    random?: () => number;
    timers?: PublishRecallTimers;
    stateKey?: string;
}
export declare function resolvePublishRecallConfig(env?: Readonly<Record<string, string | undefined>>): PublishRecallConfig;
export declare class PublishRecallVerifier implements PublishRecallVerifierPort {
    private readonly opts;
    private readonly now;
    private readonly random;
    private readonly timers;
    private readonly stateKey;
    private state;
    private timer;
    private started;
    private stopping;
    private running;
    private activeEntry;
    private persistenceHealthy;
    constructor(opts: PublishRecallVerifierOptions);
    start(): void;
    stop(): Promise<void>;
    enqueue(input: {
        assetId: string;
        assetType?: assetstore.AssetKind;
        publishedAt?: number;
    }): {
        enqueued: boolean;
        reason?: PublishRecallSkipReason;
    };
    observeAcceptedPublish(envelope: mailbox.Envelope, result: unknown): number;
    runDue(): Promise<number>;
    private processDue;
    inspect(): PublishRecallState;
    status(): PublishRecallStatus;
    private process;
    private deferFromNow;
    private fetchWithTimeout;
    private finish;
    private skip;
    private recordOutcome;
    private remove;
    private elapsed;
    private backoffForAttempt;
    private schedule;
    private clearTimer;
    private loadState;
    private persist;
}