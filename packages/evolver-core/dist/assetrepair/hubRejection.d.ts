import type { RepairIssue } from './repair.js';
/** Field-level issues reported by the Hub, keyed to the asset index they belong to (`-1` = bundle-level). */
export interface HubRejectionReport {
    issues: RepairIssue[];
    /** Issues for one asset of the published bundle, by its position in `payload.assets`. */
    byAssetIndex: Map<number, RepairIssue[]>;
}
export interface HubRejectionOptions {
    /** The bundle's asset types in `payload.assets` order, so a `<type>_*` rule reason routes to its own asset. */
    assetTypes?: readonly (string | undefined)[];
}
export declare function hubRejectionIssues(body: unknown, options?: HubRejectionOptions): HubRejectionReport;