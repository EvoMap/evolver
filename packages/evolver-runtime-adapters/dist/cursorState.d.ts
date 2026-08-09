import type { NormalizedSession } from './types.js';
export type CursorStateVscdbErrorStage = 'open' | 'schema' | 'query';
export declare class CursorStateVscdbError extends Error {
    readonly stage: CursorStateVscdbErrorStage;
    constructor(stage: CursorStateVscdbErrorStage, message: string, cause?: unknown);
}
/**
 * Read Cursor chat sessions out of a `state.vscdb` sqlite database (read-only). Returns one NormalizedSession per
 * composer that has at least one real (non-meta) turn. A valid database with no sessions returns []; database open,
 * query, and incompatible-schema failures throw CursorStateVscdbError. The database is always opened read-only.
 */
export declare function parseCursorStateVscdb(dbPath: string): NormalizedSession[];
/** True for a path that looks like a Cursor globalStorage state.vscdb. */
export declare function isCursorStateVscdbPath(path: string): boolean;