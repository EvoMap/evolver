import { type AtpResult } from '@evomap/evolver-adapter-public';
type LogFn = (line: string) => void;
export declare const ATP_AUTODELIVER_DEFAULT_POLL_MS = 60000;
export declare const ATP_AUTODELIVER_MIN_POLL_MS = 15000;
export declare const ATP_AUTODELIVER_LEDGER_FILENAME = "atp-autodeliver-ledger.json";
export declare const ATP_AUTODELIVER_LEDGER_MAX_ENTRIES = 500;
export declare const ATP_AUTODELIVER_COOLDOWN_BASE_MS: number;
export declare const ATP_AUTODELIVER_COOLDOWN_CAP_MS: number;
export interface AtpAutoDeliverClient {
    listMyTasks(limit?: number, nodeId?: string): Promise<AtpResult>;
    submitDelivery(orderId: string, proofPayload?: unknown): Promise<AtpResult>;
}
export interface AtpAutoDeliverLedger {
    version: 2;
    /** orderId → epoch ms. positive = delivered-at; negative = terminal-failed-at. Either ⇒ skip forever. */
    submitted: Record<string, number>;
    /** orderId → epoch ms before which we must NOT retry (429 cooldown backoff). Cleared on success/terminal. */
    retryAfter: Record<string, number>;
    /** orderId → consecutive 429 count, drives the exponential backoff. Cleared on success/terminal. */
    cooldownHits: Record<string, number>;
}
export interface AtpAutoDeliverTickResult {
    checked: number;
    delivered: number;
    skippedTasks: number;
    terminalFailures: number;
    transientFailures: number;
    /** 429 rate-limit hits this tick — backed off (a subset of "failed", tracked apart for observability). */
    cooldownFailures: number;
}
export interface AtpAutoDeliverDeps {
    client?: AtpAutoDeliverClient;
    createClient?: (env: NodeJS.ProcessEnv) => AtpAutoDeliverClient;
    env?: NodeJS.ProcessEnv;
    ledgerPath?: string;
    nowMs?: () => number;
    nowDate?: () => Date;
    log?: LogFn;
    limit?: number;
}
export interface AtpAutoDeliverWiring {
    enabled: boolean;
    reason?: 'off' | 'client_error';
    tick: () => Promise<AtpAutoDeliverTickResult>;
}
export declare function isAtpAutoDeliverEnabled(env?: NodeJS.ProcessEnv): boolean;
export declare function atpAutoDeliverLedgerPath(env?: NodeJS.ProcessEnv): string;
export declare function resolveAtpAutoDeliver(env?: NodeJS.ProcessEnv, deps?: Omit<AtpAutoDeliverDeps, 'env'>): AtpAutoDeliverWiring;
export declare function runAtpAutoDeliverTick(deps?: AtpAutoDeliverDeps): Promise<AtpAutoDeliverTickResult>;
export declare function readAtpAutoDeliverLedger(path: string): AtpAutoDeliverLedger;
export declare function writeAtpAutoDeliverLedger(path: string, ledger: AtpAutoDeliverLedger): void;
export declare function buildAtpAutoDeliverProofPayload(task: Record<string, unknown>, nowDate?: () => Date): Record<string, unknown>;
export {};