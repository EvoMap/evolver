import type { AssetRecord } from '../assetstore/provider.js';
export interface PublishKeep {
    excerpt?: boolean;
    prompt?: boolean;
}
export interface PublishLeak {
    kind: string;
    path: string;
}
export interface PreparedPublication {
    assets: AssetRecord[];
    removed: string[];
    leaks: PublishLeak[];
    blocked: boolean;
}
/**
 * What would leave this machine: local-only Gene hints and unkept Capsule text stripped, the strict publish sanitizer
 * applied, content ids recomputed and the Capsule rebound to the final Gene id. Leaks are located by field.
 */
export declare function preparePublication(gene: AssetRecord, capsule: AssetRecord | undefined, keep: PublishKeep, env: Record<string, string | undefined>): PreparedPublication;