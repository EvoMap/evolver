import { type algo, type hub } from '@evomap/evolver-core';
import { type FetchLike } from './hubFetch.js';
export declare const DEFAULT_MAX_OFFLINE_SOLIDIFIES = 10;
export declare const DEFAULT_MAX_OFFLINE_DURATION_MS: number;
export declare const DEFAULT_MAX_CLOCK_DRIFT_MS: number;
export interface OfflinePermitToken {
    usedCount?: number;
    maxOfflineSolidifies?: number;
    expiresAt?: number;
    [key: string]: unknown;
}
export type OfflinePermitFailure = 'no_offline_token' | 'clock_drift_detected' | 'offline_token_expired' | 'offline_duration_exceeded' | 'offline_quota_exhausted' | 'offline_permit_busy' | 'offline_lock_failed';
export type OfflinePermitResult = {
    ok: true;
    offline: true;
    remaining: number;
} | {
    ok: false;
    offline: true;
    error: OfflinePermitFailure;
    detail?: string;
};
export interface OfflinePermitStoreOptions {
    dir: string;
    nodeSecret: string | (() => string | null | undefined) | null | undefined;
    now?: () => number;
    maxOfflineSolidifies?: number;
    maxOfflineDurationMs?: number;
    maxClockDriftMs?: number;
    lock?: OfflinePermitLockOptions;
}
export interface OfflinePermitLockOptions {
    maxTries?: number;
    waitMs?: number;
}
export interface SolidifyPermitCheckOptions {
    hubUrl: string;
    auth: hub.AuthProvider;
    senderId: () => string | undefined;
    dir: string;
    nodeSecret?: string | (() => string | null | undefined) | null | undefined;
    fetchFn?: FetchLike;
    now?: () => number;
    store?: OfflinePermitStore;
}
/**
 * HMAC-backed local offline permit counter.
 *
 * This ports v1 PR #157's concurrency fix into v2: the full
 * load -> cap-check -> increment -> write pipeline is serialized with the
 * shared PID-liveness file lock, so daemon and CLI processes cannot both
 * consume the same local offline quota slot.
 */
export declare class OfflinePermitStore {
    private readonly opts;
    private readonly now;
    private readonly maxOfflineSolidifies;
    private readonly maxOfflineDurationMs;
    private readonly maxClockDriftMs;
    constructor(opts: OfflinePermitStoreOptions);
    offlineTokenPath(): string;
    lastVerifyPath(): string;
    lockPath(): string;
    cacheOfflineToken(token: OfflinePermitToken): boolean;
    loadOfflineToken(): OfflinePermitToken | null;
    recordLastOnlineVerify(ts?: number): boolean;
    getLastOnlineVerifyTs(): number;
    consumeOfflinePermit(): OfflinePermitResult;
    private consumeLocked;
    private nodeSecret;
    private errorDetail;
}
export declare function createSolidifyPermitCheck(opts: SolidifyPermitCheckOptions): algo.SolidifyPermitGate;
export declare function hmacSha256(key: string, data: string): string;