export type DiscoveryFailureCode = 'hub_timeout' | 'hub_unavailable' | 'hub_rate_limited' | 'permission_denied' | 'invalid_response';
export interface DiscoveryFailureBody {
    error: DiscoveryFailureCode;
    code: DiscoveryFailureCode;
    retryable: boolean;
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