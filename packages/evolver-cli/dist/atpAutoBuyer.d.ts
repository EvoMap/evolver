import { type AtpOrderOptions, type AtpResult } from '@evomap/evolver-adapter-public';
import type { AtpCliClient } from './atp.js';
export declare const ATP_AUTOBUY_DEFAULT_DAILY_CAP = 50;
export declare const ATP_AUTOBUY_DEFAULT_PER_ORDER_CAP = 10;
export declare const ATP_AUTOBUY_DEFAULT_TIMEOUT_MS = 3000;
export declare const ATP_AUTOBUY_COLD_START_MS: number;
export declare const ATP_AUTOBUY_SUCCESS_DEDUP_MS: number;
export declare const ATP_AUTOBUY_FAILURE_DEDUP_MS: number;
export declare const ATP_AUTOBUY_LEDGER_FILENAME = "atp-autobuyer-ledger.json";
export declare const ATP_AUTOBUY_LEDGER_MAX_BYTES: number;
export type AtpAutoBuyerClient = Pick<AtpCliClient, 'placeOrder'>;
export interface AtpAutoBuyerRequest extends AtpOrderOptions {
    kind: 'capability_gap';
    /** Public-safe signals are mandatory for this specialized request, even though generic ATP orders allow omission. */
    signals: string[];
}
export interface AtpAutoBuyerTimer {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface AtpAutoBuyerOptions {
    client: AtpAutoBuyerClient;
    ledgerPath?: string;
    lockPath?: string;
    consentPath?: string;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    timer?: AtpAutoBuyerTimer;
    reservationId?: () => string;
    dailyCap?: number;
    perOrderCap?: number;
    timeoutMs?: number;
    coldStartMs?: number;
    successDedupMs?: number;
    failureDedupMs?: number;
    transportSettleMs?: number;
    lockMaxTries?: number;
    lockWaitMs?: number;
}
export type AtpAutoBuyerReason = 'not_capability_gap' | 'no_capabilities' | 'consent_disabled' | 'dedup_hit' | 'daily_cap_reached' | 'budget_clamped_to_zero' | 'ledger_corrupt' | 'ledger_busy' | 'ledger_unavailable' | 'order_timeout' | 'order_ambiguous';
export interface AtpAutoBuyerResult {
    ok: boolean;
    skipped: boolean;
    reason?: AtpAutoBuyerReason;
    data?: unknown;
    error?: string;
    status?: number;
    hash?: string;
    reservationId?: string;
    spent?: number;
    reserved?: number;
    cap?: number;
}
export interface AtpAutoBuyerDedupEntry {
    ts: number;
    state: 'success' | 'failure' | 'reserved';
    reservationId?: string;
}
export interface AtpAutoBuyerReservation {
    id: string;
    hash: string;
    budget: number;
    dayKey: string;
    createdAt: number;
    updatedAt: number;
    /** Earliest time an operator may reconcile a pending reservation left by a crashed process. */
    resolveAfter?: number;
    state: 'pending' | 'ambiguous';
    error?: string;
}
export interface AtpAutoBuyerResolution {
    reservationId: string;
    hash: string;
    budget: number;
    outcome: 'success' | 'failure';
    resolvedAt: number;
    source: 'operator' | 'late_result';
}
export interface AtpAutoBuyerLedger {
    version: 2;
    dayKey: string;
    spent: number;
    dedup: Record<string, AtpAutoBuyerDedupEntry>;
    reservations: Record<string, AtpAutoBuyerReservation>;
    resolutions: AtpAutoBuyerResolution[];
}
export declare class AtpAutoBuyerLedgerError extends Error {
    readonly code: 'CORRUPT_LEDGER' | 'LEDGER_UNAVAILABLE';
    constructor(message: string, code: 'CORRUPT_LEDGER' | 'LEDGER_UNAVAILABLE', options?: ErrorOptions);
}
export declare function readAtpAutoBuyerLedger(path: string): AtpAutoBuyerLedger;
export declare function resolveAtpAutoBuyerLedgerPath(env?: NodeJS.ProcessEnv, consentPath?: string): string;
export declare function hashAtpCapabilityGap(request: Pick<AtpAutoBuyerRequest, 'capabilities' | 'question'>): string;
export declare class AtpAutoBuyer {
    readonly ledgerPath: string;
    readonly lockPath: string;
    private readonly client;
    private readonly consentPath;
    private readonly env;
    private readonly now;
    private readonly timer;
    private readonly reservationId;
    private readonly config;
    private queue;
    private startedAt;
    constructor(options: AtpAutoBuyerOptions);
    consider(request: AtpAutoBuyerRequest): Promise<AtpAutoBuyerResult>;
    reconcileReservation(reservationId: string, result: AtpResult): boolean;
    resolveReservation(reservationId: string, outcome: 'success' | 'failure'): boolean;
    private considerSerialized;
    private reserve;
    private awaitOrder;
    private reconcileLate;
    private markAmbiguous;
    private releaseReservation;
    private pendingResolveAfter;
    private loadLedger;
    private withLedgerLock;
    private ledgerFailure;
}