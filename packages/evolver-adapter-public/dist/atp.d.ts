import type { hub } from '@evomap/evolver-core';
import { ATP_EXECUTION_MODES, ATP_PROOF_STATUSES, ATP_ROLES, ATP_ROUTING_MODES, ATP_VERIFY_ACTIONS, ATP_VERIFY_MODES } from '@evomap/atp-sdk';
import { type FetchLike } from './hubFetch.js';
export { ATP_EXECUTION_MODES, ATP_PROOF_STATUSES, ATP_ROLES, ATP_ROUTING_MODES, ATP_VERIFY_ACTIONS, ATP_VERIFY_MODES, };
export type AtpVerifyMode = (typeof ATP_VERIFY_MODES)[number];
export type AtpVerifyAction = (typeof ATP_VERIFY_ACTIONS)[number];
export type AtpRoutingMode = (typeof ATP_ROUTING_MODES)[number];
export type AtpProofStatus = (typeof ATP_PROOF_STATUSES)[number];
export type AtpRole = (typeof ATP_ROLES)[number];
export type AtpExecutionMode = (typeof ATP_EXECUTION_MODES)[number];
export interface AtpResult<T = unknown> {
    ok: boolean;
    data?: T;
    error?: string;
    status?: number;
}
export interface AtpOrderOptions {
    capabilities: readonly string[];
    budget?: number;
    routingMode?: AtpRoutingMode | string;
    verifyMode?: AtpVerifyMode | string;
    question?: string;
    signals?: readonly string[];
    minReputation?: number;
}
export interface AtpListProofsOptions {
    nodeId?: string;
    role?: AtpRole | string;
    status?: AtpProofStatus | string;
    limit?: number;
}
export interface AtpClientOptions {
    baseUrl: string;
    auth: hub.AuthProvider;
    fetchFn: FetchLike;
    senderId: () => string | undefined;
}
export declare class AtpHubClient {
    private readonly opts;
    private readonly http;
    constructor(opts: AtpClientOptions);
    placeOrder<T = unknown>(opts: AtpOrderOptions): Promise<AtpResult<T>>;
    submitDelivery<T = unknown>(orderId: string, proofPayload?: unknown): Promise<AtpResult<T>>;
    verifyDelivery<T = unknown>(orderId: string, action?: AtpVerifyAction | string): Promise<AtpResult<T>>;
    settleOrder<T = unknown>(orderId: string): Promise<AtpResult<T>>;
    disputeOrder<T = unknown>(orderId: string, reason: string): Promise<AtpResult<T>>;
    getMerchantTier<T = unknown>(nodeId?: string): Promise<AtpResult<T>>;
    getOrderStatus<T = unknown>(orderId: string): Promise<AtpResult<T>>;
    listProofs<T = unknown>(opts?: AtpListProofsOptions): Promise<AtpResult<T>>;
    getAtpPolicy<T = unknown>(): Promise<AtpResult<T>>;
    listMyTasks<T = unknown>(limit?: number, nodeId?: string): Promise<AtpResult<T>>;
    private callResult;
}
export declare function normalizeAtpResult<T = unknown>(raw: unknown): AtpResult<T>;