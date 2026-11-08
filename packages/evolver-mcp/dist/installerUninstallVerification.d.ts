import { type SharedFileSnapshot } from './sharedFileCommit.js';
interface UninstallPostimage {
    path: string;
    snapshot: SharedFileSnapshot;
}
/** Read-only verification may recognize an exact restored user entry, not grant ownership of it. */
export declare function withUninstallPostimages<T>(images: readonly UninstallPostimage[], run: () => T): T;
export declare function matchesUninstallPostimage(path: string, raw?: string | null): boolean;
export {};