export type WindowsProcessLiveness = 'alive' | 'dead' | 'unknown';
/** Fresh, read-only liveness for Windows lock ownership. `dead` is returned only
 * for STATUS_INVALID_CID with a NULL out HANDLE or a confirmed nonzero exit FILETIME. */
export declare function readWindowsProcessLiveness(pid: number): WindowsProcessLiveness;
/** Fresh process-generation metadata. Unknown and dead observations are never cached here. */
export declare function readWindowsProcessStartTimeTicks(pid: number): string | null;