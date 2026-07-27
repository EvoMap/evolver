import { AtpHubClient } from '@evomap/evolver-adapter-public';
import type { AtpListProofsOptions, AtpOrderOptions, AtpResult, AtpRole, AtpRoutingMode, AtpVerifyAction, AtpVerifyMode } from '@evomap/evolver-adapter-public';
type ParseResult<T> = {
    ok: true;
    opts: T;
} | {
    ok: false;
    error: string;
};
type LogFn = (line: string) => void;
export interface BuyOptions {
    capabilities: string[];
    budget: number;
    question: string;
    routingMode: AtpRoutingMode;
    verifyMode: AtpVerifyMode;
    noWait: boolean;
    timeoutMs: number;
    pollIntervalMs?: number;
}
export interface OrdersOptions {
    role: AtpRole;
    status: string | null;
    limit: number;
    jsonOut: boolean;
}
export interface VerifyOptions {
    orderId: string;
    action: AtpVerifyAction;
}
export interface AtpOptions {
    sub: 'enable' | 'disable' | 'status';
}
export interface AtpCliDeps {
    client?: AtpCliClient;
    env?: NodeJS.ProcessEnv;
    log?: LogFn;
    err?: LogFn;
    sleep?: (ms: number) => Promise<void>;
    consentPath?: string;
    now?: () => Date;
}
export interface AtpCliClient {
    placeOrder(opts: AtpOrderOptions): Promise<AtpResult>;
    getOrderStatus(orderId: string): Promise<AtpResult>;
    listProofs(opts: AtpListProofsOptions): Promise<AtpResult>;
    verifyDelivery(orderId: string, action: AtpVerifyAction | string): Promise<AtpResult>;
}
export interface AtpConsent {
    enabled: boolean;
    source: 'env' | 'ack' | 'default';
    ackPath: string;
}
export declare function parseBuyArgs(args: readonly string[]): ParseResult<BuyOptions>;
export declare function parseOrdersArgs(args: readonly string[]): ParseResult<OrdersOptions>;
export declare function parseVerifyArgs(args: readonly string[]): ParseResult<VerifyOptions>;
export declare function parseAtpArgs(args: readonly string[]): ParseResult<AtpOptions>;
export declare function runBuy(opts: BuyOptions, deps?: AtpCliDeps): Promise<{
    exitCode: number;
    data?: unknown;
    error?: string;
}>;
export declare function runOrders(opts: OrdersOptions, deps?: AtpCliDeps): Promise<{
    exitCode: number;
    data?: unknown;
    error?: string;
}>;
export declare function runVerify(opts: VerifyOptions, deps?: AtpCliDeps): Promise<{
    exitCode: number;
    data?: unknown;
    error?: string;
}>;
export declare function runAtp(opts: AtpOptions, deps?: AtpCliDeps): Promise<{
    exitCode: number;
    data?: unknown;
    envOverride?: 'on' | 'off';
    error?: string;
}>;
export declare function runBuyCommand(argv: readonly string[]): Promise<number>;
export declare function runOrdersCommand(argv: readonly string[]): Promise<number>;
export declare function runVerifyCommand(argv: readonly string[]): Promise<number>;
export declare function runAtpCommand(argv: readonly string[]): Promise<number>;
export declare function createAtpClientFromEnv(env?: NodeJS.ProcessEnv): AtpHubClient;
export { resolveIdentityHome as resolveAtpIdentityHome } from './identityHome.js';
export declare function resolveAtpHome(env?: NodeJS.ProcessEnv): string;
export declare function atpConsentPath(env?: NodeJS.ProcessEnv): string;
export declare function getAtpConsent(env?: NodeJS.ProcessEnv, ackPath?: string): AtpConsent;
/** Thrown when an autonomous (non-explicit) spend is attempted without recorded/enabled auto-spend consent (#177). */
export declare class AtpSpendConsentError extends Error {
    readonly source: AtpConsent['source'];
    constructor(source: AtpConsent['source']);
}
/**
 * THE single enforced consent gate every ATP spend path MUST pass through (#177). One door, two callers:
 *  - explicit (a human ran `evolver buy`) → the invocation IS the consent, allowed through.
 *  - autonomous (future auto-buy / autoexec auto-order / swarm purchase) → must have getAtpConsent().enabled,
 *    else refused. This keeps consent enforcement UPSTREAM of money movement instead of a read-only status bit
 *    each caller might forget to check (the latent money-safety hole autogame-17 flagged). Any new autonomous
 *    spending path is required to call this (NOT client.placeOrder directly) — see placeAtpOrderWithConsent.
 */
export declare function assertAtpSpendConsent(opts?: {
    explicit?: boolean;
    env?: NodeJS.ProcessEnv;
    consentPath?: string;
}): void;
/**
 * Place an ATP order through the enforced consent gate (#177) — the composition layer money movement goes
 * through so consent can't be bypassed. Manual `buy` passes explicit:true; an autonomous caller omits it and is
 * gated by recorded/env consent. Throws AtpSpendConsentError before any order is placed when refused.
 */
export declare function placeAtpOrderWithConsent(client: Pick<AtpCliClient, 'placeOrder'>, order: AtpOrderOptions, consent?: {
    explicit?: boolean;
    env?: NodeJS.ProcessEnv;
    consentPath?: string;
}): Promise<AtpResult>;
export declare function setAtpConsent(enabled: boolean, ackPath?: string, now?: () => Date): {
    enabled: boolean;
    acknowledged_at: string;
    version: 1;
};
export declare function resolveAtpSenderId(env?: NodeJS.ProcessEnv): string | undefined;
export declare function printAtpUsage(): string;