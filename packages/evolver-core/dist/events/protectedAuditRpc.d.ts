/** The socket is an OS-owned trust boundary, not a caller-selected fallback path. */
export declare class ProtectedAuditUnavailableError extends Error {
    readonly reason: string;
    constructor(reason: string, options?: ErrorOptions);
}
export interface ProtectedAuditRequest {
    readonly version: 1;
    readonly operationId: string;
    readonly method: string;
    readonly path: string;
    readonly payload?: unknown;
    readonly deadlineAt: number;
}
type ProtectedAuditExchangeStage = 'connect' | 'submit' | 'first_byte' | 'reply';
type ExchangeStageCompletion = (outcome: 'fulfilled' | 'rejected') => void;
/** Internal, synchronous metadata observer; never serialized into a request. */
export type ProtectedAuditExchangeObserver = (phase: ProtectedAuditExchangeStage) => ExchangeStageCompletion | undefined;
/** Set only with an administrator-owned service config naming this distinct UID. */
export declare function markProtectedAuditServiceProcess(configPath: string): void;
export declare function isProtectedAuditServiceProcess(): boolean;
/** The shipped CLI requires a separate-UID writer for every POSIX audit path. */
export declare function requireProtectedAuditServiceForProcess(): void;
/** The CLI registers a self-binary route, so clean Bun binaries need no loose JS helper. */
export declare function configureProtectedAuditRpcChildCommand(value: {
    command: string;
    args: readonly string[];
}): void;
export declare function protectedAuditClientConfigPath(): string | undefined;
/** POSIX admission is fail-closed by default. Only privileged migration fixtures and Vite-isolated tests use local history. */
export declare function protectedAuditConfigured(): boolean;
export type ProtectedAuditReadiness = {
    readonly state: 'ready';
} | {
    readonly state: 'not_required';
} | {
    readonly state: 'unavailable';
    readonly reason: string;
};
/** Read-only admission probe: stats and parses the OS-owned config and socket, never connects or writes. */
export declare function protectedAuditReadiness(): ProtectedAuditReadiness;
/**
 * A socket in a client-writable parent can be swapped after checking it.
 * Every ancestor must be non-writable by the client, and the socket must be
 * owned by the configured service UID, which differs from this process UID.
 */
export declare function protectedAuditSocketPath(): string;
/**
 * One bounded request with a stable operation ID. Transport ambiguity is never
 * reported as a non-commit and must not trigger a blind replay by the caller.
 */
export declare function protectedAuditRpc<T>(method: string, path: string, payload: unknown, options: {
    readonly deadlineAt: number;
    readonly operationId?: string;
    readonly signal?: AbortSignal;
    readonly observer?: ProtectedAuditExchangeObserver;
}): Promise<T>;
/** Internal transport only. The public wrapper owns configuration, logical
 * path and OS-principal admission; its mandatory pre-write check is retained. */
export declare function exchangeProtectedAuditFrame<T>(socketPath: string, request: ProtectedAuditRequest, verifyBeforeWrite: () => void, signal?: AbortSignal, observer?: ProtectedAuditExchangeObserver): Promise<T>;
/**
 * The public root-event and call-log readers are synchronous. A separate,
 * bounded client process performs the same authenticated socket protocol;
 * no socket callback can be starved by blocking the caller's event loop.
 */
export declare function protectedAuditRpcSync<T>(method: string, path: string, payload: unknown, options: {
    readonly deadlineAt: number;
    readonly operationId?: string;
}): T;
export declare function validateProtectedAuditRootIdentity(value: unknown): string | null;
export declare function validateProtectedAuditHistoryVersion(value: unknown): string;
/** The service resolves the logical path inside its private namespace. */
export declare function protectedAuditRootIdentitySync(path: string): string | null;
/** A stable service-owned snapshot crosses the bounded frame in verified chunks. */
export declare function protectedAuditReadSnapshotSync<T>(kind: 'root' | 'root_strict' | 'call', path: string, options?: unknown): T;
export declare function decodeSnapshotChunk(encoded: unknown, offset: number, size: number): Buffer;
/** Internal chunk protocol. Its caller retains socket/principal authentication. */
export declare function readProtectedAuditSnapshotChunks<T>(kind: 'root' | 'root_strict' | 'call', request: (method: string, payload: unknown, deadlineAt: number) => unknown, options?: unknown): T;
export declare function validateProtectedAuditSnapshotHeader(value: unknown): void;
export {};