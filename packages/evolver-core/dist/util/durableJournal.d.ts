import { type SqliteDatabase } from './sqlite.js';
export declare function stableJson(value: unknown): string;
export declare const journalDigest: (value: unknown) => string;
export declare const bytesDigest: (value: string | Buffer) => string;
export declare function journalFileIdentity(path: string): string;
export declare function journalParentIdentity(path: string): string;
export declare function sqliteTransaction<T>(db: SqliteDatabase, run: () => T): T;
export declare const journalWitnessPath: (path: string) => string;
export interface DurableJournalOptions {
    existingOnly?: boolean;
}
export declare const journalInitializationPending: (path: string) => boolean;
/** Existing-only opens, a witnessed physical namespace, FULL durability and retained native cleanup.
 * The caller owns its filesystem lock; no operation data may precede namespace readiness. */
export declare function withDurableJournal<T>(path: string, kind: string, write: boolean, run: (db: SqliteDatabase) => T, options?: DurableJournalOptions): T | undefined;
/** One lock-owned asynchronous session. No SQLite transaction is held across an await. */
export declare function withDurableJournalAsync<T>(path: string, kind: string, write: boolean, run: (db: SqliteDatabase, check: () => void) => Promise<T>, options?: DurableJournalOptions): Promise<T | undefined>;