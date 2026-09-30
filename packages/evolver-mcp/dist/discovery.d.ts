export declare const DISCOVERY_TIMEOUT_MS = 20000;
export declare const DISCOVERY_MAX_TIMEOUT_MS = 30000;
export declare class DiscoveryError extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;
    readonly retryAfterMs?: number | undefined;
    readonly timeoutMs?: number | undefined;
    constructor(code: string, status: number, retryable: boolean, retryAfterMs?: number | undefined, timeoutMs?: number | undefined);
}
export declare function isDiscoveryPath(path: string): boolean;
export declare function isDegradedDiscovery(value: unknown): boolean;
export declare function discoveryTimeout(value: unknown): number;
export declare function discoveryHttpError(status: number, value: unknown): DiscoveryError;
export declare function discoverWithRetry(call: (signal: AbortSignal) => Promise<unknown>, timeoutMs?: number): Promise<unknown>;