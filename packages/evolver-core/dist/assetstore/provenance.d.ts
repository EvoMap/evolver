import { type AssetStoreProvider, type AssetRecord, type PutResult } from './provider.js';
export type ProvenanceSource = 'local' | 'migrated' | 'hub';
export type ProvenanceDecision = 'promoted' | 'revoked';
export interface ProvenanceRecord {
    assetId: string;
    source: ProvenanceSource;
    trusted: boolean;
    at: string;
    decision?: ProvenanceDecision;
    decidedBy?: string;
    /** Legacy promotion actor field kept for existing sidecar readers. */
    promotedBy?: string;
    reason?: string;
}
export interface ProvenanceTrustChange {
    changed: boolean;
    record: ProvenanceRecord;
}
/**
 * Append-only JSONL sidecar (last-write-wins) at <baseDir>/provenance.jsonl. Default for an asset with NO
 * record = trusted: the only local writers (cycleEngine self-produce, v1 migration) are trusted and never
 * write here; the sole untrusted source — hub ingestion — ALWAYS marks via {@link ingestUntrusted}/mark.
 */
export declare class ProvenanceStore {
    private readonly now;
    private readonly path;
    private readonly lockPath;
    private readonly index;
    private fileState;
    constructor(baseDir: string, now?: () => number);
    private rebuildIndex;
    private refreshUnderLock;
    private withFreshRead;
    private appendUnderLock;
    /** Record provenance for an asset_id (append-only; the JSONL history is the audit trail). */
    mark(rec: Omit<ProvenanceRecord, 'at'> & {
        at?: string;
    }): ProvenanceRecord;
    rollbackLast(rec: ProvenanceRecord): void;
    get(assetId: string): ProvenanceRecord | null;
    /** No record → trusted (local default); a record → its trusted flag. */
    isTrusted(assetId: string): boolean;
    /** One linearizable trust snapshot for bounded batch readers. */
    snapshot(): ReadonlyMap<string, ProvenanceRecord>;
    /** Compare and append one trust decision under the same cross-process lock. */
    changeTrust(assetId: string, trusted: boolean, by: string, reason: string): ProvenanceTrustChange;
    /** Explicit, audited untrusted→trusted promotion. Appends a new trusted record carrying who/why. */
    promote(assetId: string, by: string, reason: string): ProvenanceRecord;
    /** Explicit, audited trusted-to-untrusted revocation. A record-less asset is local by default. */
    revoke(assetId: string, by: string, reason: string): ProvenanceRecord;
}
/**
 * The sanctioned hub→local-pool landing: store the asset (store.put recomputes/normalizes the asset_id, so a
 * remote-supplied asset_id is never trusted) and mark it untrusted in the sidecar. This is the ONLY path that
 * should bring hub-fetched assets into the local pool — trust-first from the first byte (#30.1).
 */
export declare function ingestUntrusted(store: AssetStoreProvider, prov: ProvenanceStore, record: AssetRecord, source?: ProvenanceSource): Promise<PutResult>;