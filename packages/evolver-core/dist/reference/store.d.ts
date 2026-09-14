import { type ReferencePair, type ReferencePage, type ReferenceQuery } from './decoder.js';
import type { ReferenceScope } from './guard.js';
interface Entry extends ReferencePair {
    origin: 'file' | 'hub' | 'inbound';
    source_node_id?: string;
    stored_at: string;
}
export interface ReferenceImportReceipt {
    status: 'stored_reference';
    stored: number;
    duplicates: number;
    asset_ids: string[];
    executable: false;
}
export declare function readReferenceFile(file: string): unknown;
/** Separate from genes/capsules/events. One atomic snapshot makes a batch all-or-nothing. */
export declare class ReferenceStore {
    readonly baseDir: string;
    constructor(baseDir: string);
    private locked;
    private load;
    import(value: unknown, origin?: Entry['origin'], sourceNodeId?: string): ReferenceImportReceipt;
    /** Per-instance snapshot cache, replaced (not accumulated) on file change/deletion. */
    private fenceFingerprint;
    private fenceIds;
    readonly scope: ReferenceScope;
    hasId(id: string): boolean;
    search(input?: ReferenceQuery): ReferencePage;
    context(query?: ReferenceQuery, maxChars?: number): {
        status: 'reference_context';
        context: string;
        count: number;
        truncated: boolean;
        executable: false;
    };
}
/** No global registry: callers own this fence and pass it to their execution boundary. */
export declare function loadReferenceFence(assetsDir: string): ReferenceScope;
export declare function referenceScopeForEventsPath(path: string): ReferenceScope;
export {};