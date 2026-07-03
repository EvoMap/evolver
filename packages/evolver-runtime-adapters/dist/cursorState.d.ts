import type { NormalizedSession } from './types.js';
/**
 * Read Cursor chat sessions out of a `state.vscdb` sqlite database (read-only). Returns one NormalizedSession per
 * composer that has at least one real (non-meta) turn. Never throws on a malformed/locked db — returns []. The db
 * is opened read-only, so it is safe to run against a live Cursor profile.
 */
export declare function parseCursorStateVscdb(dbPath: string): NormalizedSession[];
/** True for a path that looks like a Cursor globalStorage state.vscdb. */
export declare function isCursorStateVscdbPath(path: string): boolean;