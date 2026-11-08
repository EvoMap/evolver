export declare function assertInstallerSyncScopeActive(): void;
export type InstallerSyncResult<T> = T & (T extends PromiseLike<unknown> ? never : unknown);
/** Scope exit revokes library writes inherited by queued async work; it is not a sandbox for caller code. */
export declare function runInstallerSyncCallback<T>(callback: () => InstallerSyncResult<T>): T;
export declare function assertInstallerSyncCallback(callback: unknown): void;
export declare function installerSyncResult<T>(result: T): T;