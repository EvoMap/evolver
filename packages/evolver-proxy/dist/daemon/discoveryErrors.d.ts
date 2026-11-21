export type DiscoveryFailureCode = 'hub_timeout' | 'hub_unavailable' | 'hub_rate_limited' | 'hub_anti_abuse_blocked' | 'permission_denied' | 'invalid_response';
/** Said wherever the Proxy reports an anti-abuse block, so nobody resets a node secret that still works. */
export declare const HUB_ANTI_ABUSE_MESSAGE: string;
export interface DiscoveryFailureBody {
    error: DiscoveryFailureCode;
    code: DiscoveryFailureCode;
    retryable: boolean;
    message?: string;
    retryAfterMs?: number;
    timeoutMs?: number;
    operation?: string;
}
export interface DiscoveryFailure {
    status: number;
    body: DiscoveryFailureBody;
}
/**
 * Maps only known upstream failures from read-only discovery calls. Unknown errors
 * deliberately continue to the IPC server's existing invalid-request behavior.
 */
export declare function classifyDiscoveryUpstreamError(error: unknown): DiscoveryFailure | undefined;